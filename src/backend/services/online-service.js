// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
import * as gdstudio from '../providers/gdstudio.js';
import { updateLocalPlaylist } from './library-service.js';

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
        const { list, total } = await gdstudio.search(query, page);
        return { success: true, data: { results: list, total } };
    } catch (error) {
        console.error(`[Online] 在线搜索失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 获取在线音乐的可播放 URL。
 * @param {object} trackInfo - 曲目信息对象。
 * @returns {Promise<object>} - 包含 success 和 url/error 的结果对象。
 */
export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo || !trackInfo.id || !trackInfo.source) {
        return { success: false, error: '获取 URL 失败: 缺少曲目 ID 或来源信息。' };
    }

    try {
        const url = await gdstudio.getMusicUrl(trackInfo);
        return { success: true, url };
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

    // 获取音频 URL
    let audioUrl = trackData.originalSrc;
    if (!audioUrl && trackData.id) {
        try {
            audioUrl = await gdstudio.getMusicUrl(trackData);
        } catch (e) {
            sendMessageCallback('download-status', { message: `获取音频链接失败: ${e.message}`, type: 'error' });
            return;
        }
    }
    if (audioUrl) {
        downloadPromises.push(gdstudio.downloadFile(audioUrl, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
    }

    // 获取封面 URL
    const artUrl = trackData.albumArt || trackData.originalAlbumArt;
    if (artUrl) {
        downloadPromises.push(gdstudio.downloadFile(artUrl, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
    }

    // 获取歌词
    const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
    let lyricContent = '';
    if (trackData.lyricId) {
        try {
            lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source);
        } catch (e) {
            console.warn(`[Online Cache] 获取歌词失败 (ID: ${trackData.lyricId}): ${e.message}`);
        }
    } else if (trackData.originalLyrics) {
        if (trackData.originalLyrics.startsWith('data:text/plain,')) {
            lyricContent = decodeURIComponent(trackData.originalLyrics.substring('data:text/plain,'.length));
        } else if (trackData.originalLyrics.startsWith('http')) {
            downloadPromises.push(gdstudio.downloadFile(trackData.originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
        }
    }
    if (lyricContent) {
        fs.writeFileSync(lyricsPath, lyricContent, 'utf-8');
    }

    // 等待所有下载完成
    try {
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
        sendMessageCallback('download-status', { message: `下载失败: ${error.message}`, type: 'error' });
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