// src/backend/bootstrap.js

import { DIContainer } from './container.js';
import * as setupService from './services/setup-service.js';
import { DownloadService } from './services/download-service.js';
import { LibraryService } from './services/library-service.js';
import { OnlineService } from './services/online-service.js';
import { ProviderRegistry } from './providers/provider-registry.js';
// 【核心新增】导入新的 MusicApiService
import { MusicApiService } from './services/music-api-service.js';

/**
 * @module bootstrap
 * @description 应用的“组合根”(Composition Root)。
 *              负责配置 DI 容器，集中管理所有服务的创建和依赖关系。
 *              这是应用后端启动时进行服务“装配”的唯一入口。
 */

/**
 * 配置并返回一个完全初始化的 DI 容器。
 * @param {import('electron').App} app - Electron 的 app 实例。
 * @param {function} sendMessageFunc - 一个用于向渲染进程发送消息的回调函数。
 * @returns {Promise<DIContainer>} - 返回一个已配置好的 DI 容器实例。
 */
export async function configureContainer(app, sendMessageFunc) {
    console.log('[Bootstrap] Starting DI Container configuration...');

    const container = new DIContainer();

    // --- 1. 运行初始设置，获取基础依赖值 ---
    const setupResult = await setupService.initializeApp(app);
    const { config, ffmpegPath, ytDlpPath, systemProxy } = setupResult;

    // --- 2. 将基础值和回调函数注册到容器中 ---
    console.log('[Bootstrap] Registering base values and configuration...');
    container.registerValue('config', config);
    container.registerValue('ffmpegPath', ffmpegPath);
    container.registerValue('ytDlpPath', ytDlpPath);
    container.registerValue('systemProxy', systemProxy);
    container.registerValue('sendMessageFunc', sendMessageFunc);
    console.log('[Bootstrap] Base values registered.');

    // --- 3. 注册所有服务及其依赖关系 ---
    // 注册顺序不重要，容器会自动解析依赖树。
    console.log('[Bootstrap] Registering all application services...');

    // `ProviderRegistry` 作为 `DownloadService` 的一个依赖被注册
    container.register(
        'providerRegistry',
        ProviderRegistry,
        ['config', 'sendMessageFunc', 'ffmpegPath', 'ytDlpPath', 'systemProxy', 'libraryService']
    );

    // `DownloadService` 依赖 `ProviderRegistry`
    container.register(
        'downloadService',
        DownloadService,
        ['providerRegistry']
    );

    // `LibraryService` 是一个核心服务，被其他服务依赖
    container.register(
        'libraryService',
        LibraryService,
        ['config', 'ffmpegPath']
    );

    // =========================================================================
    // 【核心新增】注册新的 MusicApiService
    // 它负责所有与在线音乐平台（通过 Meting）的交互。
    // =========================================================================
    container.register(
        'musicApiService',
        MusicApiService,
        ['config', 'systemProxy']
    );
    // =========================================================================

    // =========================================================================
    // 【核心修改】为 OnlineService 注入新的 MusicApiService
    // =========================================================================
    // `OnlineService` 现在依赖 `musicApiService` 来处理在线搜索和资源获取，
    // 同时保留对 `libraryService` 的依赖以生成占位图。
    container.register(
        'onlineService',
        OnlineService,
        // 注入 'musicApiService'，替换原来对 gdstudio 的直接依赖
        ['config', 'sendMessageFunc', 'libraryService', 'musicApiService']
    );
    // =========================================================================

    console.log('[Bootstrap] All services registered.');
    console.log('[Bootstrap] DI Container configured successfully!');

    return container;
}