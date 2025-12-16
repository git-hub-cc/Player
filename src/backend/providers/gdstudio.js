// src/backend/providers/gdstudio.js

import axios from 'axios';
import { createHash } from 'crypto';
import { URLSearchParams } from 'url';
import https from 'https'; // 引入 https 模块用于 Keep-Alive Agent

// --- 配置 ---
const MKPLAYER_VERSION = '2025.11.4';
const TIMEOUT = 20000;
const DEFAULT_SOURCE = 'netease';

// =========================================================================
// 【核心优化】网络层配置
// 1. 全局 Agent：启用 Keep-Alive，复用 TCP 连接，减少 SSL 握手开销。
// 2. UA 伪装：硬编码 Chrome UA。
// =========================================================================
const keepAliveAgent = new https.Agent({ keepAlive: true });
const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- 模块级状态：时间戳校准 ---
// 用于存储本地时间与服务器时间的差值 (serverTime - localTime)
// 避免每次请求都访问喜马拉雅接口，显著减少网络开销
let timeOffset = 0;
let isTimeCalibrated = false;

// =========================================================================
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
 * 初始化或获取时间偏移量。
 * 仅在首次调用时请求服务器时间，后续使用偏移量计算。
 * @returns {Promise<number>} - 本地时间与服务器时间的差值 (ms)。
 */
async function getTimeOffset() {
    if (isTimeCalibrated) {
        return timeOffset;
    }

    try {
        const start = Date.now();
        // 【核心优化】
        // 1. 设置极短的超时 (1500ms)，如果喜马拉雅因为反爬虫延迟响应，直接放弃。
        // 2. 显式禁用 proxy (proxy: false)，防止 Axios 在 Windows 上进行缓慢的自动代理探测。
        // 3. 使用伪装 UA。
        const response = await axios.get('https://www.ximalaya.com/revision/time', {
            timeout: 1500,
            proxy: false, // 强制禁用自动代理检测
            httpsAgent: keepAliveAgent,
            headers: { 'User-Agent': SPOOF_USER_AGENT }
        });
        const serverTimeStr = response.data.toString().trim();
        const serverTime = parseInt(serverTimeStr, 10);

        const end = Date.now();
        // 粗略计算网络延迟的一半
        const latency = (end - start) / 2;

        // 计算偏移量
        if (!isNaN(serverTime)) {
            timeOffset = serverTime - (Date.now() - latency); // 近似对齐
            isTimeCalibrated = true;
            console.log(`[GDStudio] 时间戳校准完成，偏移量: ${timeOffset}ms`);
        } else {
            console.warn('[GDStudio] 获取的时间戳格式无效，使用本地时间。');
        }
    } catch (error) {
        console.warn('[GDStudio] 获取校准时间戳失败/超时，将使用本地时间:', error.message);
        // 失败时不阻止流程，直接使用本地时间（偏移量保持 0）
    }
    return timeOffset;
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
    // 1. 获取时间偏移量（仅首次请求网络）
    await getTimeOffset();

    // 2. 基于偏移量计算当前的“服务器时间”
    const estimatedServerTime = Date.now() + timeOffset;
    const timestampStr = estimatedServerTime.toString();

    // 保持原有截取逻辑 (0, 9)
    const slicedTimestamp = timestampStr.substring(0, 9);

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

    // =========================================================================
    // 【核心优化】Axios 请求配置
    // =========================================================================
    const axiosConfig = {
        timeout: TIMEOUT,
        headers: {
            'User-Agent': SPOOF_USER_AGENT, // 伪装 UA
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        httpsAgent: keepAliveAgent, // 复用连接
    };

    // 关键：如果没有明确的系统代理，必须显式设置 proxy: false，
    // 否则 Axios 会在 Windows 上尝试读取注册表或环境变量，这在某些环境下非常慢（几秒延迟）。
    if (systemProxy) {
        // systemProxy 格式通常是 "http://127.0.0.1:7890"
        // Axios 需要对象格式 { host, port, protocol }
        try {
            const proxyUrl = new URL(systemProxy);
            axiosConfig.proxy = {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port, 10),
                protocol: proxyUrl.protocol
            };
        } catch (e) {
            console.warn('[GDStudio] 代理配置解析失败，将直连:', e);
            axiosConfig.proxy = false;
        }
    } else {
        axiosConfig.proxy = false;
    }

    const response = await axios.post(apiUrl, payload, axiosConfig);

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