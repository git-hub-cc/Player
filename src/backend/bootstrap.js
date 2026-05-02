import { DIContainer } from './container.js';
import * as setupService from './services/setup-service.js';
import { DownloadService } from './services/download-service.js';
import { LibraryService } from './services/library-service.js';
import { OnlineService } from './services/online-service.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import { MusicApiService } from './services/music-api-service.js';

export function updateCoreToolPaths(container, ffmpegPath, ytDlpPath) {
    console.log(`[Bootstrap] updateCoreToolPaths invoked with -> FFmpeg: ${ffmpegPath}, yt-dlp: ${ytDlpPath}`);
    
    if (ffmpegPath) {
        container.get('libraryService').setFfmpegPath(ffmpegPath);
        container.get('downloadService').updateToolPath('ffmpeg', ffmpegPath);
        container.registerValue('ffmpegPath', ffmpegPath);
        console.log('[Bootstrap] FFmpeg path updated in DI Container and services.');
    }
    
    if (ytDlpPath) {
        container.get('downloadService').updateToolPath('yt-dlp', ytDlpPath);
        container.registerValue('ytDlpPath', ytDlpPath);
        console.log('[Bootstrap] yt-dlp path updated in DI Container and services.');
    }
}

export async function configureContainer(app, sendMessageFunc) {
    console.log('[Bootstrap] Starting DI Container configuration...');

    const container = new DIContainer();

    const setupResult = await setupService.initializeApp(app);
    const { config, ffmpegPath, ytDlpPath, systemProxy } = setupResult;

    console.log('[Bootstrap] Registering base values and configuration...');
    container.registerValue('config', config);
    container.registerValue('ffmpegPath', ffmpegPath);
    container.registerValue('ytDlpPath', ytDlpPath);
    container.registerValue('systemProxy', systemProxy);
    container.registerValue('sendMessageFunc', sendMessageFunc);
    console.log('[Bootstrap] Base values registered.');

    console.log('[Bootstrap] Registering all application services...');

    container.register(
        'providerRegistry',
        ProviderRegistry,
        ['config', 'sendMessageFunc', 'ffmpegPath', 'ytDlpPath', 'systemProxy', 'libraryService']
    );

    container.register(
        'downloadService',
        DownloadService,
        ['providerRegistry']
    );

    container.register(
        'libraryService',
        LibraryService,
        ['config', 'ffmpegPath']
    );

    container.register(
        'musicApiService',
        MusicApiService,
        ['config', 'systemProxy']
    );

    container.register(
        'onlineService',
        OnlineService,
        ['config', 'sendMessageFunc', 'libraryService', 'musicApiService']
    );

    console.log('[Bootstrap] All services registered.');
    console.log('[Bootstrap] DI Container configured successfully!');

    return container;
}