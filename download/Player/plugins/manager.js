import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import PluginHost from './host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.activePluginId = null;
        this.pluginsDir = path.resolve(__dirname, './');
    }

    async initialize() {
        console.log('[PluginManager] Initializing plugins...');
        try {
            await fs.mkdir(this.pluginsDir, { recursive: true });

            const files = await fs.readdir(this.pluginsDir);
            const pluginFiles = files.filter(file => file.endsWith('.js') && !['manager.js', 'host.js', 'utils.js'].includes(file));

            for (const file of pluginFiles) {
                const pluginId = path.basename(file, '.js');
                await this.loadPlugin(pluginId, path.join(this.pluginsDir, file));
            }

            // 如果没有活动的插件，自动选择第一个
            if (!this.activePluginId && this.plugins.size > 0) {
                this.activePluginId = this.plugins.keys().next().value;
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