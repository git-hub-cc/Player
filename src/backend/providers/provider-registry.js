// src/backend/providers/provider-registry.js

// --- 导入专用下载策略 (Specialized Providers) ---
// 这些 Provider 针对特定网站进行了优化，拥有更高的优先级。
import { DouyinProvider } from './douyin.js';
import { JableProvider } from './jable.js';
import { IyfProvider } from './iyf.js';

// --- 导入新增通用策略 ---
// M3U8 直链：匹配以 .m3u8 结尾的 URL，直接用 yt-dlp 下载
import { M3u8DirectProvider } from './m3u8-direct.js';
// 浏览器拦截：对任意未匹配的网页启动虚拟浏览器，拦截 m3u8 后下载
import { BrowserInterceptProvider } from './browser-intercept.js';

// --- 导入通用下载策略 (Generic Provider) ---
// 该 Provider 基于 yt-dlp，支持成千上万个网站，作为最后的兜底策略。
import { GenericYtDlpProvider } from './generic-ytdlp.js';



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
            console.warn('[Provider Registry] Registry already initialized, skipping duplicate operation.');
            return;
        }

        console.log('[Provider Registry] Initializing all download providers...');

        // =========================================================================
        // 注册顺序（优先级从高到低）：
        // 1. 专用 Provider（抖音、Jable、IYF）—— 精确匹配特定域名
        // 2. M3u8DirectProvider —— 输入链接本身是 .m3u8 直链
        // 3. BrowserInterceptProvider —— 通用浏览器拦截（对未匹配网页且非 yt-dlp 原生支持的链接）
        //      → isApplicable 内部会自动排除 Bilibili、YouTube 等 yt-dlp 已知站点
        // 4. GenericYtDlpProvider —— 最终兜底（Bilibili、YouTube 等 yt-dlp 原生支持平台）
        // =========================================================================
        const ProviderClasses = [
            DouyinProvider,
            JableProvider,
            IyfProvider,
            M3u8DirectProvider,
            BrowserInterceptProvider,
            GenericYtDlpProvider
        ];

        ProviderClasses.forEach(ProviderClass => {
            try {
                // 实例化每个 Provider 并传入通用依赖
                const providerInstance = new ProviderClass(this.#dependencies);
                this.#initializedProviders.push(providerInstance);
                console.log(`- [OK] ${ProviderClass.name} instantiated successfully.`);
            } catch (error) {
                console.error(`- [FAILED] Failed to instantiate ${ProviderClass.name}:`, error);
            }
        });
        console.log('[Provider Registry] All providers initialization complete.');
    }

    /**
     * 根据给定的 URL 查找能够处理它的第一个 Provider。
     * 按照注册顺序依次检查 isApplicable()。
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