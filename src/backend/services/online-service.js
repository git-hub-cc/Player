// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
// =========================================================================
// 【核心修改】从 gdstudio 导入 resolvePicUrl 函数，用于按需获取封面
// =========================================================================
import * as gdstudio from '../providers/gdstudio.js';
import { updateLocalPlaylist } from './library-service.js';
import { downloadFile } from './download-service.js';

// --- 模块作用域变量 ---
let CONFIG = {};
let sendMessageCallback = () => {}; // 空函数作为默认值

/**
 * 初始化在线服务。
 * @param {object} sharedConfig - 从 setup-service 传入的 CONFIG 对象。
 * @param {function} sendMessageFunc - 用于向渲染进程发送消息的回调函数。
 */
export function init(sharedConfig, sendMessageFunc) {
    CONFIG = sharedConfig;
    sendMessageCallback = sendMessageFunc;
}

/**
 *  sanitzeFilename 的一个副本，用于缓存
 */
function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * 处理在线音乐搜索请求。
 * @param {object} params - 包含 query 和 page 的参数对象。
 * @returns {Promise<object>} - 包含 success 和 data/error 的结果对象。
 */
export async function handleSearchRequest({ query, page = 1 }) {
    try {
        // 【鲁棒性】现在 search 函数仅返回基础信息，不再包含耗时的封面请求
        const { list, total } = await gdstudio.search(query, page);
        return { success: true, data: { results: list, total } };
    } catch (error) {
        console.error(`[Online] 在线搜索失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * =========================================================================
 * 【核心修改】增强此函数，使其在获取播放链接的同时，也按需获取封面 URL
 * =========================================================================
 * 获取在线音乐的可播放 URL 和封面 URL。
 * @param {object} trackInfo - 曲目信息对象，应包含 id, source, pic_id。
 * @returns {Promise<object>} - 包含 success 和 url, albumArtUrl, error 的结果对象。
 */
export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo || !trackInfo.id || !trackInfo.source) {
        return { success: false, error: '获取 URL 失败: 缺少曲目 ID 或来源信息。' };
    }

    try {
        // 并行获取音乐 URL 和封面 URL，提高效率
        const [musicUrl, albumArtUrl] = await Promise.all([
            gdstudio.getMusicUrl(trackInfo),
            gdstudio.resolvePicUrl(trackInfo.pic_id, trackInfo.source) // 按需获取封面
        ]);

        return { success: true, url: musicUrl, albumArtUrl };
    } catch (e) {
        console.error(`[Online] 获取音乐 URL 失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 将在线曲目缓存（下载）到本地。
 * @param {object} trackData - 包含在线曲目信息的对象。
 */
export async function handleCacheRequest(trackData) {
    const title = trackData.title || 'Unknown';
    const artist = trackData.artist || 'Unknown';
    console.log(`[Online Cache] 请求: ${artist} - ${title}`);

    const safeFilename = sanitizeFilename(`${artist} - ${title}`);
    const downloadPromises = [];

    try {
        // --- 音频下载 ---
        let audioUrl = trackData.originalSrc;
        if (!audioUrl && trackData.id) {
            audioUrl = await gdstudio.getMusicUrl(trackData);
        }
        if (audioUrl) {
            downloadPromises.push(downloadFile(audioUrl, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
        } else {
            throw new Error('无法获取音频下载链接。');
        }

        // =========================================================================
        // 【核心修改】按需获取封面 URL 进行下载
        // 1. 优先使用 trackData 中已有的 albumArt (可能在播放时已获取)。
        // 2. 如果没有，则使用 pic_id 实时获取。
        // =========================================================================
        let artUrl = trackData.albumArt || trackData.originalAlbumArt;
        if (!artUrl && trackData.pic_id) {
            artUrl = await gdstudio.resolvePicUrl(trackData.pic_id, trackData.source);
        }
        if (artUrl) {
            downloadPromises.push(downloadFile(artUrl, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
        }

        // --- 歌词处理 ---
        const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
        let lyricContent = '';
        if (trackData.lyricId) {
            lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source);
        } else if (trackData.originalLyrics) {
            if (trackData.originalLyrics.startsWith('data:text/plain,')) {
                lyricContent = decodeURIComponent(trackData.originalLyrics.substring('data:text/plain,'.length));
            } else if (trackData.originalLyrics.startsWith('http')) {
                downloadPromises.push(downloadFile(trackData.originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
            }
        }
        if (lyricContent) {
            // 使用 a+ 标志，如果文件已由 downloadFile 创建，则不会覆盖
            fs.writeFileSync(lyricsPath, lyricContent, { encoding: 'utf-8', flag: 'a+' });
        }

        // 等待所有下载完成
        await Promise.all(downloadPromises);

        const newTrack = {
            title, artist,
            src: `music/${safeFilename}.mp3`,
            albumArt: fs.existsSync(path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : "",
            lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
            type: "audio",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
            id: trackData.id,
            source: trackData.source
        };

        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);
        sendMessageCallback('download-status', { message: `下载完成: ${title}`, type: 'success' });

    } catch (error) {
        sendMessageCallback('download-status', { message: `下载 "${title}" 失败: ${error.message}`, type: 'error' });
    }
}


/**
 * 从本地文件系统读取 LRC 歌词文件的内容。
 * @param {string} relativePath - 歌词文件相对于 MEDIA_ROOT 的路径。
 * @returns {Promise<object>} - 包含 success 和 data/error 的结果对象。
 */
export async function handleGetLrcContent(relativePath) {
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodeURIComponent(relativePath));
    try {
        if (!fs.existsSync(fullPath)) throw new Error('歌词文件未找到');
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        return { success: true, data: content };
    } catch (e) {
        console.error(`[Online] 读取歌词内容失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}