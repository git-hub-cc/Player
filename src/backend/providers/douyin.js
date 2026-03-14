// src/backend/providers/douyin.js

import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import pLimit from 'p-limit';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

const CONCURRENT_LIMIT = 16;
const CHUNK_SIZE = 5 * 1024 * 1024;
const directAgent = new https.Agent({ keepAlive: true });

export class DouyinProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('douyin.com') || url.includes('iesdouyin.com');
    }

    async execute(videoUrl, signal) {
        this._checkCancelled(signal);
        this.sendMessage('download-status', { message: 'Initializing environment (Forced Direct Mode)...' });

        const partitionName = `persist:douyin_session_${Date.now()}`;
        const douyinSession = session.fromPartition(partitionName);
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

        // 如果在启动浏览器期间取消，销毁窗口
        if (signal) {
            signal.addEventListener('abort', () => {
                if (!win.isDestroyed()) win.close();
            });
        }

        const preventExternalProtocols = (event, url) => {
            if (url === win.webContents.getURL()) return;
            const lowerUrl = url.toLowerCase();
            const isSafeProtocol = lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://') || lowerUrl.startsWith('devtools://');
            if (!isSafeProtocol) event.preventDefault();
        };
        win.webContents.on('will-navigate', preventExternalProtocols);
        win.webContents.on('will-redirect', preventExternalProtocols);
        win.webContents.on('will-frame-navigate', preventExternalProtocols);

        try {
            const apiResponsePromise = this._interceptApiResponse(win, signal);
            let urlToLoad = this._normalizeUrl(videoUrl);

            this._checkCancelled(signal);
            await win.loadURL(urlToLoad, {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            });

            this.sendMessage('download-status', { message: 'Navigating page, waiting for detail API...' });

            const apiResponseJson = await apiResponsePromise;
            this._checkCancelled(signal);

            if (!apiResponseJson?.aweme_detail) {
                throw new Error('Intercepted API response format is incorrect');
            }

            await this._processAndDownloadItem(apiResponseJson.aweme_detail, signal);
            this.sendMessage('download-status', { message: 'Video download complete!', type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            throw new Error(`Douyin analysis failed: ${error.message}`);
        } finally {
            if (win && !win.isDestroyed()) {
                if (win.webContents.debugger.isAttached()) {
                    try { await win.webContents.debugger.detach(); } catch(e) {}
                }
                win.close();
            }
        }
    }

    _interceptApiResponse(win, signal) {
        return new Promise(async (resolve, reject) => {
            // 如果已经被取消
            if (signal && signal.aborted) return reject(new Error('Download aborted by user'));

            const timeout = setTimeout(() => reject(new Error('Parsing timeout, please check connection')), 60000);

            // 监听取消信号
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    reject(new Error('Download aborted by user'));
                });
            }

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
                    reject(new Error(`Failed to start analysis engine: ${attachError.message}`));
                }
            });
        });
    }

    _normalizeUrl(originalUrl) {
        let urlToLoad = originalUrl;
        if (urlToLoad.includes('v.douyin.com')) return urlToLoad;
        let numericId = null;
        try {
            const urlObj = new URL(urlToLoad);
            numericId = urlObj.searchParams.get('modal_id');
        } catch (e) {}
        if (!numericId) {
            const pathMatch = urlToLoad.match(/\/(?:video|note)\/(\d+)/);
            if (pathMatch) numericId = pathMatch[1];
        }
        if (numericId) {
            urlToLoad = `https://www.douyin.com/video/${numericId}/`;
        } else {
            throw new Error('Invalid Douyin link. Could not extract video ID.');
        }
        return urlToLoad;
    }

    async _processAndDownloadItem(awemeDetail, signal) {
        const awemeId = awemeDetail?.aweme_id;
        const videoUrl = awemeDetail?.video?.play_addr?.url_list?.[0]?.replace(/^http:\/\//, 'https://');
        if (!videoUrl) throw new Error("Could not get video download URL from API");

        try {
            this.sendMessage('download-status', { message: 'Probing resource (Axios Direct Mode)...' });

            const headResponse = await axios.head(videoUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyin.com/' },
                proxy: false,
                httpsAgent: directAgent,
                timeout: 10000,
                signal: signal // 传递 signal
            });

            const totalSize = parseInt(headResponse.headers['content-length'], 10);
            if (!totalSize) throw new Error('Resource locked or link expired');

            const title = awemeDetail.desc || "No Title";
            const uniqueFilenameBase = await this.libraryService.getNextOrdinal();
            const finalFilePath = path.join(this.config.VIDEOS_DIR, `${uniqueFilenameBase}.mp4`);

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
                    this._checkCancelled(signal);
                    // 传递 signal 给分片下载
                    const chunkSize = await this._downloadChunk(videoUrl, { start, end }, chunkPath, signal);
                    downloadedBytes += chunkSize;
                    this.sendMessage('download-status', {
                        message: `Downloading: ${((downloadedBytes / totalSize) * 100).toFixed(1)}%`,
                        progress: downloadedBytes / totalSize,
                        type: 'progress'
                    });
                }));
            }

            const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];
            if (coverUrl) {
                tasks.push(limit(() => downloadFile(coverUrl, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, {}, () => {}, 3, signal)));
            }

            // 等待所有任务完成，如果有任一任务因 signal 失败，这里会 reject
            await Promise.all(tasks);

            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: 'Merging data chunks...', type: 'default' });
            await this._mergeChunks(chunkPaths, finalFilePath);
            fs.rmSync(tempDir, { recursive: true, force: true });

            await this._addTrackToPlaylist({
                title,
                artist: awemeDetail.author?.nickname || "未知",
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`)) ? `albumArt/${uniqueFilenameBase}.jpg` : '',
                type: "video"
            });

        } catch (e) {
            if (signal && signal.aborted) throw e;
            throw new Error(`Failed to fetch resource: ${e.message}`);
        }
    }

    async _downloadChunk(url, range, tempPath, signal) {
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
            },
            signal: signal // 传递 signal
        });

        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            let size = 0;
            response.data.on('data', chunk => size += chunk.length);
            response.data.on('end', () => resolve(size));
            response.data.on('error', reject);
            writer.on('error', reject);
            // 监听 signal，销毁流
            if (signal) {
                signal.addEventListener('abort', () => {
                    writer.destroy();
                    reject(new Error('Download aborted by user'));
                });
            }
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