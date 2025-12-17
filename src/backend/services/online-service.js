// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
import { downloadFile } from './download-service.js';

/**
 * @class OnlineService
 * @description 负责协调在线音乐相关的业务逻辑。
 *              它作为应用层和底层音乐API服务（MusicApiService）之间的桥梁，
 *              处理如搜索、获取播放链接、缓存等高级任务。
 */
export class OnlineService {
    #config;
    #sendMessageCallback;
    #libraryService;
    #musicApiService;

    /**
     * @param {object} config - 应用的全局配置对象。
     * @param {function} sendMessageFunc - 向渲染进程发送消息的回调函数。
     * @param {import('./library-service.js').LibraryService} libraryService - 媒体库服务实例。
     * @param {import('./music-api-service.js').MusicApiService} musicApiService - 音乐API服务实例。
     */
    constructor(config, sendMessageFunc, libraryService, musicApiService) {
        this.#config = config;
        this.#sendMessageCallback = sendMessageFunc;
        this.#libraryService = libraryService;
        this.#musicApiService = musicApiService;
        console.log(`[Online Service] 服务已实例化，并已连接到 MusicApiService。`);
    }

    #sanitizeFilename(filename) {
        if (!filename) return 'untitled';
        const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
        return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
    }

    async handleSearchRequest({ query, page = 1 }) {
        try {
            const { list, total } = await this.#musicApiService.search(query, { page, limit: 20 });
            return { success: true, data: { results: list, total } };
        } catch (error) {
            console.error(`[Online] 在线搜索失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取音乐播放 URL 和封面图。
     * 此方法现在会处理普通和会员歌曲两种情况。
     */
    async handleGetMusicUrl(trackData) {
        if (!trackData || !trackData.id) {
            return { success: false, error: '获取 URL 失败: 缺少曲目 ID。' };
        }

        try {
            // 1. 并行获取歌曲元信息（可能包含试听URL）和封面真实URL
            const [urlInfo, picUrl] = await Promise.all([
                this.#musicApiService.getTrackUrl(trackData),
                this.#musicApiService.getPicUrl(trackData)
            ]);

            if (!urlInfo || !urlInfo.url) {
                throw new Error('API未能返回有效的播放链接，可能是版权或地区限制。');
            }

            // 2. 处理封面图
            let finalAlbumArtUrl = picUrl;
            if (!finalAlbumArtUrl) {
                const safeFilename = this.#sanitizeFilename(`${trackData.artist} - ${trackData.title}`);
                finalAlbumArtUrl = this.#libraryService.generateAndSavePlaceholderArt(trackData.title, safeFilename);
            }

            // 3. 构造并返回包含所有必要信息的响应对象
            return {
                success: true,
                url: urlInfo.url, // 对VIP歌曲是试听URL，对普通歌曲是最终URL
                isVip: urlInfo.isVip,
                originalTrackInfo: urlInfo.originalTrackInfo, // 仅在VIP歌曲时存在
                albumArtUrl: finalAlbumArtUrl
            };
        } catch (e) {
            console.error(`[Online] 获取音乐 URL 失败: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    // =========================================================================
    // 【核心新增】处理获取会员歌曲正式URL的请求
    // =========================================================================
    /**
     * 处理获取会员歌曲真实播放链接的请求。
     * 此方法会调用 MusicApiService 中带缓存的逻辑。
     * @param {object} trackInfo - 从前端传来的原始轨道信息。
     * @returns {Promise<object>} - 包含 { success, url } 的对象。
     */
    async handleGetVipMusicUrl(trackInfo) {
        if (!trackInfo || !trackInfo.id) {
            return { success: false, error: '获取 VIP URL 失败: 缺少曲目 ID。' };
        }
        try {
            const url = await this.#musicApiService.getVipTrackUrl(trackInfo);
            if (url) {
                return { success: true, url };
            } else {
                throw new Error('无法从上游服务获取有效的播放链接。');
            }
        } catch (error) {
            console.error(`[Online] 获取VIP音乐URL失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    // =========================================================================

    async handleCacheRequest(trackData) {
        const title = trackData.title || 'Unknown';
        const artist = Array.isArray(trackData.artist) ? trackData.artist.join(' & ') : (trackData.artist || 'Unknown');
        const safeFilename = this.#sanitizeFilename(`${artist} - ${title}`);
        const downloadPromises = [];

        try {
            // --- 1. 获取音频下载链接 (对VIP歌曲，这将是真实链接) ---
            // 注意：这里我们总是获取最终链接来下载，而不是试听版
            const audioUrl = await this.#musicApiService.getVipTrackUrl(trackData);
            if (!audioUrl) {
                throw new Error('无法获取音频下载链接，可能受版权或地区限制。');
            }
            downloadPromises.push(downloadFile(audioUrl, this.#config.MUSIC_DIR, `${safeFilename}.mp3`));

            // --- 2. 获取并处理封面 ---
            let finalAlbumArtPath = "";
            const picUrl = await this.#musicApiService.getPicUrl(trackData);
            if (picUrl) {
                finalAlbumArtPath = `albumArt/${safeFilename}.jpg`;
                downloadPromises.push(downloadFile(picUrl, this.#config.ALBUMART_DIR, `${safeFilename}.jpg`));
            } else {
                finalAlbumArtPath = this.#libraryService.generateAndSavePlaceholderArt(title, safeFilename);
            }

            // --- 3. 获取并处理歌词 ---
            const lyricsPath = path.join(this.#config.MUSIC_DIR, `${safeFilename}.lrc`);
            const lyricContent = await this.#musicApiService.getLyric(trackData);
            if (lyricContent) {
                downloadPromises.push(fs.promises.writeFile(lyricsPath, lyricContent, 'utf-8'));
            }

            // --- 4. 并发执行所有下载和写入任务 ---
            await Promise.all(downloadPromises);

            // --- 5. 创建新的轨道对象并更新播放列表 ---
            const newTrack = {
                title, artist,
                src: `music/${safeFilename}.mp3`,
                albumArt: finalAlbumArtPath,
                lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
                type: "audio",
                pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                id: trackData.id,
                source: trackData.source
            };
            await this.#libraryService.updateLocalPlaylist([newTrack]);

            // --- 6. 通知前端 ---
            this.#sendMessageCallback('new-track-added', newTrack);
            this.#sendMessageCallback('download-status', { message: `下载完成: ${title}`, type: 'success' });
        } catch (error) {
            console.error(`[Online] 缓存 "${title}" 失败:`, error);
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

    async handleGetOnlineLyric(trackInfo) {
        if (!trackInfo || !trackInfo.id) {
            return { success: false, error: '缺少轨道信息或ID。' };
        }
        try {
            const content = await this.#musicApiService.getLyric(trackInfo);
            return { success: true, data: content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}