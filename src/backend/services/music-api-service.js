// src/backend/services/music-api-service.js

import Meting from '../meting/meting.js';
import * as GDStudio from '../providers/gdstudio.js';

// =========================================================================
// 【核心新增】会员歌曲URL缓存配置
// =========================================================================
const VIP_URL_CACHE_EXPIRATION_MS = 60 * 60 * 1000; // 缓存1小时
// =========================================================================


/**
 * @class MusicApiService
 * @description 音乐API服务适配器层。
 *              该服务封装了 Meting 引擎和 GDStudio 服务，为应用提供统一、简洁的
 *              在线音乐服务接口。它负责实例化和管理 Meting，并内置了会员歌曲URL缓存。
 *              这是应用与底层音乐API引擎交互的唯一入口。
 */
export class MusicApiService {
    #meting;
    #systemProxy;
    // =========================================================================
    // 【核心新增】用于缓存会员歌曲URL的 Map
    // 格式: Map<string, { url: string, expires: number }>
    // key 为 `trackInfo.id`
    // =========================================================================
    #vipUrlCache = new Map();


    /**
     * @param {object} config - 应用的全局配置对象。
     * @param {string|null} systemProxy - 系统代理设置。
     */
    constructor(config, systemProxy) {
        this.#systemProxy = systemProxy;
        this.#meting = new Meting('netease', { proxy: this.#systemProxy });
        this.#meting.format(true);

        console.log(`[Music API Service] 服务已实例化，固定平台: netease, 代理: ${this.#systemProxy || '无'}`);
    }

    /**
     * 根据关键词搜索音乐。
     * @param {string} keyword - 搜索关键词。
     * @param {object} options - 搜索选项，如 { page, limit }。
     * @returns {Promise<object>} - 返回包含 { list, total } 的对象。
     */
    async search(keyword, options = { page: 1, limit: 20 }) {
        try {
            const result = await this.#meting.search(keyword, options);
            const data = JSON.parse(result);
            const total = data.length < options.limit ? (options.page - 1) * options.limit + data.length : options.page * options.limit + 1;
            return { list: data, total };
        } catch (error) {
            console.error('[Music API Service] 搜索失败:', error);
            throw new Error(`搜索失败: ${this.#meting.status || error.message}`);
        }
    }

    /**
     * 获取音乐的播放链接和元信息。
     * 此方法包含决策逻辑：
     * 1. 通过 Meting 获取包含 `fee` 字段的歌曲信息。
     * 2. 如果是会员歌曲 (`fee=1`)，返回试听URL、isVip标志和原始轨道信息。
     * 3. 如果是免费歌曲，返回最终URL和 isVip=false。
     * @param {object} trackInfo - 包含 id 等信息的轨道对象。
     * @returns {Promise<object>} - 返回包含 { url, isVip, ... } 的对象。
     */
    async getTrackUrl(trackInfo) {
        const urlId = trackInfo.url_id || trackInfo.id;
        try {
            const metingResult = await this.#meting.url(urlId, 320);
            const data = JSON.parse(metingResult);
            console.log(`[Music API Service] Meting URL 元数据 for "${trackInfo.title}":`, data);

            const isVipSong = data && data.fee === 1;

            if (isVipSong) {
                console.log(`[Music API Service] "${trackInfo.title}" 是会员歌曲，返回试听URL。`);
                return {
                    url: data.url, // 这是试听URL
                    isVip: true,
                    originalTrackInfo: trackInfo // 将原始信息传回，用于后续请求
                };
            } else {
                console.log(`[Music API Service] "${trackInfo.title}" 是免费歌曲，返回最终URL。`);
                return {
                    url: data.url || null,
                    isVip: false
                };
            }
        } catch (error) {
            console.error(`[Music API Service] 获取 "${trackInfo.title}" 的元信息失败:`, error);
            throw error;
        }
    }

    // =========================================================================
    // 【核心新增】获取会员歌曲的正式播放链接（带缓存）
    // =========================================================================
    /**
     * 获取会员歌曲的真实播放链接，并进行缓存。
     * @param {object} trackInfo - 包含 id 等信息的轨道对象。
     * @returns {Promise<string|null>} - 返回真实的播放URL。
     */
    async getVipTrackUrl(trackInfo) {
        const cacheKey = trackInfo.id.toString();
        const cachedEntry = this.#vipUrlCache.get(cacheKey);

        // 1. 检查缓存是否有效
        if (cachedEntry && Date.now() < cachedEntry.expires) {
            console.log(`[Music API Service] [Cache HIT] for VIP track ID: ${cacheKey}`);
            return cachedEntry.url;
        }

        // 2. 缓存未命中或已过期，则请求新链接
        console.log(`[Music API Service] [Cache MISS] for VIP track ID: ${cacheKey}，正在从 GDStudio 请求...`);
        try {
            const url = await GDStudio.getMusicUrl(trackInfo, this.#systemProxy);
            if (url) {
                // 3. 存入缓存
                this.#vipUrlCache.set(cacheKey, {
                    url: url,
                    expires: Date.now() + VIP_URL_CACHE_EXPIRATION_MS
                });
                console.log(`[Music API Service] 成功获取并缓存了 "${trackInfo.title}" 的URL。`);
            }
            return url;
        } catch (error) {
            console.error(`[Music API Service] GDStudio 获取 "${trackInfo.title}" 的URL失败:`, error);
            return null;
        }
    }
    // =========================================================================


    /**
     * 获取歌曲的封面图片链接。
     * @param {object} trackInfo - 包含 pic_id 等信息的轨道对象。
     * @returns {Promise<string|null>} - 返回图片 URL，失败则返回 null。
     */
    async getPicUrl(trackInfo) {
        try {
            const result = await this.#meting.pic(trackInfo.pic_id, 300);
            const data = JSON.parse(result);
            return data.url || null;
        } catch (error) {
            console.error(`[Music API Service] 获取 "${trackInfo.title}" 的封面失败:`, error);
            return null;
        }
    }

    /**
     * 获取歌词内容。
     * @param {object} trackInfo - 包含 lyric_id 等信息的轨道对象。
     * @returns {Promise<string>} - 返回 LRC 格式的歌词文本。
     */
    async getLyric(trackInfo) {
        const lyricId = trackInfo.lyric_id || trackInfo.id;
        try {
            const result = await this.#meting.lyric(lyricId);
            const data = JSON.parse(result);
            return data.lyric || '';
        } catch (error) {
            console.error(`[Music API Service] 获取 "${trackInfo.title}" 的歌词失败:`, error);
            return '';
        }
    }
}