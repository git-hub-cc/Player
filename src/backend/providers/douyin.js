// src/backend/providers/douyin.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import pLimit from 'p-limit';
import { BrowserWindow, session } from 'electron';
import { pinyin } from 'pinyin-pro';
import { updateLocalPlaylist } from '../services/library-service.js';
import { downloadFile } from '../services/download-service.js';

// --- 模块作用域变量 ---
let CONFIG = {};
let sendMessageCallback = () => {};

// --- 配置 ---
const CONCURRENT_LIMIT = 16; // 并发下载数
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB 分块大小

/**
 * 初始化抖音下载服务提供者。
 * @param {object} initParams - 初始化参数对象。
 * @param {object} initParams.config - 应用配置对象。
 * @param {function} initParams.sendMessageFunc - 发送消息到渲染进程的函数。
 */
export function init(initParams) {
    CONFIG = initParams.config;
    sendMessageCallback = initParams.sendMessageFunc;
    console.log('[Douyin Provider] 服务已初始化。');
}

/**
 * 下载单个数据块。
 * @param {string} url - 视频 URL。
 * @param {{start: number, end: number}} range - 字节范围。
 * @param {string} tempPath - 临时保存路径。
 * @returns {Promise<number>} - 返回下载的字节数。
 */
async function downloadChunk(url, range, tempPath) {
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
 * 合并所有数据块到一个文件。
 * @param {string[]} chunkPaths - 所有临时块文件的路径数组。
 * @param {string} outputPath - 最终输出文件路径。
 * @returns {Promise<void>}
 */
async function mergeChunks(chunkPaths, outputPath) {
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

/**
 * 【核心重构】处理单个抖音作品的并发下载和数据更新。
 * @param {object} awemeDetail - 从抖音 API 获取的作品详情对象。
 */
async function processAndDownloadItem(awemeDetail) {
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

        // 1. 获取视频信息（大小）
        sendMessageCallback('download-status', { message: '正在获取视频信息...', type: 'default' });
        const headResponse = await axios.head(videoUrl);
        const totalSize = parseInt(headResponse.headers['content-length'], 10);
        if (isNaN(totalSize) || totalSize <= 0) {
            throw new Error('无法获取视频文件大小，可能链接已失效。');
        }

        const title = awemeDetail.desc || "无标题视频";
        const finalFilePath = path.join(CONFIG.VIDEOS_DIR, `${awemeId}.mp4`);
        const tempDir = path.join(CONFIG.MEDIA_ROOT, `temp_${awemeId}`);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        // 2. 切分下载任务
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
                const chunkSize = await downloadChunk(videoUrl, { start, end }, chunkPath);
                downloadedBytes += chunkSize;
                const progress = downloadedBytes / totalSize;
                sendMessageCallback('download-status', {
                    message: `下载中: ${(progress * 100).toFixed(1)}%`,
                    progress: progress,
                    type: 'progress'
                });
            }));
        }

        // 并发下载封面
        if (coverUrl) {
            tasks.push(limit(() => downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`)));
        }

        // 3. 执行所有下载任务
        await Promise.all(tasks);

        // 4. 合并文件
        sendMessageCallback('download-status', { message: '下载完成，正在合并文件...', type: 'default' });
        await mergeChunks(chunkPaths, finalFilePath);

        // 5. 清理临时文件
        fs.rmSync(tempDir, { recursive: true, force: true });

        const newTrack = {
            title,
            artist: awemeDetail.author?.nickname || "未知作者",
            src: `videos/${awemeId}.mp4`,
            albumArt: `albumArt/${awemeId}.jpg`,
            type: "video",
            lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        // 更新本地播放列表并通知渲染进程
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);

    } catch (e) {
        sendMessageCallback('download-status', { message: `下载抖音作品 ${awemeId} 失败: ${e.message}`, type: 'error' });
    }
}


/**
 * 主处理函数，负责启动无头浏览器并拦截 API 来下载抖音视频。
 * @param {string} videoUrl - 抖音视频或用户主页的 URL。
 */
export async function handleDouyinDownload(videoUrl) {
    sendMessageCallback('download-status', { message: '正在启动无头浏览器以解析抖音链接...' });

    // 1. 定义一个唯一的会话分区名称，确保网络设置隔离
    const partitionName = `persist:douyin_session_${Date.now()}`;

    // 创建一个不显示的浏览器窗口来加载页面
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            // 2. 使用该分区名称来隔离会话
            partition: partitionName,
            // 注入 preload 脚本以绕过自动化检测
            preload: path.join(__dirname, '..', 'backend', 'douyin-preload.js'),
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
        sendMessageCallback('download-status', { message: `网络配置失败: ${proxyError.message}`, type: 'error' });
        if (win && !win.isDestroyed()) win.close();
        return;
    }

    try {
        // 创建一个 Promise 来等待 API 响应，并设置超时
        const apiResponsePromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('API 响应超时 (60秒)')), 60000);
            let debuggerAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (debuggerAttached || win.isDestroyed()) return;
                debuggerAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');

                    sendMessageCallback('download-status', { message: '页面已加载，正在监听网络数据...' });

                    // 监听所有网络响应
                    debuggerApi.on('message', async (event, method, params) => {
                        // 筛选出我们需要的作品详情 API
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const { body } = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                clearTimeout(timeout); // 成功拦截，清除超时计时器
                                resolve(JSON.parse(body));
                            } catch (err) {
                                // 忽略特定错误，例如资源已被浏览器丢弃
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

        let urlToLoad = videoUrl;

        // 如果不是短链 (v.douyin.com)，则尝试转换
        if (!urlToLoad.includes('v.douyin.com')) {
            let numericId = null;
            try {
                const url = new URL(urlToLoad);
                // 检查 modal_id (Type 2)
                if (url.searchParams.has('modal_id')) {
                    numericId = url.searchParams.get('modal_id');
                }
                // 检查路径中的 ID (Type 3 for video or note)
                else {
                    const pathMatch = url.pathname.match(/\/(?:video|note)\/(\d+)/);
                    if (pathMatch && pathMatch[1]) {
                        numericId = pathMatch[1];
                    }
                }
            } catch (parseError) {
                console.warn(`[Douyin Provider] URL '${urlToLoad}' 解析失败，将使用原始链接。错误: ${parseError.message}`);
            }

            if (numericId) {
                urlToLoad = `https://www.douyin.com/video/${numericId}/`;
                sendMessageCallback('download-status', { message: `已将长链接转换为短链接: ${urlToLoad}` });
            }
        }

        // 加载目标 URL，并伪装成普通浏览器
        await win.loadURL(urlToLoad, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        sendMessageCallback('download-status', { message: '正在导航页面，等待 API 响应...' });

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

        // 【修改】调用新的并发下载函数
        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessageCallback('download-status', { message: '视频下载完成！', type: 'success' });

    } catch (error) {
        sendMessageCallback('download-status', { message: `抖音解析失败: ${error.message}`, type: 'error' });
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