import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, globalShortcut, shell, dialog, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import fs from 'fs';
import { execFileSync } from 'node:child_process';
import { configureContainer, updateCoreToolPaths } from './bootstrap.js';
import * as setupService from './services/setup-service.js';
import { EnvChecker } from './env-checker.js';

let mainWindow;
let diContainer;
let initialFileToOpen = null;

const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function configureWindowsConsoleEncoding() {
    if (process.platform !== 'win32') return;

    try {
        execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
        process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || '1';
        process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8';
    } catch {
        // If the app is launched without a console, there is nothing to configure.
    }
}

configureWindowsConsoleEncoding();

protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetch: true, corsEnabled: true } }
]);

if (started) {
    app.quit();
}

function findFilePathInArgs(argv) {
    const potentialPath = argv.slice(app.isPackaged ? 1 : 2).find(arg =>
        !arg.startsWith('-') && fs.existsSync(arg)
    );
    return potentialPath || null;
}

function sendFileToRenderer(filePath) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('open-file', filePath);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    } else {
        initialFileToOpen = filePath;
    }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            const filePath = findFilePathInArgs(commandLine);
            if (filePath) sendFileToRenderer(filePath);
        }
    });

    const initialFilePath = findFilePathInArgs(process.argv);
    if (initialFilePath) initialFileToOpen = initialFilePath;
}

function sendMessage(type, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(type, data);
    }
}

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 940,
        minHeight: 600,

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            contextIsolation: true,
            webSecurity: true, 
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../renderer/main_window/index.html'));
    }

    mainWindow.webContents.on('did-finish-load', () => {
        if (initialFileToOpen) {
            sendFileToRenderer(initialFileToOpen);
            initialFileToOpen = null;
        }
    });

    mainWindow.on('enter-full-screen', () => sendMessage('fullscreen-change', true));
    mainWindow.on('leave-full-screen', () => sendMessage('fullscreen-change', false));
};

function registerIpcHandlers() {
    const libraryService = diContainer.get('libraryService');
    const onlineService = diContainer.get('onlineService');
    const downloadService = diContainer.get('downloadService');
    const config = diContainer.get('config');

    ipcMain.handle('check-env', async () => {
        console.log('[Main API] IPC "check-env" triggered.');
        const checker = new EnvChecker(sendMessage, config.BIN_DIR);
        const result = await checker.checkAndInstall();
        console.log('[Main API] EnvChecker result:', result);
        
        updateCoreToolPaths(diContainer, result.paths['ffmpeg'], result.paths['yt-dlp']);
        
        return result.allReady;
    });

    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (_, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (_, dirPath, shouldCopy) => libraryService.handleLocalImport(dirPath, sendMessage, shouldCopy));
    ipcMain.on('open-media-folder', (_, type, trackSrc) => libraryService.handleOpenMediaFolder(type, trackSrc));
    ipcMain.handle('separate-video', (_, trackData) => libraryService.handleSeparateVideo(trackData));
    ipcMain.handle('handle-file-drop', (_, files, shouldCopy) => libraryService.handleDroppedFiles(files, sendMessage, shouldCopy));
    ipcMain.handle('change-media-directory', () => libraryService.handleChangeMediaDirectory());
    ipcMain.handle('cleanup-missing-tracks', () => libraryService.cleanupMissingTracks());

    ipcMain.handle('search-online', (_, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (_, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-vip-music-url', (_, trackInfo) => onlineService.handleGetVipMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (_, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.handle('get-online-lyric', (_, trackInfo) => onlineService.handleGetOnlineLyric(trackInfo));
    ipcMain.on('cache-track', (_, trackData) => onlineService.handleCacheRequest(trackData));

    ipcMain.on('download-douyin', (_, data) => downloadService.handleDownloadRequest(data));

    ipcMain.on('cancel-download', (_, { id, type }) => {
        if (type === 'url-download') {
            downloadService.cancelCurrentTask();
        } else if (type === 'cache-download') {
            onlineService.cancelTask(id);
        }
    });

    ipcMain.handle('download-core-tool', async (_, toolName) => {
        try {
            const binDir = config.BIN_DIR;
            let newPath;
            if (toolName === 'ffmpeg') {
                newPath = await setupService.downloadFfmpeg(binDir, sendMessage);
                updateCoreToolPaths(diContainer, newPath, null);
            } else if (toolName === 'yt-dlp') {
                newPath = await setupService.downloadYtDlp(binDir, sendMessage);
                updateCoreToolPaths(diContainer, null, newPath);
            } else { throw new Error(`未知的工具名称: ${toolName}`); }
            return { success: true, path: newPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('check-core-tools', () => {
        console.log('[Main API] IPC "check-core-tools" triggered.');
        const ffmpegPath = diContainer.get('ffmpegPath');
        const ytDlpPath = diContainer.get('ytDlpPath');
        console.log(`[Main API] Current DI Container states -> FFmpeg: ${ffmpegPath}, yt-dlp: ${ytDlpPath}`);
        return {
            ffmpeg: { exists: !!ffmpegPath, path: ffmpegPath || '--' },
            ytDlp: { exists: !!ytDlpPath, path: ytDlpPath || '--' }
        };
    });

    ipcMain.handle('open-tools-folder', (_, targetPath) => {
        if (targetPath && fs.existsSync(targetPath)) {
            shell.showItemInFolder(targetPath);
            return true;
        } else if (config.BIN_DIR && fs.existsSync(config.BIN_DIR)) {
            shell.openPath(config.BIN_DIR);
            return true;
        }
        return false;
    });

    ipcMain.on('toggle-fullscreen', (_, state) => mainWindow?.setFullScreen(state));
    ipcMain.on('show-user-data', () => shell.openPath(app.getPath('userData')));
}

function setupLogging() {
    if (!app.isPackaged) return;
    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFileName = `main-${new Date().toISOString().replace(/:/g, '-')}.log`;
        const logFile = fs.createWriteStream(path.join(logDir, logFileName), { flags: 'w' });
        process.stdout.write = process.stderr.write = logFile.write.bind(logFile);
        process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err, err.stack));
        console.log('Main process logging started...');
    } catch (error) {
        dialog.showErrorBox('日志初始化失败', `错误: ${error.message}`);
    }
}

function registerGlobalShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools());
    globalShortcut.register('CommandOrControl+Shift+L', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });
}

app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = SPOOF_USER_AGENT;
        delete details.requestHeaders['X-Electron-Version']; 
        delete details.requestHeaders['Electron'];
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    console.log('[Main API] Global User-Agent spoofing activated.');

    setupLogging();

    nativeTheme.themeSource = 'dark';

    Menu.setApplicationMenu(null);

    try {
        diContainer = await configureContainer(app, sendMessage);
    } catch (error) {
        console.error('[Main API] DI Container configuration failed, app cannot start:', error);
        dialog.showErrorBox('App Initialization Failed', `Failed to start core services: ${error.message}\n\nApp will exit.`);
        app.quit();
        return;
    }

    const config = diContainer.get('config');
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = decodeURIComponent(request.url.substring('media://'.length));
        let filePath;
        if (path.isAbsolute(url) || /^[a-zA-Z]:/.test(url)) {
            filePath = url;
        } else {
            filePath = path.join(config.MEDIA_ROOT, url);
        }
        callback({ path: path.normalize(filePath) });
    });

    registerIpcHandlers();
    createWindow();
    registerGlobalShortcuts();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});
