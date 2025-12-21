// src/backend/providers/provider-registry.js

// --- 导入所有具体的下载策略 (Provider) ---
import { BilibiliProvider } from './bilibili.js';
import { DouyinProvider } from './douyin.js';
import { JableProvider } from './jable.js';
import { YoutubeProvider } from './youtube.js';
// =========================================================================
// 【核心新增】导入 IyfProvider
// =========================================================================
import { IyfProvider } from './iyf.js';


/**
 * @class ProviderRegistry
 * @description 扮演“策略注册表”的角色。
 *              负责集中管理和初始化所有可用的下载服务提供者 (Provider)。
 *              该类由 DI 容器实例化。
 */
export class ProviderRegistry {
    // #dependencies 存储所有 Provider 共享的依赖项
    #dependencies;
    // #initializedProviders 存储所有已实例化的 Provider
    #initializedProviders = [];

    /**
     * @param {object} config - 应用的全局配置。
     * @param {function} sendMessageFunc - 向渲染进程发送消息的回调函数。
     * @param {string|null} ffmpegPath - FFmpeg 的可执行文件路径。
     * @param {string|null} ytDlpPath - yt-dlp 的可执行文件路径。
     * @param {string|null} systemProxy - 系统代理设置。
     * @param {import('../services/library-service.js').LibraryService} libraryService - 媒体库服务实例。
     */
    constructor(config, sendMessageFunc, ffmpegPath, ytDlpPath, systemProxy, libraryService) {
        this.#dependencies = {
            config,
            sendMessageFunc,
            ffmpegPath,
            ytDlpPath,
            systemProxy,
            libraryService, // 将 libraryService 也作为依赖项
        };
    }

    /**
     * 初始化所有已知的 Provider。
     * 此函数现在由 DownloadService 的构造函数调用。
     */
    initializeProviders() {
        if (this.#initializedProviders.length > 0) {
            console.warn('[Provider Registry] 注册表已被初始化，跳过重复操作。');
            return;
        }

        console.log('[Provider Registry] 正在初始化所有下载服务提供者...');
        const ProviderClasses = [
            // =========================================================================
            // 【核心修改】将 IyfProvider 添加到注册列表
            // =========================================================================
            BilibiliProvider, DouyinProvider, JableProvider, YoutubeProvider, IyfProvider
        ];

        ProviderClasses.forEach(ProviderClass => {
            try {
                // 实例化每个 Provider 并传入通用依赖
                const providerInstance = new ProviderClass(this.#dependencies);
                this.#initializedProviders.push(providerInstance);
                console.log(`  - [OK] ${ProviderClass.name} 已成功实例化。`);
            } catch (error) {
                console.error(`  - [ERROR] 实例化 ${ProviderClass.name} 失败:`, error);
            }
        });
        console.log('[Provider Registry] 所有提供者初始化完成。');
    }

    /**
     * 根据给定的 URL 查找能够处理它的第一个 Provider。
     * @param {string} url - 用户输入的 URL。
     * @returns {import('./base-provider.js').BaseProvider | null} - 返回匹配的 Provider 实例，如果未找到则返回 null。
     */
    findProviderFor(url) {
        if (!url) return null;
        for (const provider of this.#initializedProviders) {
            if (provider.isApplicable(url)) {
                return provider;
            }
        }
        return null;
    }

    /**
     * 在按需下载工具成功后，更新所有 Provider 实例中的工具路径。
     * @param {'ffmpeg' | 'yt-dlp'} toolName - 工具名称。
     * @param {string} newPath - 新的路径。
     */
    updateToolPath(toolName, newPath) {
        const propName = toolName === 'ffmpeg' ? 'ffmpegPath' : 'ytDlpPath';
        this.#dependencies[propName] = newPath; // 更新共享依赖
        this.#initializedProviders.forEach(provider => {
            provider[propName] = newPath; // 直接更新已实例化 Provider 的属性
        });
    }
}