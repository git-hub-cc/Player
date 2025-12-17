// src/backend/providers/gdstudio.js

import axios from 'axios';
import { createHash } from 'crypto';
import { URLSearchParams } from 'url';
import https from 'https';

// --- 模块配置 ---
const MKPLAYER_VERSION = '2025.11.4';
const TIMEOUT = 20000; // API 请求超时时间
const DEFAULT_SOURCE = 'netease'; // 默认音乐源

// =========================================================================
// 【核心优化】网络层配置
// 1. 全局 Agent: 启用 Keep-Alive，复用 TCP 连接以减少延迟。
// 2. UA 伪装: 使用标准的浏览器 User-Agent，防止被识别为脚本。
// =========================================================================
const keepAliveAgent = new https.Agent({ keepAlive: true });
const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- 模块级状态：时间戳校准 ---
// 用于存储本地时间与服务器时间的差值 (serverTime - localTime)。
// 首次请求后缓存该值，避免每次都请求，显著优化性能。
let timeOffset = 0;
let isTimeCalibrated = false;

/**
 * @private
 * 根据系统代理设置选择合适的 API 域名。
 * @param {string|null} systemProxy - 系统代理字符串。
 * @returns {{hostname: string, apiUrl: string}} - 包含主机名和完整 API URL 的对象。
 */
function getApiEndpoints(systemProxy) {
    const hostname = 'music.gdstudio.org'; // 固定使用 .org 域名
    return {
        hostname,
        apiUrl: `https://${hostname}/api.php`,
    };
}

/**
 * @private
 * 初始化或获取时间偏移量。仅在首次调用时请求服务器时间。
 * @returns {Promise<number>} - 本地时间与服务器时间的差值 (毫秒)。
 */
async function getTimeOffset() {
    if (isTimeCalibrated) {
        return timeOffset;
    }

    try {
        const start = Date.now();
        // 使用极短的超时，如果服务器响应慢则直接放弃校准，不影响主流程。
        const response = await axios.get('https://www.ximalaya.com/revision/time', {
            timeout: 1500,
            proxy: false, // 强制禁用代理自动检测，避免 Windows 下的性能问题
            httpsAgent: keepAliveAgent,
            headers: { 'User-Agent': SPOOF_USER_AGENT }
        });

        const serverTime = parseInt(response.data.toString().trim(), 10);
        const end = Date.now();
        const latency = (end - start) / 2; // 粗略计算单程网络延迟

        if (!isNaN(serverTime)) {
            timeOffset = serverTime - (Date.now() - latency); // 计算并缓存时间差
            isTimeCalibrated = true;
            console.log(`[GDStudio] 时间戳校准完成，偏移量: ${timeOffset}ms`);
        } else {
            console.warn('[GDStudio] 获取的时间戳格式无效，将使用本地时间。');
        }
    } catch (error) {
        console.warn('[GDStudio] 获取校准时间戳失败/超时，将使用本地时间:', error.message);
    }
    return timeOffset;
}

/**
 * @private
 * 格式化版本号字符串，用于签名 (例如 "2025.11.4" -> "20251104")。
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
 * @returns {Promise<string>} - 返回签名字符串。
 */
async function generateSignature(hostname, searchTerm) {
    await getTimeOffset();
    const estimatedServerTime = Date.now() + timeOffset;
    const timestampStr = estimatedServerTime.toString();
    const slicedTimestamp = timestampStr.substring(0, 9);
    const formattedVersion = formatVersion(MKPLAYER_VERSION);
    const encodedSearchTerm = encodeURIComponent(searchTerm);

    const stringToHash = `${hostname}|${formattedVersion}|${slicedTimestamp}|${encodedSearchTerm}`;
    const md5Hash = createHash('md5').update(stringToHash).digest('hex');

    return md5Hash.slice(-8).toUpperCase();
}

/**
 * @private
 * 执行一个带签名的 API 请求，并处理代理和JSONP响应。
 * @param {object} params - 请求参数对象。
 * @param {string|null} systemProxy - 系统代理信息。
 * @returns {Promise<any>} - 返回 API 响应的数据部分。
 */
async function signedApiRequest(params, systemProxy) {
    const { hostname, apiUrl } = getApiEndpoints(systemProxy);
    const searchTerm = params.name || params.id;

    if (!searchTerm) {
        throw new Error('请求缺少必需的 name 或 id 参数用于生成签名。');
    }

    const signature = await generateSignature(hostname, searchTerm.toString());
    const payload = new URLSearchParams({ ...params, s: signature }).toString();

    const axiosConfig = {
        timeout: TIMEOUT,
        headers: {
            'User-Agent': SPOOF_USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        httpsAgent: keepAliveAgent,
    };

    // 显式处理代理配置
    if (systemProxy) {
        try {
            const proxyUrl = new URL(systemProxy);
            axiosConfig.proxy = {
                host: proxyUrl.hostname,
                port: parseInt(proxyUrl.port, 10),
                protocol: proxyUrl.protocol.replace(':', ''),
            };
        } catch (e) {
            console.warn('[GDStudio] 代理配置解析失败，将直连:', e);
            axiosConfig.proxy = false;
        }
    } else {
        axiosConfig.proxy = false; // 无代理时必须显式禁用，防止axios自动探测
    }

    const response = await axios.post(apiUrl, payload, axiosConfig);

    // 处理可能的 JSONP 响应格式
    let responseData = response.data;
    if (typeof responseData === 'string' && responseData.startsWith('jQuery')) {
        const jsonpData = responseData.substring(responseData.indexOf('(') + 1, responseData.lastIndexOf(')'));
        return JSON.parse(jsonpData);
    }
    return responseData;
}

// --- 导出的公共函数 ---

/**
 * 获取音乐播放链接。这是该模块的核心功能。
 * @param {object} trackInfo - 曲目信息对象 (必须包含 id 和 source)。
 * @param {string|null} systemProxy - 系统代理信息。
 * @param {number} [br=999] - 比特率 (默认 999 表示最高品质)。
 * @returns {Promise<string>} - 音乐的URL。
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
            return data.url.replace(/^http:\/\//, 'https://'); // 强制使用 HTTPS
        } else {
            throw new Error('API未能返回有效的播放链接，可能是版权或接口问题。');
        }
    } catch (error) {
        console.error(`[GDStudio] 获取 "${trackInfo.title}" 的 URL 失败:`, error.message);
        throw error;
    }
}