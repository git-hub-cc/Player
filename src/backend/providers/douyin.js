// src/backend/providers/douyin.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import pLimit from 'p-limit';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

// --- 配置 ---
const CONCURRENT_LIMIT = 16; // 并发下载数
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB 分块大小

/**
 * @class DouyinProvider
 * @description 抖音视频下载服务提供者。
 * @extends BaseProvider
 */
export class DouyinProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否能处理给定的 URL。
     * @param {string} url - 用户输入的 URL。
     * @returns {boolean} - 如果是抖音相关链接则返回 true。
     */
    isApplicable(url) {
        return url.includes('douyin.com') || url.includes('iesdouyin.com');
    }

    /**
     * 执行抖音视频的下载和处理流程。
     * @param {string} videoUrl - 抖音视频或用户主页的 URL。
     * @returns {Promise<void>}
     */
    async execute(videoUrl) {
        this.sendMessage('download-status', { message: '正在启动无头浏览器以解析抖音链接...' });

        // 1. 定义一个唯一的会话分区名称，确保网络设置隔离
        const partitionName = `persist:douyin_session_${Date.now()}`;

        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                // 2. 使用该分区名称来隔离会话
                partition: partitionName,
                // 注入 preload 脚本以绕过自动化检测
                preload: path.join(__dirname, '..', 'preload', 'douyin-preload.js'),
                contextIsolation: true,
                sandbox: true
            }
        });
        win.webContents.setAudioMuted(true);

        try {
            // 获取专属于此窗口的会话对象
            const douyinSession = session.fromPartition(partitionName);
            // 设置代理规则为 'direct://'，强制绕过所有系统代理
            await douyinSession.setProxy({ proxyRules: 'direct://' });
            console.log('[Douyin Provider] 抖音下载会话已强制设置为直连模式。');
        } catch (proxyError) {
            console.error('[Douyin Provider] 设置直连代理失败:', proxyError);
            if (win && !win.isDestroyed()) win.close();
            throw new Error(`网络配置失败: ${proxyError.message}`);
        }

        try {
            // 创建一个 Promise 来等待 API 响应，并设置超时
            const apiResponsePromise = this._interceptApiResponse(win);

            let urlToLoad = this._normalizeUrl(videoUrl);

            // 加载目标 URL，并伪装成普通浏览器
            await win.loadURL(urlToLoad, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
            this.sendMessage('download-status', { message: '正在导航页面，等待 API 响应...' });

            // 等待 API 响应的 Promise 完成
            const apiResponseJson = await apiResponsePromise;
            if (!apiResponseJson?.aweme_detail) {
                throw new Error('未能拦截到有效的作品详情 API 响应。');
            }

            // 关闭窗口，释放资源
            if (win && !win.isDestroyed()) {
                if (win.webContents.debugger.isAttached()) {
                    await win.webContents.debugger.detach();
                }
                win.close();
            }

            // 调用并发下载函数
            await this._processAndDownloadItem(apiResponseJson.aweme_detail);
            this.sendMessage('download-status', { message: '视频下载完成！', type: 'success' });

        } catch (error) {
            // 确保在出错时也抛出异常，以便上层捕获
            throw new Error(`抖音解析失败: ${error.message}`);
        } finally {
            // 确保浏览器窗口在完成后总是被关闭
            if (win && !win.isDestroyed()) {
                if (win.webContents.debugger.isAttached()) {
                    await win.webContents.debugger.detach();
                }
                win.close();
            }
        }
    }

    /**
     * @private
     * 拦截抖音页面加载时发出的作品详情API请求。
     * @param {BrowserWindow} win - 用于加载页面的无头浏览器窗口。
     * @returns {Promise<object>} - 解析后的 API 响应 JSON 对象。
     */
    _interceptApiResponse(win) {
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('API 响应超时 (60秒)')), 60000);
            let debuggerAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (debuggerAttached || win.isDestroyed()) return;
                debuggerAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');

                    this.sendMessage('download-status', { message: '页面已加载，正在监听网络数据...' });

                    debuggerApi.on('message', async (event, method, params) => {
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const { body } = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                clearTimeout(timeout);
                                resolve(JSON.parse(body));
                            } catch (err) {
                                if (!err.message.includes('No resource with given identifier found')) {
                                    reject(err);
                                }
                            }
                        }
                    });
                } catch (attachError) {
                    reject(new Error(`附加调试器失败: ${attachError.message}`));
                }
            });
        });
    }

    /**
     * @private
     * 规范化抖音链接，尝试将长链接转为标准视频页链接。
     * @param {string} originalUrl - 原始 URL。
     * @returns {string} - 处理后的 URL。
     */
    _normalizeUrl(originalUrl) {
        let urlToLoad = originalUrl;
        if (urlToLoad.includes('v.douyin.com')) {
            return urlToLoad; // 短链直接加载
        }

        try {
            const url = new URL(urlToLoad);
            let numericId = url.searchParams.get('modal_id'); // 检查 modal_id
            if (!numericId) {
                const pathMatch = url.pathname.match(/\/(?:video|note)\/(\d+)/); // 检查路径
                if (pathMatch && pathMatch[1]) {
                    numericId = pathMatch[1];
                }
            }
            if (numericId) {
                urlToLoad = `https://www.douyin.com/video/${numericId}/`;
                this.sendMessage('download-status', { message: `已将链接规范化: ${urlToLoad}` });
            }
        } catch (parseError) {
            console.warn(`[Douyin Provider] URL '${urlToLoad}' 解析失败，将使用原始链接。错误: ${parseError.message}`);
        }
        return urlToLoad;
    }

    /**
     * @private
     * 处理单个抖音作品的并发下载和数据更新。
     * @param {object} awemeDetail - 从抖音 API 获取的作品详情对象。
     */
    async _processAndDownloadItem(awemeDetail) {
        const awemeId = awemeDetail?.aweme_id;
        if (!awemeId) {
            console.warn('[Douyin Provider] 传入的作品详情无效，缺少 aweme_id。');
            return;
        }

        try {
            const videoUri = awemeDetail?.video?.play_addr?.uri;
            const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];

            if (!videoUri) throw new Error("未找到视频播放地址。");

            const videoUrl = `https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`;

            this.sendMessage('download-status', { message: '正在获取视频信息...', type: 'default' });
            const headResponse = await axios.head(videoUrl);
            const totalSize = parseInt(headResponse.headers['content-length'], 10);
            if (isNaN(totalSize) || totalSize <= 0) {
                throw new Error('无法获取视频文件大小，可能链接已失效。');
            }

            const title = awemeDetail.desc || "无标题视频";
            const finalFilePath = path.join(this.config.VIDEOS_DIR, `${awemeId}.mp4`);
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
                    const progress = downloadedBytes / totalSize;
                    this.sendMessage('download-status', {
                        message: `下载中: ${(progress * 100).toFixed(1)}%`,
                        progress: progress,
                        type: 'progress'
                    });
                }));
            }

            if (coverUrl) {
                tasks.push(limit(() => downloadFile(coverUrl, this.config.ALBUMART_DIR, `${awemeId}.jpg`)));
            }

            await Promise.all(tasks);

            this.sendMessage('download-status', { message: '下载完成，正在合并文件...', type: 'default' });
            await this._mergeChunks(chunkPaths, finalFilePath);

            fs.rmSync(tempDir, { recursive: true, force: true });

            await this._addTrackToPlaylist({
                title,
                artist: awemeDetail.author?.nickname || "未知作者",
                src: `videos/${awemeId}.mp4`,
                albumArt: `albumArt/${awemeId}.jpg`,
                type: "video"
            });

        } catch (e) {
            throw new Error(`下载抖音作品 ${awemeId} 失败: ${e.message}`);
        }
    }

    /**
     * @private
     * 下载单个数据块。
     */
    async _downloadChunk(url, range, tempPath) {
        const headers = { 'Range': `bytes=${range.start}-${range.end}` };
        const response = await axios({ url, method: 'GET', responseType: 'stream', headers });
        response.data.pipe(fs.createWriteStream(tempPath));
        return new Promise((resolve, reject) => {
            let size = 0;
            response.data.on('data', chunk => size += chunk.length);
            response.data.on('end', () => resolve(size));
            response.data.on('error', reject);
        });
    }

    /**
     * @private
     * 合并所有数据块到一个文件。
     */
    async _mergeChunks(chunkPaths, outputPath) {
        const writeStream = fs.createWriteStream(outputPath);
        for (const chunkPath of chunkPaths) {
            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(chunkPath);
                readStream.pipe(writeStream, { end: false });
                readStream.on('end', resolve);
                readStream.on('error', reject);
            });
        }
        writeStream.end();
    }
}