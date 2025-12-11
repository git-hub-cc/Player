// src/backend/services/download-service.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { exec } from 'child_process';
import * as jableProvider from '../providers/jable.js';
import * as youtubeProvider from '../providers/youtube.js';
// 【核心修改】导入新的抖音服务提供者
import * as douyinProvider from '../providers/douyin.js';
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
 */
export function init(initParams) {
    CONFIG = initParams.config;
    FFMPEG_PATH = initParams.ffmpegPath;
    YT_DLP_PATH = initParams.ytDlpPath;
    SYSTEM_PROXY = initParams.systemProxy;
    sendMessageCallback = initParams.sendMessageFunc;

    // 【核心修改】初始化所有下载提供者
    douyinProvider.init({ config: CONFIG, sendMessageFunc: sendMessageCallback });

    console.log('[Download Service] 服务已初始化。');
}

/**
 * 清理文件名，移除不安全字符。
 * @param {string} filename - 原始文件名。
 * @returns {string} - 清理后的文件名。
 */
function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * 【核心修改】导出此通用文件下载函数，供其他模块（如 provider）使用。
 * 支持重试和空文件校验。
 * @param {string} url - 文件 URL。
 * @param {string} folder - 目标文件夹。
 * @param {string} fileName - 文件名。
 * @param {object} headers - 请求头。
 * @param {number} retries - 重试次数。
 */
export async function downloadFile(url, folder, fileName, headers = {}, retries = DOWNLOAD_RETRY_COUNT) {
    const filePath = path.join(folder, fileName);
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

            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return;

            throw new Error('下载的文件为空。');
        } catch (error) {
            console.warn(`[Download] 下载 ${fileName} 第 ${i + 1} 次尝试失败: ${error.message}`);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(e => console.error(e));
            }
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
    }
}

/**
 * 处理来自渲染进程的所有下载请求。
 * 这是一个路由函数，根据 URL 类型分发给不同的提供者。
 * @param {string|object} requestData - 下载请求数据。
 */
export async function handleDownloadRequest(requestData) {
    let url = typeof requestData === 'object' ? requestData.url : requestData;
    if (!url) {
        sendMessageCallback('download-status', { message: '未提供有效的 URL。', type: 'error' });
        return;
    }

    const match = url.match(/https?:\/\/[^\s]+/);
    if (!match) {
        sendMessageCallback('download-status', { message: '输入内容不是一个有效的URL链接。', type: 'error' });
        return;
    }

    const matchedContent = match[0];

    // [修改] 为所有支持的链接创建明确的布尔标志
    const isBiliUrl = matchedContent.includes('bilibili.com/video/');
    const isJableUrl = matchedContent.includes('jable.tv/videos/');
    const isYoutubeUrl = matchedContent.includes('youtube.com/') || matchedContent.includes('youtu.be/');
    const isDouyinUrl = matchedContent.includes('douyin.com') || matchedContent.includes('iesdouyin.com');


    // [修改] 使用更严谨的 if-else 链进行任务分发
    if (isBiliUrl) {
        await downloadBilibiliVideo(matchedContent);
    } else if (isJableUrl) {
        await downloadJableVideo(matchedContent);
    } else if (isYoutubeUrl) {
        await downloadYoutubeVideo(matchedContent);
    } else if (isDouyinUrl) {
        // 明确处理抖音链接
        sendMessageCallback('download-status', { message: `抖音目标已提取: ${matchedContent}` });
        await douyinProvider.handleDouyinDownload(matchedContent);
    } else {
        // [修改] 将其他所有URL都尝试用抖音解析器处理，并给出明确提示
        sendMessageCallback('download-status', { message: `未知链接，尝试作为抖音视频处理: ${matchedContent}` });
        await douyinProvider.handleDouyinDownload(matchedContent);
    }
}

/**
 * 下载 Bilibili 视频。
 * @param {string} videoUrl - Bilibili 视频 URL。
 */
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

/**
 * 下载 Jable 视频。
 * @param {string} videoUrl - Jable 视频 URL。
 */
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

        const newTrack = { title: info.title, artist: 'Jable TV', src: `videos/${safeFilename}.mp4`, albumArt: `albumArt/${safeFilename}.jpg`, type: "video", lyrics: "", pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '') };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });
    } catch (error) {
        console.error('[Jable Download] Error:', error);
        sendMessageCallback('download-status', { message: `Jable 下载失败: ${error.message}`, type: 'error' });
    }
}

/**
 * 下载 YouTube 视频。
 * @param {string} videoUrl - YouTube 视频 URL。
 */
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

        const newTrack = { title: info.title, artist: info.uploader || 'YouTube', src: `videos/${safeFilename}.mp4`, albumArt: `albumArt/${safeFilename}.jpg`, type: "video", lyrics: "", pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '') };
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });
    } catch (error) {
        console.error('[YouTube Download] Error:', error);
        sendMessageCallback('download-status', { message: `YouTube 下载失败: ${error.message}`, type: 'error' });
    }
}