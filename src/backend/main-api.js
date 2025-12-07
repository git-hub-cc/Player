// src/backend/main-api.js

import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

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
        darkTheme: true, // 尝试在 Windows 上启用原生深色标题栏
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            contextIsolation: true,
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    // 在开发模式下自动打开开发者工具
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }

    // 监听窗口的全屏事件，并通知渲染进程
    mainWindow.on('enter-full-screen', () => sendMessage('fullscreen-change', true));
    mainWindow.on('leave-full-screen', () => sendMessage('fullscreen-change', false));
};

/**
 * 注册所有 IPC 监听器。
 */
function registerIpcHandlers() {
    // --- Library Service ---
    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (event, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (event, dirPath) => libraryService.handleLocalImport(dirPath, sendMessage));
    ipcMain.on('open-media-folder', () => libraryService.handleOpenMediaFolder());

    // --- Online Service ---
    ipcMain.handle('search-online', (event, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (event, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (event, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.on('cache-track', (event, trackData) => onlineService.handleCacheRequest(trackData));

    // --- Download Service ---
    ipcMain.on('download-douyin', (event, data) => downloadService.handleDownloadRequest(data));

    // --- Window Controls ---
    ipcMain.on('toggle-fullscreen', (event, state) => {
        if (mainWindow) {
            mainWindow.setFullScreen(state);
        }
    });
}

/**
 * 应用主入口点。
 */
app.whenReady().then(async () => {
    // 强制 Electron 使用深色主题，以确保标题栏在支持的系统上是深色的
    nativeTheme.themeSource = 'dark';

    // 移除默认的应用程序菜单
    Menu.setApplicationMenu(null);

    // --- 1. 初始化应用和工具 ---
    const { config, ffmpegPath, ytDlpPath, systemProxy } = await setupService.initializeApp(app);
    CONFIG = config;

    // --- 2. 将共享配置和服务注入到各个模块中 ---
    const serviceInitParams = {
        config: CONFIG,
        ffmpegPath,
        ytDlpPath,
        systemProxy,
        sendMessageFunc: sendMessage,
    };
    libraryService.init(CONFIG);
    onlineService.init(CONFIG, sendMessage);
    downloadService.init(serviceInitParams);


    // --- 3. 注册自定义文件协议，用于安全地提供本地媒体文件 ---
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        const decodedUrl = decodeURIComponent(url);
        const filePath = path.join(CONFIG.MEDIA_ROOT, decodedUrl);
        callback({ path: path.normalize(filePath) });
    });

    // --- 4. 注册所有 IPC 事件处理器 ---
    registerIpcHandlers();

    // --- 5. 创建主窗口 ---
    createWindow();

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