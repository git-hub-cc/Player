// src/backend/main-api.js

import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, globalShortcut, shell, dialog, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import fs from 'fs';
import { configureContainer } from './bootstrap.js'; // 导入 DI 容器配置函数
import * as setupService from './services/setup-service.js'; // 仅用于下载工具

// --- 全局变量 ---
let mainWindow;
let diContainer; // 用于持有 DI 容器的实例
let initialFileToOpen = null; // 用于存储应用启动时需要打开的文件路径

// --- 常量配置 ---
const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetch: true, corsEnabled: true } }
]);

if (started) {
    app.quit();
}

// =========================================================================
// 【文件关联】核心逻辑
// =========================================================================
function findFilePathInArgs(argv) {
    const potentialPath = argv.slice(app.isPackaged ? 1 : 2).find(arg =>
        !arg.startsWith('-') && fs.existsSync(arg)
    );
    return potentialPath || null;
}

function sendFileToRenderer(filePath) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('open-file', filePath);
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
// =========================================================================

function sendMessage(type, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(type, data);
    }
}

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, minWidth: 940, minHeight: 600,
        darkTheme: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true, contextIsolation: true, webSecurity: true,
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

    // --- 媒体库相关 ---
    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (_, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (_, dirPath) => libraryService.handleLocalImport(dirPath, sendMessage));
    ipcMain.on('open-media-folder', () => libraryService.handleOpenMediaFolder());

    // --- 在线服务相关 ---
    ipcMain.handle('search-online', (_, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (_, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    // =========================================================================
    // 【核心新增】注册用于获取会员歌曲正式URL的IPC处理器
    // =========================================================================
    ipcMain.handle('get-vip-music-url', (_, trackInfo) => onlineService.handleGetVipMusicUrl(trackInfo));
    // =========================================================================
    ipcMain.handle('get-lrc-content', (_, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.on('cache-track', (_, trackData) => onlineService.handleCacheRequest(trackData));
    ipcMain.handle('get-online-lyric', (_, trackInfo) => onlineService.handleGetOnlineLyric(trackInfo));

    // --- 下载与工具相关 ---
    ipcMain.on('download-douyin', (_, data) => downloadService.handleDownloadRequest(data));
    ipcMain.handle('separate-video', (_, trackData) => libraryService.handleSeparateVideo(trackData));
    ipcMain.handle('handle-file-drop', (_, files) => libraryService.handleDroppedFiles(files, sendMessage));

    // --- 窗口控制 ---
    ipcMain.on('toggle-fullscreen', (_, state) => mainWindow?.setFullScreen(state));
    ipcMain.on('show-user-data', () => shell.openPath(app.getPath('userData')));

    // --- 工具下载 ---
    ipcMain.handle('download-core-tool', async (_, toolName) => {
        try {
            const binDir = config.BIN_DIR;
            let newPath;
            if (toolName === 'ffmpeg') {
                newPath = await setupService.downloadFfmpeg(binDir, sendMessage);
                downloadService.updateToolPath('ffmpeg', newPath);
                libraryService.setFfmpegPath(newPath);
            } else if (toolName === 'yt-dlp') {
                newPath = await setupService.downloadYtDlp(binDir, sendMessage);
                downloadService.updateToolPath('yt-dlp', newPath);
            } else { throw new Error(`未知的工具名称: ${toolName}`); }
            return { success: true, path: newPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // --- 打开工具目录 ---
    ipcMain.handle('open-tools-folder', () => {
        const binDir = config.BIN_DIR;
        if (binDir) shell.openPath(binDir);
        return !!binDir;
    });
}

function setupLogging() {
    if (!app.isPackaged) return;
    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFileName = `main-${new Date().toISOString().replace(/:/g, '-')}.log`;
        const logFile = fs.createWriteStream(path.join(logDir, logFileName), { flags: 'w' });
        process.stdout.write = process.stderr.write = logFile.write.bind(logFile);
        process.on('uncaughtException', (err) => console.error('未捕获的异常:', err, err.stack));
        console.log('主进程日志记录已启动...');
    } catch (error) {
        dialog.showErrorBox('日志初始化失败', `错误: ${error.message}`);
    }
}

function registerGlobalShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools());
    globalShortcut.register('CommandOrControl+Shift+L', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, { type: 'info', title: '日志与工具目录', message: `数据目录位于:\n\n${userDataPath}` });
        }
    });
}

app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = SPOOF_USER_AGENT;
        delete details.requestHeaders['X-Electron-Version'];
        delete details.requestHeaders['Electron'];
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    console.log('[Main API] 全局 User-Agent 伪装已激活。');

    setupLogging();
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    try {
        diContainer = await configureContainer(app, sendMessage);
    } catch (error) {
        console.error('[Main API] DI 容器配置失败，应用无法启动:', error);
        dialog.showErrorBox('应用初始化失败', `启动核心服务失败: ${error.message}\n\n应用即将退出。`);
        app.quit();
        return;
    }

    const config = diContainer.get('config');
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        const filePath = path.join(config.MEDIA_ROOT, decodeURIComponent(url));
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