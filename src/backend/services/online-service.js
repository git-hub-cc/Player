// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
import { downloadFile } from './download-service.js';

/**
 * @class OnlineService
 * @description 负责协调在线音乐相关的业务逻辑。
 *              它作为应用层和底层音乐API服务（MusicApiService）之间的桥梁。
 *              【新增功能】支持管理和取消在线歌曲缓存任务。
 */
export class OnlineService {
    #config;
    #sendMessageCallback;
    #libraryService;
    #musicApiService;

    // 【核心新增】用于管理所有正在进行的缓存任务
    // Map<taskId, AbortController>
    // taskId 通常是 track.id (或者组合 source+id)
    #activeTasks = new Map();

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
        console.log(`[Online Service] Service instantiated and connected to MusicApiService.`);
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

    async handleGetMusicUrl(trackData) {
        if (!trackData || !trackData.id) {
            return { success: false, error: '获取 URL 失败: 缺少曲目 ID。' };
        }

        try {
            const [urlInfo, picUrl] = await Promise.all([
                this.#musicApiService.getTrackUrl(trackData),
                this.#musicApiService.getPicUrl(trackData)
            ]);

            if (!urlInfo || !urlInfo.url) {
                throw new Error('API未能返回有效的播放链接，可能是版权或地区限制。');
            }

            let finalAlbumArtUrl = picUrl;
            if (!finalAlbumArtUrl) {
                const safeFilename = this.#sanitizeFilename(`${trackData.artist} - ${trackData.title}`);
                finalAlbumArtUrl = this.#libraryService.generateAndSavePlaceholderArt(trackData.title, safeFilename);
            }

            return {
                success: true,
                url: urlInfo.url,
                isVip: urlInfo.isVip,
                originalTrackInfo: urlInfo.originalTrackInfo,
                albumArtUrl: finalAlbumArtUrl
            };
        } catch (e) {
            console.error(`[Online] 获取音乐 URL 失败: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

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

    /**
     * 【核心修改】处理缓存请求，支持中断。
     */
    async handleCacheRequest(trackData) {
        const title = trackData.title || 'Unknown';
        const artist = Array.isArray(trackData.artist) ? trackData.artist.join(' & ') : (trackData.artist || 'Unknown');
        const uniqueFilenameBase = await this.#libraryService.getNextOrdinal();

        // 生成唯一任务ID
        const taskId = trackData.id;

        // 如果该任务已在运行，不重复启动
        if (this.#activeTasks.has(taskId)) {
            console.log(`[Online] 任务 ${taskId} 已经在运行中。`);
            return;
        }

        // 创建中止控制器
        const controller = new AbortController();
        this.#activeTasks.set(taskId, controller);
        const signal = controller.signal;

        try {
            this.#sendMessageCallback('download-status', { message: `准备下载: ${title}`, type: 'default' });

            // --- 1. 获取音频下载链接 (支持取消检查) ---
            if (signal.aborted) throw new Error('aborted');

            const audioUrl = await this.#musicApiService.getVipTrackUrl(trackData);
            if (!audioUrl) {
                throw new Error('无法获取音频下载链接，可能受版权或地区限制。');
            }

            if (signal.aborted) throw new Error('aborted');

            // --- 2. 准备并发下载任务 ---
            const downloadPromises = [];

            // 音频文件 (传递 signal)
            downloadPromises.push(downloadFile(audioUrl, this.#config.MUSIC_DIR, `${uniqueFilenameBase}.mp3`, {}, () => {}, 3, signal));

            // 封面图
            let finalAlbumArtPath = "";
            const picUrl = await this.#musicApiService.getPicUrl(trackData);
            if (picUrl) {
                finalAlbumArtPath = `albumArt/${uniqueFilenameBase}.jpg`;
                downloadPromises.push(downloadFile(picUrl, this.#config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, {}, () => {}, 3, signal));
            } else {
                finalAlbumArtPath = this.#libraryService.generateAndSavePlaceholderArt(title, uniqueFilenameBase);
            }

            // 歌词
            const lyricsPath = path.join(this.#config.MUSIC_DIR, `${uniqueFilenameBase}.lrc`);
            const lyricContent = await this.#musicApiService.getLyric(trackData);
            if (lyricContent) {
                // 写入文件是瞬时操作，但仍检查 signal
                if (!signal.aborted) {
                    downloadPromises.push(fs.promises.writeFile(lyricsPath, lyricContent, 'utf-8'));
                }
            }

            // --- 3. 执行所有下载 ---
            await Promise.all(downloadPromises);

            if (signal.aborted) throw new Error('aborted');

            // --- 4. 更新媒体库 ---
            const newTrack = {
                title, artist,
                src: `music/${uniqueFilenameBase}.mp3`,
                albumArt: finalAlbumArtPath,
                lyrics: fs.existsSync(lyricsPath) ? `music/${uniqueFilenameBase}.lrc` : "",
                type: "audio",
                pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                id: trackData.id,
                source: trackData.source
            };
            await this.#libraryService.updateLocalPlaylist([newTrack]);

            // --- 5. 通知前端 ---
            this.#sendMessageCallback('new-track-added', newTrack);
            this.#sendMessageCallback('download-status', { message: `下载完成: ${title}`, type: 'success' });

        } catch (error) {
            // 处理取消逻辑
            if (signal.aborted || error.message === 'aborted' || error.message === 'Download aborted by user') {
                console.log(`[Online] 缓存任务 ${title} 已被用户取消。`);
                // 清理可能残留的半成品文件
                const mp3Path = path.join(this.#config.MUSIC_DIR, `${uniqueFilenameBase}.mp3`);
                if (fs.existsSync(mp3Path)) fs.unlink(mp3Path, () => {});

                // 通知前端任务结束（可能需要刷新UI状态）
                // type: 'error' 会让前端移除 loading 状态
                this.#sendMessageCallback('download-status', { message: `下载取消: ${title}`, type: 'error' });
            } else {
                console.error(`[Online] 缓存 "${title}" 失败:`, error);
                this.#sendMessageCallback('download-status', { message: `下载 "${title}" 失败: ${error.message}`, type: 'error' });
            }
        } finally {
            // 移除任务记录
            this.#activeTasks.delete(taskId);
        }
    }

    /**
     * 【核心新增】取消指定ID的缓存任务
     * @param {string|number} taskId
     */
    cancelTask(taskId) {
        const controller = this.#activeTasks.get(taskId);
        if (controller) {
            console.log(`[Online] 正在中断任务: ${taskId}`);
            controller.abort();
            this.#activeTasks.delete(taskId);
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