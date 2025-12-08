// src/backend/main-api.js

import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, globalShortcut, shell, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import fs from 'fs';

// --- 导入新的服务模块 ---
import * as setupService from './services/setup-service.js';
import * as libraryService from './services/library-service.js';
import * as onlineService from './services/online-service.js';
import * as downloadService from './services/download-service.js';

// --- 全局变量 ---
let mainWindow;
let CONFIG = {};

// 处理 Windows 上的快捷方式创建/删除
if (started) {
    app.quit();
}

/**
 * 向渲染进程发送消息。
 * @param {string} type - 消息类型 (IPC 频道)。
 * @param {any} data - 要发送的数据。
 */
function sendMessage(type, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(type, data);
    }
}

/**
 * 创建主应用窗口。
 */
const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 940,
        minHeight: 600,
        darkTheme: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            contextIsolation: true,
            webSecurity: false,
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        // =========================================================================
        // 【核心修改】在开发模式下自动打开开发者工具
        // 这行代码利用了 Vite 插件提供的全局变量 `MAIN_WINDOW_VITE_DEV_SERVER_URL`
        // 来判断当前是否处于开发环境。
        // { mode: 'detach' } 会将开发者工具作为一个独立的窗口打开，避免挤占应用界面。
        // =========================================================================
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../renderer/main_window/index.html'));
    }

    mainWindow.on('enter-full-screen', () => sendMessage('fullscreen-change', true));
    mainWindow.on('leave-full-screen', () => sendMessage('fullscreen-change', false));
};

/**
 * 注册所有 IPC 监听器。
 */
function registerIpcHandlers() {
    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (event, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (event, dirPath) => libraryService.handleLocalImport(dirPath, sendMessage));
    ipcMain.on('open-media-folder', () => libraryService.handleOpenMediaFolder());
    ipcMain.handle('search-online', (event, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (event, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (event, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.on('cache-track', (event, trackData) => onlineService.handleCacheRequest(trackData));
    ipcMain.on('download-douyin', (event, data) => downloadService.handleDownloadRequest(data));
    ipcMain.on('toggle-fullscreen', (event, state) => {
        if (mainWindow) {
            mainWindow.setFullScreen(state);
        }
    });
    ipcMain.on('show-user-data', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });
}

/**
 * 应用主入口点。
 */
app.whenReady().then(async () => {
    if (app.isPackaged) {
        try {
            const userDataPath = app.getPath('userData');
            const logDir = path.join(userDataPath, 'logs');
            if (!fs.existsSync(logDir)){
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFileName = `main-${new Date().toISOString().replace(/:/g, '-')}.log`;
            const logFilePath = path.join(logDir, logFileName);
            const logFile = fs.createWriteStream(logFilePath, { flags: 'w' });
            process.stdout.write = process.stderr.write = logFile.write.bind(logFile);
            process.on('uncaughtException', (err) => {
                console.error('未捕获的异常:', err);
                console.error(err.stack);
            });
            console.log(`日志文件位于: ${logFilePath}`);
            console.log('主进程日志记录已启动...');
        } catch (error) {
            dialog.showErrorBox('日志初始化失败', `无法创建日志文件。\n错误: ${error.message}\n应用将继续运行，但不会记录日志。`);
        }
    }

    console.log(`[Main API] 应用启动，app.isPackaged = ${app.isPackaged}`);

    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    try {
        const { config, ffmpegPath, ytDlpPath, systemProxy } = await setupService.initializeApp(app);
        CONFIG = config;

        console.log(`[Main API] 从 setup-service 接收到的路径:`);
        console.log(`  - FFmpeg: ${ffmpegPath}`);
        console.log(`  - yt-dlp: ${ytDlpPath}`);
        console.log(`  - Proxy: ${systemProxy}`);

        const serviceInitParams = { config, ffmpegPath, ytDlpPath, systemProxy, sendMessageFunc: sendMessage };
        console.log('[Main API] 准备使用以下参数初始化所有服务:', JSON.stringify(serviceInitParams, null, 2));

        // =========================================================================
        // 【核心修改】将 ffmpegPath 传递给 libraryService.init
        // 这对于本地导入视频时自动截图是必需的。
        // =========================================================================
        libraryService.init(CONFIG, ffmpegPath);

        onlineService.init(CONFIG, sendMessage);
        downloadService.init(serviceInitParams);

    } catch (error) {
        console.error('[Main API] 初始化外部工具和服务时发生严重错误:', error);
        dialog.showErrorBox(
            '应用初始化失败',
            `启动应用所需的核心组件时发生错误。\n\n详情: ${error.message}\n\n应用即将退出。`
        );
        app.quit();
        return;
    }

    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        const decodedUrl = decodeURIComponent(url);
        const filePath = path.join(CONFIG.MEDIA_ROOT, decodedUrl);
        callback({ path: path.normalize(filePath) });
    });

    registerIpcHandlers();
    createWindow();

    globalShortcut.register('CommandOrControl+Shift+I', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const webContents = mainWindow.webContents;
            if (webContents.isDevToolsOpened()) {
                webContents.closeDevTools();
            } else {
                webContents.openDevTools({ mode: 'detach' });
            }
        }
    });

    globalShortcut.register('CommandOrControl+Shift+L', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '日志目录',
            message: `日志文件和下载的工具位于以下目录中的 'logs' 和 'bin' 文件夹内：\n\n${userDataPath}`
        });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});