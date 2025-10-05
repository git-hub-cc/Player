import vm from 'node:vm';
import { request, utils } from './utils.js';

class PluginHost {
    constructor(pluginCode, pluginId) {
        this.pluginCode = pluginCode;
        this.pluginId = pluginId;
        this.requestHandler = null;
        this.pluginInfo = {};
        this.supportedSources = {};
        this._initialize();
    }

    _initialize() {
        if (!this.pluginCode) {
            throw new Error('Plugin code is empty.');
        }

        // --- [核心修改] ---
        // 1. 在运行插件前，先从代码字符串中动态解析元信息
        const nameMatch = this.pluginCode.match(/@name\s+(.+)/);
        const authorMatch = this.pluginCode.match(/@author\s+(.+)/);
        const versionMatch = this.pluginCode.match(/@version\s+(.+)/);
        const descriptionMatch = this.pluginCode.match(/@description\s+(.+)/);

        const realPluginName = nameMatch ? nameMatch[1].trim() : '未知插件';
        const realPluginAuthor = authorMatch ? authorMatch[1].trim() : '未知作者';
        const realPluginVersion = versionMatch ? versionMatch[1].trim() : '1.0.0';
        const realPluginDesc = descriptionMatch ? descriptionMatch[1].trim() : '无描述';
        // --------------------

        // 模拟的 lx 全局对象
        const mockLx = {
            EVENT_NAMES: {
                request: 'request',
                inited: 'inited',
            },
            on: (event, handler) => {
                if (event === 'request') {
                    console.log(`[PluginHost] Plugin '${this.pluginId}' registered request handler.`);
                    this.requestHandler = handler;
                }
            },
            send: (event, data) => {
                if (event === 'inited' && data.sources) {
                    console.log(`[PluginHost] Plugin '${this.pluginId}' initialized with sources.`);
                    this.supportedSources = data.sources;
                }
            },
            request: request,
            utils: utils,
            env: 'node',
            version: '1.0.0', // 模拟一个版本号

            // --- [核心修改] ---
            // 2. 将动态解析出的真实信息注入到 currentScriptInfo 中
            currentScriptInfo: {
                name: realPluginName,
                description: realPluginDesc,
                rawScript: this.pluginCode,
                // 为了更完整地模拟，也把 author 和 version 加上
                author: realPluginAuthor,
                version: realPluginVersion,
            }
            // --------------------
        };

        const sandbox = {
            globalThis: {
                lx: mockLx,
            },
            console: console,
        };

        try {
            // 在安全的沙箱环境中运行插件代码
            vm.runInNewContext(this.pluginCode, sandbox);

            // 使用解析出的信息来填充插件的元数据
            this.pluginInfo = {
                name: realPluginName,
                author: realPluginAuthor,
                version: realPluginVersion,
                description: realPluginDesc,
            };

        } catch (error) {
            console.error(`[PluginHost] Error executing plugin '${this.pluginId}':`, error);
            throw new Error('Failed to initialize plugin script.');
        }
    }

    /**
     * 调用插件获取音乐 URL.
     * 这是暴露给插件管理器的标准接口.
     * @param {object} musicInfo - 歌曲信息.
     * @param {string} quality - 期望的音质.
     * @returns {Promise<string>} 音乐的真实 URL.
     */
    async getMusicUrl(musicInfo, quality) {
        if (!this.requestHandler) {
            throw new Error('Plugin is not ready or does not handle requests.');
        }

        // LX 插件通常从 musicInfo 中直接获取 source, 无需单独传递
        const source = musicInfo.source;

        try {
            // 调用之前捕获的 LX 插件的请求处理器
            const result = await this.requestHandler({
                source: source,
                action: 'musicUrl',
                info: {
                    musicInfo: musicInfo,
                    type: quality,
                },
            });

            // 有些插件可能返回一个包含 url 的对象
            const url = (typeof result === 'object' && result.url) ? result.url : result;

            if (typeof url !== 'string' || !url.startsWith('http')) {
                throw new Error(`Plugin returned invalid URL: ${JSON.stringify(result)}`);
            }

            return url;

        } catch (error) {
            console.error(`[PluginHost] Plugin '${this.pluginId}' failed to get music URL:`, error);
            throw error;
        }
    }
}

export default PluginHost;