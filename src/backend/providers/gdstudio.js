// src/backend/providers/gdstudio.js

import axios from 'axios';
import { createHash } from 'crypto';
import { URLSearchParams } from 'url';

// --- 配置 ---
const MKPLAYER_VERSION = '2025.11.4';
const TIMEOUT = 20000;
const DEFAULT_SOURCE = 'netease';

// =========================================================================
// 【核心修改区域】
// 签名生成与 API 请求逻辑
// =========================================================================

/**
 * @private
 * 根据系统代理选择合适的 API 域名。
 * @param {string|null} systemProxy - 系统代理字符串。
 * @returns {{hostname: string, apiUrl: string}} - 包含主机名和完整 API URL 的对象。
 */
function getApiEndpoints(systemProxy) {
    // 逻辑：如果用户配置了系统代理，使用 .xyz 域名；否则，使用 .org 域名。
    // const hostname = systemProxy ? 'music.gdstudio.xyz' : 'music.gdstudio.org';
    const hostname = 'music.gdstudio.org';
    return {
        hostname,
        apiUrl: `https://${hostname}/api.php`,
    };
}

/**
 * @private
 * 从喜马拉雅获取服务器时间戳，用于签名。
 * @returns {Promise<string|null>} - 返回时间戳字符串或 null。
 */
async function getXimalayaTimestamp() {
    try {
        const response = await axios.get('https://www.ximalaya.com/revision/time', { timeout: 5000 });
        return response.data.toString().trim();
    } catch (error) {
        console.error('[GDStudio Signature] 获取时间戳失败:', error.message);
        return null;
    }
}

/**
 * @private
 * 格式化版本号字符串，用于签名。
 * 例如 "2025.11.4" -> "20251104"
 * @param {string} versionStr - 版本号字符串。
 * @returns {string} - 格式化后的版本号。
 */
function formatVersion(versionStr) {
    return versionStr.split('.').map(part => part.padStart(2, '0')).join('');
}

/**
 * @private
 * 生成 API 请求所需的签名 `s` 参数。
 * @param {string} hostname - API 的主机名。
 * @param {string} searchTerm - 搜索关键词或请求ID。
 * @returns {Promise<string|null>} - 成功则返回签名字符串，失败则返回 null。
 */
async function generateSignature(hostname, searchTerm) {
    const timestamp = await getXimalayaTimestamp();
    if (!timestamp) {
        return null; // 时间戳获取失败，无法生成签名
    }

    const slicedTimestamp = timestamp.substring(0, 9);
    const formattedVersion = formatVersion(MKPLAYER_VERSION);
    // 关键：模拟 JavaScript 的 encodeURIComponent
    const encodedSearchTerm = encodeURIComponent(searchTerm);

    const stringToHash = `${hostname}|${formattedVersion}|${slicedTimestamp}|${encodedSearchTerm}`;
    const md5Hash = createHash('md5').update(stringToHash).digest('hex');

    // 截取最后8位并转为大写
    return md5Hash.slice(-8).toUpperCase();
}

/**
 * @private
 * 执行一个带签名的 API 请求。
 * @param {object} params - 请求参数对象。
 * @param {string|null} systemProxy - 系统代理信息。
 * @returns {Promise<any>} - 返回 API 响应的数据部分。
 */
async function signedApiRequest(params, systemProxy) {
    const { hostname, apiUrl } = getApiEndpoints(systemProxy);
    const searchTerm = params.name || params.id; // 签名基于搜索词或ID

    if (!searchTerm) {
        throw new Error('请求缺少必需的 name 或 id 参数用于生成签名。');
    }

    const signature = await generateSignature(hostname, searchTerm.toString());
    if (!signature) {
        throw new Error('无法生成请求签名，请检查网络连接。');
    }

    const payload = new URLSearchParams({
        ...params,
        s: signature
    }).toString();

    const response = await axios.post(apiUrl, payload, {
        timeout: TIMEOUT,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    // 处理 JSONP 响应
    let responseData = response.data;
    if (typeof responseData === 'string' && responseData.startsWith('jQuery')) {
        const jsonpData = responseData.substring(responseData.indexOf('(') + 1, responseData.lastIndexOf(')'));
        return JSON.parse(jsonpData);
    }
    return responseData;
}


// --- 导出的公共函数 ---

/**
 * 内部辅助函数：获取真实的图片链接
 * @param {string|number} picId - 图片 ID
 * @param {string} source - 音乐源
 * @param {string|null} systemProxy - 系统代理信息
 * @returns {Promise<string>} - 解析后的图片 URL 或空字符串
 */
export async function resolvePicUrl(picId, source, systemProxy) {
    if (!picId) return '';
    try {
        const responseData = await signedApiRequest({
            types: 'pic',
            id: picId,
            source: source || DEFAULT_SOURCE,
        }, systemProxy);

        if (responseData && responseData.url) {
            return responseData.url.replace(/^http:\/\//, 'https://');
        }
        return '';
    } catch (error) {
        return ''; // 图片获取失败不应阻塞整个流程
    }
}

/**
 * 搜索音乐
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {number} count - 每页数量
 * @param {string} source - 音乐源 (可选)
 * @param {string|null} systemProxy - 系统代理信息
 * @returns {Promise<object>} - 返回包含 { list, total } 的对象
 */
export async function search(query, page = 1, count = 20, source = DEFAULT_SOURCE, systemProxy) {
    try {
        const data = await signedApiRequest({
            types: 'search',
            name: query,
            count,
            source: source || DEFAULT_SOURCE,
            pages: page // API文档中的分页参数是 'pages'
        }, systemProxy);

        if (!Array.isArray(data)) {
            console.warn('[GDStudio] 搜索返回了非数组格式的数据:', data);
            return { list: [], total: 0 };
        }

        const rawList = data.map(item => ({
            id: item.id,
            source: item.source,
            title: item.name,
            artist: (item.artist || []).join(' / '),
            album: item.album,
            pic_id: item.pic_id,
            lyricId: item.lyric_id,
            albumArt: '' // 封面图 URL 初始为空
        }));

        const total = rawList.length < count ? (page - 1) * count + rawList.length : page * count + 1; // 模拟总数
        return { list: rawList, total };

    } catch (error) {
        console.error('[GDStudio] 搜索失败:', error.message);
        throw error;
    }
}

/**
 * 获取音乐播放链接
 * @param {object} trackInfo - 曲目信息对象 (必须包含 id 和 source)
 * @param {string|null} systemProxy - 系统代理信息
 * @param {number} br - 比特率 (默认 999 无损)
 * @returns {Promise<string>} - 音乐 URL
 */
export async function getMusicUrl(trackInfo, systemProxy, br = 999) {
    if (!trackInfo.id || !trackInfo.source) {
        throw new Error('获取 URL 需要提供曲目 ID 和来源');
    }

    try {
        const data = await signedApiRequest({
            types: 'url',
            id: trackInfo.id,
            source: trackInfo.source,
            br
        }, systemProxy);

        if (data && data.url) {
            return data.url.replace(/^http:\/\//, 'https://');
        } else {
            throw new Error('API 返回的 URL 为空');
        }
    } catch (error) {
        console.error(`[GDStudio] 获取 "${trackInfo.title}" 的 URL 失败:`, error.message);
        throw error;
    }
}

/**
 * 获取歌词
 * @param {string|number} lyricId - 歌词 ID
 * @param {string} source - 音乐源
 * @param {string|null} systemProxy - 系统代理信息
 * @returns {Promise<string>} - LRC 格式歌词文本
 */
export async function getLyric(lyricId, source = DEFAULT_SOURCE, systemProxy) {
    if (!lyricId) return '';
    try {
        const data = await signedApiRequest({
            types: 'lyric',
            id: lyricId,
            source: source || DEFAULT_SOURCE,
        }, systemProxy);

        return data.lyric || '';
    } catch (error) {
        console.error(`[GDStudio] 获取歌词 (ID: ${lyricId}) 失败:`, error.message);
        return ''; // 失败返回空歌词，不中断流程
    }
}