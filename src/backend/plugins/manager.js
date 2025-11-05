import fs from 'fs/promises';
import path from 'path';
import PluginHost from './host.js';

class PluginManager {
    constructor() {
        this.plugins = new Map();
        this.activePluginId = null;
        this.pluginsDir = '';
    }

    async initialize(pluginsDirectory) {
        this.pluginsDir = pluginsDirectory;
        console.log(`[PluginManager] Initializing plugins from: ${this.pluginsDir}`);
        try {
            // Note: Directory is already created by main-api.js
            const files = await fs.readdir(this.pluginsDir);
            const pluginFiles = files.filter(file => file.endsWith('.js') && !['manager.js', 'host.js', 'utils.js'].includes(file));

            if (pluginFiles.length === 0) {
                console.log('[PluginManager] No plugins found.');
                // Here you could automatically download a default plugin if needed.
                return;
            }

            for (const file of pluginFiles) {
                const pluginId = path.basename(file, '.js');
                await this.loadPlugin(pluginId, path.join(this.pluginsDir, file));
            }

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
        }
    }

    getPlugin(pluginId) {
        return this.plugins.get(pluginId);
    }

    getActivePlugin() {
        return this.activePluginId ? this.getPlugin(this.activePluginId) : null;
    }

    getAllPluginsInfo() {
        return Array.from(this.plugins.entries()).map(([id, host]) => ({
            id,
            ...host.pluginInfo,
            sources: Object.keys(host.supportedSources),
        }));
    }
}

const pluginManager = new PluginManager();
export default pluginManager;