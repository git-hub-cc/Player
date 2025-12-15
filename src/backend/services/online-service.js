// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
import * as gdstudio from '../providers/gdstudio.js';
import { downloadFile } from './download-service.js';
// 注意：不再直接导入 library-service，因为它会通过 DI 注入

/**
 * @class OnlineService
 * @description 负责处理所有与在线音乐服务相关的业务逻辑，
 *              包括搜索、获取播放链接、下载缓存以及歌词处理。
 */
export class OnlineService {
    // #config 存储应用的路径配置
    #config;
    // #sendMessageCallback 用于向渲染进程发送消息
    #sendMessageCallback;
    // #libraryService 用于更新本地播放列表
    #libraryService;

    /**
     * @param {object} config - 应用的全局配置对象。
     * @param {function} sendMessageFunc - 向渲染进程发送消息的回调函数。
     * @param {import('./library-service.js').LibraryService} libraryService - 媒体库服务实例。
     */
    constructor(config, sendMessageFunc, libraryService) {
        this.#config = config;
        this.#sendMessageCallback = sendMessageFunc;
        this.#libraryService = libraryService; // 保存 libraryService 实例
        console.log('[Online Service] 服务已实例化。');
    }

    // --- 私有辅助方法 ---

    #sanitizeFilename(filename) {
        if (!filename) return 'untitled';
        const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
        return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
    }

    // --- 公共 API 方法 ---

    async handleSearchRequest({ query, page = 1 }) {
        try {
            const { list, total } = await gdstudio.search(query, page);
            return { success: true, data: { results: list, total } };
        } catch (error) {
            console.error(`[Online] 在线搜索失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async handleGetMusicUrl(trackInfo) {
        if (!trackInfo || !trackInfo.id || !trackInfo.source) {
            return { success: false, error: '获取 URL 失败: 缺少曲目 ID 或来源信息。' };
        }
        try {
            const [musicUrl, albumArtUrl] = await Promise.all([
                gdstudio.getMusicUrl(trackInfo),
                gdstudio.resolvePicUrl(trackInfo.pic_id, trackInfo.source)
            ]);
            return { success: true, url: musicUrl, albumArtUrl };
        } catch (e) {
            console.error(`[Online] 获取音乐 URL 失败: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    async handleCacheRequest(trackData) {
        const title = trackData.title || 'Unknown';
        const artist = trackData.artist || 'Unknown';
        const safeFilename = this.#sanitizeFilename(`${artist} - ${title}`);
        const downloadPromises = [];

        try {
            // 音频下载
            let audioUrl = trackData.originalSrc;
            if (!audioUrl && trackData.id) audioUrl = await gdstudio.getMusicUrl(trackData);
            if (!audioUrl) throw new Error('无法获取音频下载链接。');
            downloadPromises.push(downloadFile(audioUrl, this.#config.MUSIC_DIR, `${safeFilename}.mp3`));

            // 封面下载
            let artUrl = trackData.albumArt || trackData.originalAlbumArt;
            if (!artUrl && trackData.pic_id) artUrl = await gdstudio.resolvePicUrl(trackData.pic_id, trackData.source);
            if (artUrl) downloadPromises.push(downloadFile(artUrl, this.#config.ALBUMART_DIR, `${safeFilename}.jpg`));

            // 歌词处理
            const lyricsPath = path.join(this.#config.MUSIC_DIR, `${safeFilename}.lrc`);
            if (trackData.lyricId) {
                const lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source);
                if (lyricContent) fs.writeFileSync(lyricsPath, lyricContent, { encoding: 'utf-8', flag: 'w' });
            }

            await Promise.all(downloadPromises);

            const newTrack = {
                title, artist,
                src: `music/${safeFilename}.mp3`,
                albumArt: fs.existsSync(path.join(this.#config.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : "",
                lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
                type: "audio",
                pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                id: trackData.id,
                source: trackData.source
            };

            // 使用注入的 libraryService 实例来更新播放列表
            await this.#libraryService.updateLocalPlaylist([newTrack]);

            this.#sendMessageCallback('new-track-added', newTrack);
            this.#sendMessageCallback('download-status', { message: `下载完成: ${title}`, type: 'success' });

        } catch (error) {
            this.#sendMessageCallback('download-status', { message: `下载 "${title}" 失败: ${error.message}`, type: 'error' });
        }
    }

    async handleGetLrcContent(relativePath) {
        const fullPath = path.join(this.#config.MEDIA_ROOT, decodeURIComponent(relativePath));
        try {
            if (!fs.existsSync(fullPath)) throw new Error('歌词文件未找到');
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            return { success: true, data: content };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async handleGetOnlineLyric({ lyricId, source }) {
        if (!lyricId || !source) return { success: false, error: '缺少歌词 ID 或来源信息。' };
        try {
            const content = await gdstudio.getLyric(lyricId, source);
            return { success: true, data: content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}