// src/backend/services/online-service.js

import fs from 'fs';
import path from 'path';
import { pinyin } from 'pinyin-pro';
import * as gdstudio from '../providers/gdstudio.js';
import { downloadFile } from './download-service.js';

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
    // #libraryService 用于生成占位封面图
    #libraryService;
    // #systemProxy 存储系统代理信息
    #systemProxy;

    /**
     * @param {object} config - 应用的全局配置对象。
     * @param {function} sendMessageFunc - 向渲染进程发送消息的回调函数。
     * @param {import('./library-service.js').LibraryService} libraryService - 媒体库服务实例。
     * @param {string|null} systemProxy - 系统代理设置。
     */
    constructor(config, sendMessageFunc, libraryService, systemProxy) {
        this.#config = config;
        this.#sendMessageCallback = sendMessageFunc;
        this.#libraryService = libraryService;
        this.#systemProxy = systemProxy; // 保存 systemProxy 实例
        console.log(`[Online Service] 服务已实例化。代理: ${this.#systemProxy || '无'}`);
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
            // 将代理信息传递给 gdstudio 模块
            const { list, total } = await gdstudio.search(query, page, 20, 'netease', this.#systemProxy);
            return { success: true, data: { results: list, total } };
        } catch (error) {
            console.error(`[Online] 在线搜索失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async handleGetMusicUrl(trackData) {
        if (!trackData || !trackData.id || !trackData.source) {
            return { success: false, error: '获取 URL 失败: 缺少曲目 ID 或来源信息。' };
        }
        try {
            // 并行获取音乐URL和封面真实URL，并将代理信息传递下去
            const [musicUrl, albumArtUrl] = await Promise.all([
                gdstudio.getMusicUrl(trackData, this.#systemProxy),
                gdstudio.resolvePicUrl(trackData.pic_id, trackData.source, this.#systemProxy)
            ]);

            // 如果封面图URL获取失败，则生成一个占位图的 Data URL
            let finalAlbumArtUrl = albumArtUrl;
            if (!finalAlbumArtUrl) {
                const safeFilename = this.#sanitizeFilename(`${trackData.artist} - ${trackData.title}`);
                // 注意：这里生成的是 Base64 格式的 Data URL，用于临时显示
                finalAlbumArtUrl = this.#libraryService.generateAndSavePlaceholderArt(trackData.title, safeFilename);
            }

            return { success: true, url: musicUrl, albumArtUrl: finalAlbumArtUrl };
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
            // --- 1. 音频下载 ---
            let audioUrl = trackData.originalSrc;
            if (!audioUrl && trackData.id) {
                // 如果没有提供原始URL（例如直接从搜索结果下载），则重新获取
                audioUrl = await gdstudio.getMusicUrl(trackData, this.#systemProxy);
            }
            if (!audioUrl) {
                throw new Error('无法获取音频下载链接。');
            }
            // 将音频下载任务添加到 Promise 数组
            downloadPromises.push(downloadFile(audioUrl, this.#config.MUSIC_DIR, `${safeFilename}.mp3`));

            // --- 2. 封面处理 (核心修改) ---
            let artUrl = trackData.albumArt || trackData.originalAlbumArt;
            let finalAlbumArtPath = ""; // 这是最终要保存到 playlist.json 的相对路径

            // 步骤 2.1: 如果传入的 artUrl 不是一个可用的URL (http/data)，则尝试从 API 解析
            if ((!artUrl || (!artUrl.startsWith('http') && !artUrl.startsWith('data:'))) && trackData.pic_id) {
                artUrl = await gdstudio.resolvePicUrl(trackData.pic_id, trackData.source, this.#systemProxy);
            }

            // 步骤 2.2: 根据 artUrl 的类型进行处理
            if (artUrl && artUrl.startsWith('http')) {
                // 情况 A: 得到一个标准的网络图片链接，下载它
                finalAlbumArtPath = `albumArt/${safeFilename}.jpg`;
                downloadPromises.push(downloadFile(artUrl, this.#config.ALBUMART_DIR, `${safeFilename}.jpg`));
            } else if (artUrl && artUrl.startsWith('data:image/png;base64,')) {
                // 情况 B: 得到一个 Base64 格式的图片数据 (通常是占位图)，直接写入文件
                finalAlbumArtPath = `albumArt/${safeFilename}.png`;
                const base64Data = artUrl.replace(/^data:image\/png;base64,/, "");
                const coverPath = path.join(this.#config.ALBUMART_DIR, `${safeFilename}.png`);
                // 使用异步写入，并将其加入 Promise 数组，以便 Promise.all 等待
                downloadPromises.push(fs.promises.writeFile(coverPath, base64Data, 'base64'));
            } else if (artUrl && !artUrl.startsWith('http') && !artUrl.startsWith('data:')) {
                // 情况 C: 传入的可能是一个本地已存在的相对路径，直接采纳
                finalAlbumArtPath = artUrl;
            } else {
                // 情况 D: 所有尝试都失败了 (无 pic_id, 解析失败等)，生成并保存一个新的占位图
                finalAlbumArtPath = this.#libraryService.generateAndSavePlaceholderArt(title, safeFilename);
            }

            // --- 3. 歌词处理 ---
            const lyricsPath = path.join(this.#config.MUSIC_DIR, `${safeFilename}.lrc`);
            if (trackData.lyricId) {
                const lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source, this.#systemProxy);
                if (lyricContent) {
                    // 异步写入歌词文件
                    downloadPromises.push(fs.promises.writeFile(lyricsPath, lyricContent, 'utf-8'));
                }
            }

            // --- 4. 并发执行所有下载和写入任务 ---
            await Promise.all(downloadPromises);

            // --- 5. 创建新的轨道对象并更新播放列表 ---
            const newTrack = {
                title, artist,
                src: `music/${safeFilename}.mp3`,
                albumArt: finalAlbumArtPath, // 使用准备好的最终封面路径
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

    async handleGetOnlineLyric({ lyricId, source }) {
        if (!lyricId || !source) return { success: false, error: '缺少歌词 ID 或来源信息。' };
        try {
            // 传递代理信息
            const content = await gdstudio.getLyric(lyricId, source, this.#systemProxy);
            return { success: true, data: content };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}