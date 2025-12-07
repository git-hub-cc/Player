// src/backend/services/download-service.js

import path from 'path';
import fs from 'fs';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import * as jableProvider from '../providers/jable.js';
import * as youtubeProvider from '../providers/youtube.js';
import { updateLocalPlaylist } from './library-service.js';

// --- 模块作用域变量 ---
let CONFIG = {};
let FFMPEG_PATH = '';
let YT_DLP_PATH = '';
let SYSTEM_PROXY = null;
let sendMessageCallback = () => {};

const DOWNLOAD_RETRY_COUNT = 3;

/**
 * 初始化下载服务。
 * @param {object} initParams - 初始化参数对象。
 * @param {object} initParams.config - 应用配置对象。
 * @param {string} initParams.ffmpegPath - FFmpeg 可执行文件路径。
 * @param {string} initParams.ytDlpPath - yt-dlp 可执行文件路径。
 * @param {string|null} initParams.systemProxy - 系统代理 URL。
 * @param {function} initParams.sendMessageFunc - 发送消息到渲染进程的函数。
 */
export function init(initParams) {
    CONFIG = initParams.config;
    FFMPEG_PATH = initParams.ffmpegPath;
    YT_DLP_PATH = initParams.ytDlpPath;
    SYSTEM_PROXY = initParams.systemProxy;
    sendMessageCallback = initParams.sendMessageFunc;
}

/**
 *  sanitzeFilename 的一个副本，用于下载
 */
function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * 通用文件下载函数，支持重试和空文件校验。
 * @param {string} url - 文件 URL。
 * @param {string} folder - 目标文件夹。
 * @param {string} fileName - 文件名。
 * @param {object} headers - 请求头。
 * @param {number} retries - 重试次数。
 * @returns {Promise<void>}
 */
async function downloadFile(url, folder, fileName, headers = {}, retries = DOWNLOAD_RETRY_COUNT) {
    const filePath = path.join(folder, fileName);
    // 如果文件已存在且不为空，则跳过下载
    if (fs.existsSync(filePath)) {
        try {
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) {
                console.log(`[Download] 文件 ${fileName} 已存在且非空，跳过。`);
                return;
            }
        } catch (e) { /* 忽略 stat 错误，继续下载 */ }
    }

    for (let i = 0; i < retries; i++) {
        try {
            const writer = fs.createWriteStream(filePath);
            const response = await axios({
                url, method: 'GET', responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0', ...headers }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 下载完成后检查文件大小
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return;

            throw new Error('下载的文件为空。');
        } catch (error) {
            console.warn(`[Download] 下载 ${fileName} 第 ${i + 1} 次尝试失败: ${error.message}`);
            // 删除可能已创建的空文件
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(e => console.error(e));
            }
            if (i === retries - 1) throw error; // 最后一次重试失败则抛出错误
            await new Promise(res => setTimeout(res, 1000 * (i + 1))); // 增加等待时间
        }
    }
}


/**
 * 处理来自渲染进程的所有下载请求。
 * @param {string|object} requestData - 下载请求数据，通常是 URL 字符串。
 */
export async function handleDownloadRequest(requestData) {
    let url = typeof requestData === 'object' ? requestData.url : requestData;
    if (!url) {
        sendMessageCallback('download-status', { message: '未提供有效的 URL。', type: 'error' });
        return;
    }

    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) {
        sendMessageCallback('download-status', { message: '未找到有效的URL或用户ID。', type: 'error' });
        return;
    }

    const matchedContent = match[0];

    if (matchedContent.includes('bilibili.com/video/')) {
        await downloadBilibiliVideo(matchedContent);
    } else if (matchedContent.includes('jable.tv/videos/')) {
        await downloadJableVideo(matchedContent);
    } else if (matchedContent.includes('youtube.com/') || matchedContent.includes('youtu.be/')) {
        await downloadYoutubeVideo(matchedContent);
    } else {
        let startUrl = matchedContent.startsWith('MS4wLjAB')
            ? `https://www.douyin.com/user/${matchedContent}`
            : matchedContent;

        sendMessageCallback('download-status', { message: `抖音目标已提取: ${startUrl}` });
        await downloadDouyinVideo(startUrl);
    }
}


async function processAndDownloadItem(awemeDetail) {
    const awemeId = awemeDetail?.aweme_id;
    if (!awemeId) return;

    try {
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];

        if (videoUri) {
            await downloadFile(`https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`);
        }
        if (coverUrl) {
            await downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`);
        }

        const title = awemeDetail.desc || "无标题视频";
        const newTrack = {
            title, artist: awemeDetail.author?.nickname || "未知作者",
            src: `videos/${awemeId}.mp4`, albumArt: `albumArt/${awemeId}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);

    } catch (e) {
        sendMessageCallback('download-status', { message: `下载抖音作品 ${awemeId} 失败: ${e.message}`, type: 'error' });
    }
}


async function downloadDouyinVideo(videoUrl) {
    sendMessageCallback('download-status', { message: '正在启动无头浏览器...' });
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            partition: `persist:douyin_session_${Date.now()}`,
            preload: path.join(__dirname, '..', 'backend', 'douyin-preload.js'),
            contextIsolation: true, sandbox: true
        }
    });
    win.webContents.setAudioMuted(true);

    try {
        const apiResponsePromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('API 响应超时')), 60000);
            let debuggerAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (debuggerAttached || win.isDestroyed()) return;
                debuggerAttached = true;
                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');

                    sendMessageCallback('download-status', { message: '页面已加载，正在监听网络数据...' });

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

        await win.loadURL(videoUrl, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        sendMessageCallback('download-status', { message: '正在导航页面，等待 API 响应...' });

        const apiResponseJson = await apiResponsePromise;
        if (!apiResponseJson?.aweme_detail) {
            throw new Error('未能拦截到有效的 API 响应。');
        }

        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessageCallback('download-status', { message: '视频下载完成！', type: 'success' });

    } catch (error) {
        sendMessageCallback('download-status', { message: `浏览器操作失败: ${error.message}`, type: 'error' });
    } finally {
        if (win && !win.isDestroyed()) {
            if (win.webContents.debugger.isAttached()) {
                await win.webContents.debugger.detach();
            }
            win.close();
        }
    }
}

async function downloadBilibiliVideo(videoUrl) {
    if (!FFMPEG_PATH) {
        sendMessageCallback('download-status', { message: '错误: FFmpeg 未找到，无法合并B站视频。', type: 'error' });
        return;
    }
    try {
        sendMessageCallback('download-status', { message: '开始解析B站链接...', type: 'default' });
        const bvidMatch = videoUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (!bvidMatch) throw new Error('无法从URL中提取有效的BV号。');
        const bvid = bvidMatch[0];

        const viewResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const viewData = viewResponse.data.data;
        if (!viewData || !viewData.cid) throw new Error('无法获取视频信息，请检查链接是否有效。');
        const { cid, title, owner, pic: coverUrl } = viewData;
        const author = owner?.name || '未知UP主';
        const safeFilename = sanitizeFilename(`${author} - ${title}`);

        const playResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': videoUrl } });
        const dashData = playResponse.data.data?.dash;
        if (!dashData?.video?.[0] || !dashData?.audio?.[0]) throw new Error('无法获取DASH格式的音视频流。');

        sendMessageCallback('download-status', { message: '正在下载视频和音频文件...', type: 'default' });
        const videoTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_video_temp.m4s`);
        const audioTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_audio_temp.m4s`);
        const coverPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        const finalPath = path.join(CONFIG.VIDEOS_DIR, `${safeFilename}.mp4`);

        await Promise.all([
            downloadFile(dashData.video[0].baseUrl, path.dirname(videoTempPath), path.basename(videoTempPath), { 'Referer': videoUrl }),
            downloadFile(dashData.audio[0].baseUrl, path.dirname(audioTempPath), path.basename(audioTempPath), { 'Referer': videoUrl }),
            downloadFile(coverUrl, CONFIG.ALBUMART_DIR, path.basename(coverPath), { 'Referer': videoUrl }),
        ]);

        sendMessageCallback('download-status', { message: '下载完成，开始使用FFmpeg合并...', type: 'default' });
        const ffmpegCommand = `"${FFMPEG_PATH}" -y -i "${videoTempPath}" -i "${audioTempPath}" -c copy "${finalPath}"`;
        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (error, stdout, stderr) => {
                fs.unlink(videoTempPath, () => {});
                fs.unlink(audioTempPath, () => {});
                if (error) return reject(new Error('FFmpeg合并失败: ' + stderr));
                resolve(stdout);
            });
        });

        const newTrack = { title, artist: author, src: `videos/${path.basename(finalPath)}`, albumArt: `albumArt/${path.basename(coverPath)}`, type: "video", lyrics: "", pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '') };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `"${title}" 下载完成！`, type: 'success' });
    } catch (error) {
        console.error('[Bilibili Download] 错误:', error);
        sendMessageCallback('download-status', { message: `B站下载失败: ${error.message}`, type: 'error' });
    }
}

async function downloadJableVideo(videoUrl) {
    if (!FFMPEG_PATH) {
        sendMessageCallback('download-status', { message: '错误: FFmpeg 未找到，无法处理Jable视频。', type: 'error' });
        return;
    }
    try {
        sendMessageCallback('download-status', { message: '正在解析 Jable 视频信息...', type: 'default' });
        const info = await jableProvider.getVideoInfo(videoUrl);
        if (!info.m3u8Url) throw new Error('未找到 m3u8 播放地址');

        const safeFilename = sanitizeFilename(info.title);
        if (info.coverUrl) {
            await downloadFile(info.coverUrl, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        }

        sendMessageCallback('download-status', { message: '开始下载并解密视频分片...', type: 'default' });
        await jableProvider.downloadVideo(
            info.m3u8Url, CONFIG.VIDEOS_DIR, `${safeFilename}.mp4`,
            (progress) => sendMessageCallback('download-status', { message: `下载进度: ${(progress * 100).toFixed(1)}%`, type: 'default' }),
            FFMPEG_PATH, info.cookieString
        );

        const newTrack = {
            title: info.title, artist: 'Jable TV',
            src: `videos/${safeFilename}.mp4`, albumArt: `albumArt/${safeFilename}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });
    } catch (error) {
        console.error('[Jable Download] Error:', error);
        sendMessageCallback('download-status', { message: `Jable 下载失败: ${error.message}`, type: 'error' });
    }
}

async function downloadYoutubeVideo(videoUrl) {
    if (!YT_DLP_PATH || !FFMPEG_PATH) {
        sendMessageCallback('download-status', { message: '错误: yt-dlp 或 FFmpeg 未就绪，无法下载 YouTube 视频。', type: 'error' });
        return;
    }
    try {
        sendMessageCallback('download-status', { message: '正在获取 YouTube 视频信息...', type: 'default' });
        const info = await youtubeProvider.getVideoInfo(videoUrl, YT_DLP_PATH, SYSTEM_PROXY);

        const safeFilename = sanitizeFilename(info.title);
        if (info.thumbnail) {
            await downloadFile(info.thumbnail, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        }

        sendMessageCallback('download-status', { message: '开始调用 yt-dlp 下载...', type: 'default' });
        await youtubeProvider.downloadVideo(
            videoUrl, CONFIG.VIDEOS_DIR, safeFilename, YT_DLP_PATH, FFMPEG_PATH,
            (progress) => sendMessageCallback('download-status', { message: `下载进度: ${(progress * 100).toFixed(1)}%`, type: 'default' }),
            SYSTEM_PROXY
        );

        const newTrack = {
            title: info.title, artist: info.uploader || 'YouTube',
            src: `videos/${safeFilename}.mp4`, albumArt: `albumArt/${safeFilename}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });
    } catch (error) {
        console.error('[YouTube Download] Error:', error);
        sendMessageCallback('download-status', { message: `YouTube 下载失败: ${error.message}`, type: 'error' });
    }
}