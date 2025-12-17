/**
 * Meting music framework - Node.js version (重构版本)
 * https://i-meto.com
 * https://github.com/metowolf/Meting
 *
 * Copyright 2019, METO Sheel <i@i-meto.com>
 * Released under the MIT license
 */

import { URLSearchParams } from 'url';
import ProviderFactory from './providers/index.js';
import axios from 'axios';

class Meting {
    /**
     * Meting 构造函数
     * @param {string} [server='netease'] - 默认音乐平台
     * @param {object} [options={}] - 配置选项
     * @param {string|null} [options.proxy=null] - 代理服务器地址, e.g., 'http://127.0.0.1:7890'
     */
    constructor(server = 'netease', options = {}) {
        this.VERSION = '__VERSION__'; // 在构建时由 rollup 替换为实际版本号
        this.raw = null;
        this.info = null;
        this.error = null;
        this.status = null;
        this.temp = {};

        this.server = null;
        this.provider = null;
        this.isFormat = false;
        this.header = {};

        // 保存代理配置
        this.proxy = options.proxy || null;

        this.site(server);
    }

    // 设置音乐平台
    site(server) {
        if (!ProviderFactory.isSupported(server)) {
            server = 'netease'; // 默认使用某网音乐
        }

        this.server = server;
        this.provider = ProviderFactory.create(server, this);
        this.header = this.provider.getHeaders();

        return this;
    }

    // 设置 Cookie
    cookie(cookie) {
        this.header['Cookie'] = cookie;
        return this;
    }

    // 设置数据格式化
    format(format = true) {
        this.isFormat = format;
        return this;
    }

    // 执行 API 请求的主方法
    async _exec(api) {
        // 让 Provider 自己处理完整的请求流程
        return await this.provider.executeRequest(api, this);
    }

    /**
     * 【核心重写与日志增强】HTTP 请求方法 - 使用 axios 以支持代理
     * @param {string} url - 请求的URL
     * @param {object|string|Buffer|null} payload - 请求体
     * @returns {Promise<this>} - 返回 Meting 实例
     */
    async _curl(url, payload = null) {
        const requestOptions = {
            method: payload ? 'POST' : 'GET',
            url: url,
            headers: { ...this.header },
            timeout: 20000, // 20秒超时
            responseType: 'text', // 确保获取原始文本响应
        };

        // 处理代理配置
        if (this.proxy) {
            try {
                const proxyUrl = new URL(this.proxy);
                requestOptions.proxy = {
                    protocol: proxyUrl.protocol.replace(':', ''),
                    host: proxyUrl.hostname,
                    port: parseInt(proxyUrl.port, 10),
                };
            } catch (e) {
                console.warn(`[Meting] 无效的代理格式: ${this.proxy}，将尝试直连。`);
                requestOptions.proxy = false;
            }
        } else {
            // 显式禁用代理，防止 axios 自动探测
            requestOptions.proxy = false;
        }

        // 处理请求体
        if (payload) {
            if (typeof payload === 'object' && !Buffer.isBuffer(payload)) {
                payload = new URLSearchParams(payload).toString();
                requestOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
            requestOptions.data = payload;
        }

        // =========================================================================
        // 【日志】在请求前打印详细的请求参数
        // =========================================================================
        console.log('[Meting] 【日志】即将发送HTTP请求:', {
            method: requestOptions.method,
            url: requestOptions.url,
            headers: requestOptions.headers,
            proxy: requestOptions.proxy,
            data: requestOptions.data // 注意：对于大型二进制数据，这可能输出很多内容
        });
        // =========================================================================


        let retries = 3;
        const makeRequest = async () => {
            try {
                const response = await axios(requestOptions);

                // 存储响应信息
                this.info = {
                    statusCode: response.status,
                    headers: response.headers
                };

                // 获取响应数据
                this.raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                this.error = null;
                this.status = '';

                // =========================================================================
                // 【日志】请求成功时打印响应状态和数据预览
                // =========================================================================
                console.log('[Meting] 【日志】HTTP请求成功:', {
                    statusCode: response.status,
                    // 截取前 500 个字符以避免日志过长
                    dataPreview: this.raw.substring(0, 500)
                });
                // =========================================================================

                return this;
            } catch (err) {
                // 处理错误
                if (axios.isCancel(err)) {
                    this.error = 'TIMEOUT';
                    this.status = 'Request timeout';
                } else if (err.response) {
                    this.error = `HTTP_${err.response.status}`;
                    this.status = err.response.statusText;
                } else {
                    this.error = err.code || 'REQUEST_FAILED';
                    this.status = err.message;
                }

                // =========================================================================
                // 【日志】请求失败时打印详细的错误信息
                // =========================================================================
                console.error('[Meting] 【日志】HTTP请求失败:', {
                    error: this.error,
                    status: this.status,
                    retriesLeft: retries
                });
                // =========================================================================

                // 重试机制
                if (retries > 0) {
                    retries--;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return makeRequest();
                } else {
                    // 向上层抛出错误，让调用方能感知到最终失败
                    throw new Error(`[Meting] Request failed after multiple retries: ${this.status}`);
                }
            }
        };

        return await makeRequest();
    }


    // ========== 公共 API 方法 ==========

    // 搜索功能
    async search(keyword, option = {}) {
        const api = this.provider.search(keyword, option);
        return await this._exec(api);
    }

    // 获取歌曲详情
    async song(id) {
        const api = this.provider.song(id);
        return await this._exec(api);
    }

    // 获取专辑信息
    async album(id) {
        const api = this.provider.album(id);
        return await this._exec(api);
    }

    // 获取艺术家作品
    async artist(id, limit = 50) {
        const api = this.provider.artist(id, limit);
        return await this._exec(api);
    }

    // 获取播放列表
    async playlist(id) {
        const api = this.provider.playlist(id);
        return await this._exec(api);
    }

    // 获取音频播放链接
    async url(id, br = 320) {
        this.temp.br = br;
        const api = this.provider.url(id, br);
        return await this._exec(api);
    }

    // 获取歌词
    async lyric(id) {
        const api = this.provider.lyric(id);
        return await this._exec(api);
    }

    // 获取封面图片
    async pic(id, size = 300) {
        return await this.provider.pic(id, size);
    }

    // ========== 静态方法 ==========

    // 获取支持的平台列表
    static getSupportedPlatforms() {
        return ProviderFactory.getSupportedPlatforms();
    }

    // 检查平台是否支持
    static isSupported(platform) {
        return ProviderFactory.isSupported(platform);
    }
}

export default Meting;