import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import PluginHost from './host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, 'config.json');

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.activePluginId = null;
        this.pluginsDir = path.resolve(__dirname, './');
    }

    // [新增] 加载配置
    async _loadConfig() {
        try {
            const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
            const config = JSON.parse(configData);
            this.activePluginId = config.activePluginId || null;
            console.log('[PluginManager] Configuration loaded.');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('[PluginManager] No config file found, using defaults.');
            } else {
                console.error('[PluginManager] Failed to load config:', error);
            }
        }
    }

    // [新增] 保存配置
    async _saveConfig() {
        try {
            const config = { activePluginId: this.activePluginId };
            await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
            console.log('[PluginManager] Configuration saved.');
        } catch (error) {
            console.error('[PluginManager] Failed to save config:', error);
        }
    }

    async initialize() {
        console.log('[PluginManager] Initializing plugins...');
        try {
            await this._loadConfig(); // [新增]
            await fs.mkdir(this.pluginsDir, { recursive: true });

            const files = await fs.readdir(this.pluginsDir);
            const pluginFiles = files.filter(file => file.endsWith('.js') && !['manager.js', 'host.js', 'utils.js'].includes(file));

            for (const file of pluginFiles) {
                const pluginId = path.basename(file, '.js');
                await this.loadPlugin(pluginId, path.join(this.pluginsDir, file));
            }

            // 如果活动的插件不存在了，则清空
            if (this.activePluginId && !this.plugins.has(this.activePluginId)) {
                this.activePluginId = null;
                await this._saveConfig();
            }

            // 如果没有活动的插件，自动选择第一个
            if (!this.activePluginId && this.plugins.size > 0) {
                this.activePluginId = this.plugins.keys().next().value;
                await this._saveConfig();
                console.log(`[PluginManager] Set active plugin to: ${this.activePluginId}`);
            }

        } catch (error) {
            console.error('[PluginManager] Failed to initialize plugins:', error);
        }
    }

    async loadPlugin(pluginId, filePath) {
        try {
            console.log(`[PluginManager] Loading plugin: ${pluginId}`);
            const pluginCode = await fs.readFile(filePath, 'utf-8');
            const host = new PluginHost(pluginCode, pluginId);
            this.plugins.set(pluginId, host);
            console.log(`[PluginManager] Plugin '${pluginId}' loaded successfully.`);
            return host;
        } catch (error) {
            console.error(`[PluginManager] Failed to load plugin '${pluginId}':`, error);
            throw error;
        }
    }

    async addPlugin(pluginCode, fileName) {
        try {
            const tempHost = new PluginHost(pluginCode, 'temp');
            const pluginName = tempHost.pluginInfo.name || path.basename(fileName, '.js');

            const uniqueId = randomBytes(8).toString('hex');
            const safePluginName = pluginName.replace(/[^a-zA-Z0-9-]/g, '_');
            const pluginId = `${safePluginName}_${uniqueId}`;
            const newFilePath = path.join(this.pluginsDir, `${pluginId}.js`);

            await fs.writeFile(newFilePath, pluginCode, 'utf-8');
            console.log(`[PluginManager] Plugin saved to: ${newFilePath}`);

            const newHost = await this.loadPlugin(pluginId, newFilePath);

            // 如果这是第一个插件，自动激活它
            if (this.plugins.size === 1) {
                this.setActivePlugin(pluginId);
            }

            return newHost;

        } catch (error) {
            console.error('[PluginManager] Failed to add plugin:', error);
            throw error;
        }
    }

    // [新增] 卸载插件
    async unloadPlugin(pluginId) {
        if (!this.plugins.has(pluginId)) {
            throw new Error(`Plugin with ID '${pluginId}' not found.`);
        }

        try {
            const filePath = path.join(this.pluginsDir, `${pluginId}.js`);
            await fs.unlink(filePath);
            this.plugins.delete(pluginId);

            if (this.activePluginId === pluginId) {
                this.activePluginId = this.plugins.size > 0 ? this.plugins.keys().next().value : null;
                await this._saveConfig();
            }

            console.log(`[PluginManager] Plugin '${pluginId}' unloaded and deleted successfully.`);
        } catch(error) {
            console.error(`[PluginManager] Failed to unload plugin '${pluginId}':`, error);
            throw error;
        }
    }

    // [新增] 设置活动插件
    setActivePlugin(pluginId) {
        if (!this.plugins.has(pluginId)) {
            throw new Error(`Cannot activate non-existent plugin: ${pluginId}`);
        }
        this.activePluginId = pluginId;
        this._saveConfig(); // 持久化选择
        console.log(`[PluginManager] Active plugin is now: ${this.activePluginId}`);
    }

    getPlugin(pluginId) {
        return this.plugins.get(pluginId);
    }

    getActivePlugin() {
        if (!this.activePluginId) {
            return null;
        }
        return this.getPlugin(this.activePluginId);
    }

    getAllPluginsInfo() {
        const info = [];
        for (const [id, host] of this.plugins.entries()) {
            info.push({
                id,
                ...host.pluginInfo,
                sources: Object.keys(host.supportedSources),
            });
        }
        return info;
    }
}

const pluginManager = new PluginManager();
export default pluginManager;