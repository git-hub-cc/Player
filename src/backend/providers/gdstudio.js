// src/backend/providers/gdstudio.js

import axios from 'axios';
import { encodeParameter, generateSignature } from './gdstudio-signature.js';
import https from 'https';

// --- 模块配置 ---
const TIMEOUT = 20000; // API 请求超时时间

// =========================================================================
// 【核心优化】网络层配置
// 1. 全局 Agent: 启用 Keep-Alive，复用 TCP 连接以减少延迟。
// 2. UA 伪装: 使用标准的浏览器 User-Agent，防止被识别为脚本。
// =========================================================================
const keepAliveAgent = new https.Agent({ keepAlive: true });
const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const API_ORIGIN = 'https://music.gdstudio.org';

// 站内 /time 返回秒级时间戳；每次签名前刷新，与抓包流程保持一致。
async function getServerTimestamp(axiosConfig) {
    try {
        const response = await axios.get(`${API_ORIGIN}/time`, {
            ...axiosConfig,
            timeout: 5000,
            responseType: 'text',
            headers: { ...axiosConfig.headers, 'Cache-Control': 'no-cache' },
        });
        const seconds = String(response.data).trim();
        if (!/^\d{10}$/.test(seconds)) {
            throw new Error('服务器时间格式无效');
        }
        return Number(seconds) * 1000;
    } catch (error) {
        // 与网页一致，失败时使用本地时间，下次请求重新获取服务器时间。
        console.warn('[GDStudio] 获取服务器时间失败，使用本地时间:', error.message);
        return Date.now();
    }
}

/**
 * @private
 * 执行一个带签名的 API 请求，并处理代理和JSONP响应。
 * @param {object} params - 请求参数对象。
 * @param {string|null} systemProxy - 系统代理信息。
 * @returns {Promise<any>} - 返回 API 响应的数据部分。
 */
async function signedApiRequest(params, systemProxy) {
    const apiUrl = `${API_ORIGIN}/api.php`;
    const hostname = new URL(API_ORIGIN).hostname;
    const searchTerm = params.name || params.id;

    if (!searchTerm) {
        throw new Error('请求缺少必需的 name 或 id 参数用于生成签名。');
    }

    const axiosConfig = {
        timeout: TIMEOUT,
        headers: {
            'User-Agent': SPOOF_USER_AGENT,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Referer': `${API_ORIGIN}/`,
            'X-Requested-With': 'XMLHttpRequest',
        },
        httpsAgent: keepAliveAgent,
    };

    // 显式处理代理配置
    if (systemProxy) {
        try {
            const proxyUrl = new URL(systemProxy);
            axiosConfig.proxy = {
                host: proxyUrl.hostname,
                port: Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80)),
                protocol: proxyUrl.protocol.replace(':', ''),
            };
        } catch (e) {
            console.warn('[GDStudio] 代理配置解析失败，将直连:', e);
            axiosConfig.proxy = false;
        }
    } else {
        axiosConfig.proxy = false; // 无代理时必须显式禁用，防止axios自动探测
    }

    const timestamp = await getServerTimestamp(axiosConfig);
    const signature = generateSignature(hostname, searchTerm, timestamp);
    const query = Object.entries({ ...params, s: signature })
        .map(([key, value]) => `${encodeParameter(key)}=${encodeParameter(value)}`).join('&');
    const response = await axios.get(`${apiUrl}?${query}`, axiosConfig);

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
    if (!trackInfo?.id || !trackInfo?.source) {
        throw new Error('获取 URL 需要提供曲目 ID 和来源');
    }

    try {
        const data = await signedApiRequest({
            types: 'url',
            id: trackInfo.id,
            source: trackInfo.source,
            br
        }, systemProxy);

        if (typeof data?.url === 'string' && /^https?:\/\//i.test(data.url)) {
            return data.url.replace(/^http:\/\//, 'https://'); // 强制使用 HTTPS
        } else {
            throw new Error('API未能返回有效的播放链接，可能是版权或接口问题。');
        }
    } catch (error) {
        console.error(`[GDStudio] 获取 "${trackInfo.title}" 的 URL 失败:`, error.message);
        throw error;
    }
}
