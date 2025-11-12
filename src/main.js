// src/main.js

import { app, BrowserWindow, ipcMain, protocol, Menu, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import * as MainApi from './backend/main-api.js';

// 处理 Windows 上的快捷方式创建/删除。
if (started) {
    app.quit();
}

let mainWindow;

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 940,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // 安全起见，保持沙箱和上下文隔离启用
            sandbox: true,
            contextIsolation: true,
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    // 在开发模式下打开开发者工具
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }

    // =========================================================================
    // 【新增】监听窗口的全屏事件，并通知渲染进程
    // =========================================================================
    mainWindow.on('enter-full-screen', () => {
        mainWindow.webContents.send('fullscreen-change', true);
    });
    mainWindow.on('leave-full-screen', () => {
        mainWindow.webContents.send('fullscreen-change', false);
    });
    // =========================================================================
};

app.whenReady().then(async () => {
    // 移除默认菜单栏
    Menu.setApplicationMenu(null);

    // 初始化后端 API 模块，传入 webContents 用于发送进度更新
    MainApi.initialize(app, () => mainWindow.webContents);

    // 注册自定义协议以安全地提供本地媒体文件
    const userDataPath = app.getPath('userData');
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        const decodedUrl = decodeURIComponent(url);
        const filePath = path.join(userDataPath, 'media', decodedUrl);
        callback({ path: path.normalize(filePath) });
    });

    // 设置 IPC 监听器
    ipcMain.handle('get-local-playlist', () => MainApi.getLocalPlaylist());
    ipcMain.handle('search-online', (event, { query, page }) => MainApi.handleSearchRequest({ query, page }));
    ipcMain.handle('delete-track', (event, trackData) => MainApi.handleDeleteTrack(trackData));
    ipcMain.handle('get-music-url', (event, trackInfo) => MainApi.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (event, relativePath) => MainApi.handleGetLrcContent(relativePath));

    ipcMain.on('download-douyin', (event, data) => MainApi.handleDownloadRequest(data));
    ipcMain.on('cache-track', (event, trackData) => MainApi.handleCacheRequest(trackData));

    ipcMain.handle('select-import-directory', () => MainApi.handleSelectDirectory());
    ipcMain.handle('start-local-import', (event, dirPath) => MainApi.handleLocalImport(dirPath));

    // =========================================================================
    // 【新增】监听渲染进程的全屏切换请求
    // =========================================================================
    ipcMain.on('toggle-fullscreen', (event, state) => {
        if (mainWindow) {
            mainWindow.setFullScreen(state);
        }
    });
    // =========================================================================
    // =========================================================================
    // 【新增】监听打开媒体目录的请求
    // =========================================================================
    ipcMain.on('open-media-folder', () => {
        MainApi.handleOpenMediaFolder();
    });
    // =========================================================================

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