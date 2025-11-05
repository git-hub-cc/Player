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

        const nameMatch = this.pluginCode.match(/@name\s+(.+)/);
        const authorMatch = this.pluginCode.match(/@author\s+(.+)/);
        const versionMatch = this.pluginCode.match(/@version\s+(.+)/);
        const descriptionMatch = this.pluginCode.match(/@description\s+(.+)/);

        const realPluginName = nameMatch ? nameMatch[1].trim() : '未知插件';
        const realPluginAuthor = authorMatch ? authorMatch[1].trim() : '未知作者';
        const realPluginVersion = versionMatch ? versionMatch[1].trim() : '1.0.0';
        const realPluginDesc = descriptionMatch ? descriptionMatch[1].trim() : '无描述';

        const mockLx = {
            EVENT_NAMES: { request: 'request', inited: 'inited' },
            on: (event, handler) => {
                if (event === 'request') this.requestHandler = handler;
            },
            send: (event, data) => {
                if (event === 'inited' && data.sources) this.supportedSources = data.sources;
            },
            request: request,
            utils: utils,
            env: 'node',
            version: '1.0.0',
            currentScriptInfo: {
                name: realPluginName,
                description: realPluginDesc,
                rawScript: this.pluginCode,
                author: realPluginAuthor,
                version: realPluginVersion,
            }
        };

        const sandbox = { globalThis: { lx: mockLx }, console: console };

        try {
            vm.runInNewContext(this.pluginCode, sandbox);
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

    async getMusicUrl(musicInfo, quality) {
        if (!this.requestHandler) throw new Error('Plugin is not ready or does not handle requests.');
        const source = musicInfo.source;
        try {
            const result = await this.requestHandler({
                source: source,
                action: 'musicUrl',
                info: { musicInfo, type: quality },
            });
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