// src/backend/providers/gdstudio.js

import axios from 'axios';

// --- 配置 ---
const API_BASE_URL = 'https://music-api.gdstudio.xyz/api.php';
const DEFAULT_SOURCE = 'netease'; // 默认源：netease, tencent, kugou 等
const TIMEOUT = 20000; // 适当增加超时时间，因为现在涉及多次请求

// 创建 Axios 实例
const apiClient = axios.create({
    timeout: TIMEOUT,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
});

/**
 * 构造通用的请求参数
 */
function makeParams(types, extra = {}) {
    return {
        types,
        source: extra.source || DEFAULT_SOURCE,
        ...extra
    };
}

/**
 * 内部辅助函数：获取真实的图片链接
 * 因为该 API 的图片接口返回的是 JSON {"url": "...", "from": "..."}，
 * 而不是直接的图片流，所以必须先请求一次以获取 URL。
 */
async function resolvePicUrl(picId, source) {
    if (!picId) return '';
    try {
        const response = await apiClient.get(API_BASE_URL, {
            params: makeParams('pic', { id: picId, source })
        });
        // API 返回格式: { "url": "http://...", "from": "..." }
        if (response.data && response.data.url) {
            return response.data.url.replace(/^http:\/\//, 'https://');
        }
        return '';
    } catch (error) {
        // 图片获取失败不应阻塞整个流程，返回空字符串即可
        // console.warn(`[GDStudio] Failed to resolve pic for ID ${picId}:`, error.message);
        return '';
    }
}

/**
 * 搜索音乐
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {number} count - 每页数量
 * @param {string} source - 音乐源 (可选)
 * @returns {Promise<Array>} - 返回标准化的曲目列表
 */
export async function search(query, page = 1, count = 20, source = DEFAULT_SOURCE) {
    try {
        // 1. 获取基础搜索列表
        const response = await apiClient.get(API_BASE_URL, {
            params: makeParams('search', { name: query, pages: page, count, source })
        });

        const data = response.data;
        if (!Array.isArray(data)) {
            console.warn('[GDStudio] Search returned non-array data:', data);
            return { list: [], total: 0 };
        }

        // 2. 预处理列表结构
        // 注意：此时 albumArt 还是空的，需要下一步异步填充
        const rawList = data.map(item => ({
            id: item.id, // 原始 ID
            source: item.source, // 来源
            title: item.name,
            artist: (item.artist || []).join(' / '), // 歌手数组转字符串
            album: item.album,
            pic_id: item.pic_id, // 暂存图片ID用于后续请求
            lyricId: item.lyric_id,
            albumArt: '' // 占位
        }));

        // 3. 并行获取所有真实的图片链接
        // 这是一个妥协方案：虽然会增加 HTTP 请求数，但为了兼容前端 <img src> 直接渲染，
        // 必须在后端解析出真实的图片 URL。
        // 使用 Promise.all 并行处理以减少等待时间。
        await Promise.all(rawList.map(async (track) => {
            if (track.pic_id) {
                track.albumArt = await resolvePicUrl(track.pic_id, track.source);
            }
            // 删除临时字段，保持对象整洁
            delete track.pic_id;
        }));

        // 注意：该 API 分页信息不全，通常无法准确获取 total，
        // 这里模拟一个 total，确保分页控件能显示下一页
        const total = rawList.length < count ? (page - 1) * count + rawList.length : 9999;

        return { list: rawList, total };

    } catch (error) {
        console.error('[GDStudio] Search error:', error.message);
        throw error;
    }
}

/**
 * 获取音乐播放链接
 * @param {object} trackInfo - 曲目信息对象 (必须包含 id 和 source)
 * @param {string|number} br - 比特率 (默认 999 无损)
 * @returns {Promise<string>} - 音乐 URL
 */
export async function getMusicUrl(trackInfo, br = 999) {
    if (!trackInfo.id || !trackInfo.source) {
        throw new Error('Track ID and Source are required to fetch URL');
    }

    try {
        const response = await apiClient.get(API_BASE_URL, {
            params: makeParams('url', { id: trackInfo.id, source: trackInfo.source, br })
        });

        const data = response.data;
        if (data && data.url) {
            // 处理可能的 HTTP/HTTPS 混用问题，防止混合内容报错
            return data.url.replace(/^http:\/\//, 'https://');
        } else {
            throw new Error('API returned empty URL');
        }
    } catch (error) {
        console.error(`[GDStudio] Get URL error for ${trackInfo.title}:`, error.message);
        throw error;
    }
}

/**
 * 获取歌词
 * @param {string|number} lyricId - 歌词 ID
 * @param {string} source - 音乐源
 * @returns {Promise<string>} - LRC 格式歌词文本
 */
export async function getLyric(lyricId, source = DEFAULT_SOURCE) {
    if (!lyricId) return '';

    try {
        const response = await apiClient.get(API_BASE_URL, {
            params: makeParams('lyric', { id: lyricId, source })
        });

        const data = response.data;
        // API 返回 { lyric: "...", tlyric: "..." }
        if (data.lyric) {
            return data.lyric;
        }
        return '';
    } catch (error) {
        console.error(`[GDStudio] Get lyric error for ID ${lyricId}:`, error.message);
        return ''; // 失败返回空歌词，不中断流程
    }
}

/**
 * 验证 URL 是否有效 (辅助方法)
 */
export async function validateUrl(url) {
    if (!url) return false;
    try {
        const response = await apiClient.head(url);
        return response.status >= 200 && response.status < 300;
    } catch {
        return false;
    }
}