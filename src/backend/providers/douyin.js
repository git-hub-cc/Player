// src/backend/providers/douyin.js

import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import pLimit from 'p-limit';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

// --- 配置 ---
const CONCURRENT_LIMIT = 16;
const CHUNK_SIZE = 5 * 1024 * 1024;

// 创建一个显式的直连 Agent，防止 Node.js 环境变量干扰
const directAgent = new https.Agent({ keepAlive: true });

export class DouyinProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('douyin.com') || url.includes('iesdouyin.com');
    }

    async execute(videoUrl) {
        this.sendMessage('download-status', { message: '正在初始化环境 (强制直连模式)...' });

        const partitionName = `persist:douyin_session_${Date.now()}`;
        const douyinSession = session.fromPartition(partitionName);

        // 1. 核心修复：强制该会话的所有流量（包括重定向）不经过任何代理
        await douyinSession.setProxy({ proxyRules: 'direct://' });

        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                partition: partitionName,
                preload: path.join(__dirname, '..', 'preload', 'douyin-preload.js'),
                contextIsolation: true,
                sandbox: true
            }
        });
        win.webContents.setAudioMuted(true);

        try {
            const apiResponsePromise = this._interceptApiResponse(win);
            let urlToLoad = this._normalizeUrl(videoUrl);

            await win.loadURL(urlToLoad, {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            });

            this.sendMessage('download-status', { message: '正在导航页面，等待解析 API...' });

            const apiResponseJson = await apiResponsePromise;
            if (!apiResponseJson?.aweme_detail) {
                throw new Error('拦截到的 API 响应格式不正确');
            }

            await this._processAndDownloadItem(apiResponseJson.aweme_detail);
            this.sendMessage('download-status', { message: '视频下载完成！', type: 'success' });

        } catch (error) {
            throw new Error(`抖音解析失败: ${error.message}`);
        } finally {
            if (win && !win.isDestroyed()) {
                if (win.webContents.debugger.isAttached()) {
                    try { await win.webContents.debugger.detach(); } catch(e) {}
                }
                win.close();
            }
        }
    }

    _interceptApiResponse(win) {
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('解析超时，请检查网络连接')), 60000);
            let debuggerAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (debuggerAttached || win.isDestroyed()) return;
                debuggerAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');

                    debuggerApi.on('message', async (event, method, params) => {
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const { body } = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                clearTimeout(timeout);
                                resolve(JSON.parse(body));
                            } catch (err) {
                                if (!err.message.includes('No resource with given identifier')) reject(err);
                            }
                        }
                    });
                } catch (attachError) {
                    reject(new Error(`无法启动解析引擎: ${attachError.message}`));
                }
            });
        });
    }

    _normalizeUrl(originalUrl) {
        let urlToLoad = originalUrl;
        if (urlToLoad.includes('v.douyin.com')) return urlToLoad;

        try {
            const url = new URL(urlToLoad);
            let numericId = url.searchParams.get('modal_id');
            if (!numericId) {
                const pathMatch = url.pathname.match(/\/(?:video|note)\/(\d+)/);
                if (pathMatch) numericId = pathMatch[1];
            }
            if (numericId) urlToLoad = `https://www.douyin.com/video/${numericId}/`;
        } catch (e) {}
        return urlToLoad;
    }

    async _processAndDownloadItem(awemeDetail) {
        const awemeId = awemeDetail?.aweme_id;
        const videoUrl = awemeDetail?.video?.play_addr?.url_list?.[0]?.replace(/^http:\/\//, 'https://');

        if (!videoUrl) throw new Error("无法从 API 获取视频下载地址");

        try {
            this.sendMessage('download-status', { message: '正在探测资源 (Axios 直连模式)...' });

            // 2. 核心修复：Axios 请求必须显式禁用代理并使用直连 Agent
            const headResponse = await axios.head(videoUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' },
                proxy: false,
                httpsAgent: directAgent,
                timeout: 10000
            });

            const totalSize = parseInt(headResponse.headers['content-length'], 10);
            if (!totalSize) throw new Error('资源已被锁定或链接失效');

            const title = awemeDetail.desc || "无标题";
            const safeFilename = this._sanitizeFilename(`${awemeDetail.author?.nickname || '未知'} - ${title}`);
            const finalFilePath = path.join(this.config.VIDEOS_DIR, `${safeFilename}.mp4`);

            const tempDir = path.join(this.config.MEDIA_ROOT, `temp_${awemeId}`);
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            const numChunks = Math.ceil(totalSize / CHUNK_SIZE);
            const chunkPaths = [];
            const tasks = [];
            let downloadedBytes = 0;
            const limit = pLimit(CONCURRENT_LIMIT);

            for (let i = 0; i < numChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
                const chunkPath = path.join(tempDir, `${i}.tmp`);
                chunkPaths.push(chunkPath);

                tasks.push(limit(async () => {
                    const chunkSize = await this._downloadChunk(videoUrl, { start, end }, chunkPath);
                    downloadedBytes += chunkSize;
                    this.sendMessage('download-status', {
                        message: `下载中: ${((downloadedBytes / totalSize) * 100).toFixed(1)}%`,
                        progress: downloadedBytes / totalSize,
                        type: 'progress'
                    });
                }));
            }

            const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];
            if (coverUrl) {
                tasks.push(limit(() => downloadFile(coverUrl, this.config.ALBUMART_DIR, `${safeFilename}.jpg`)));
            }

            await Promise.all(tasks);

            this.sendMessage('download-status', { message: '合并数据分片...', type: 'default' });
            await this._mergeChunks(chunkPaths, finalFilePath);
            fs.rmSync(tempDir, { recursive: true, force: true });

            await this._addTrackToPlaylist({
                title,
                artist: awemeDetail.author?.nickname || "未知",
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : '',
                type: "video"
            });

        } catch (e) {
            throw new Error(`资源获取失败: ${e.message}`);
        }
    }

    async _downloadChunk(url, range, tempPath) {
        // 3. 核心修复：数据分块下载同样必须强制禁用代理
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            proxy: false,
            httpsAgent: directAgent,
            headers: {
                'Range': `bytes=${range.start}-${range.end}`,
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://www.douyin.com/'
            }
        });

        response.data.pipe(fs.createWriteStream(tempPath));
        return new Promise((resolve, reject) => {
            let size = 0;
            response.data.on('data', chunk => size += chunk.length);
            response.data.on('end', () => resolve(size));
            response.data.on('error', reject);
        });
    }

    async _mergeChunks(chunkPaths, outputPath) {
        const writeStream = fs.createWriteStream(outputPath);
        for (const chunkPath of chunkPaths) {
            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(chunkPath);
                readStream.pipe(writeStream, { end: false });
                readStream.on('end', () => fs.unlink(chunkPath, () => resolve()));
                readStream.on('error', reject);
            });
        }
        writeStream.end();
        return new Promise((resolve) => writeStream.on('finish', resolve));
    }
}