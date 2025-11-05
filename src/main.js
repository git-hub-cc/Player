// src/main.js

import { app, BrowserWindow, ipcMain, protocol } from 'electron';
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
        },
        icon: path.join(__dirname, '../favicon.svg')
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }

    // 在开发模式下打开开发者工具 (已被注释，默认关闭)
    // if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    //     mainWindow.webContents.openDevTools();
    // }
};

app.whenReady().then(async () => {
    // 初始化后端 API 模块，传入 webContents 用于发送进度更新
    MainApi.initialize(app, () => mainWindow.webContents);

    // 注册自定义协议以安全地提供本地媒体文件
    const userDataPath = app.getPath('userData');
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        // 【核心修复】解码 URL 路径以正确处理非 ASCII 字符（如中文）
        const decodedUrl = decodeURIComponent(url);
        const filePath = path.join(userDataPath, 'media', decodedUrl);
        callback({ path: path.normalize(filePath) });
    });

    // 设置 IPC 监听器
    ipcMain.handle('get-local-playlist', () => MainApi.getLocalPlaylist());
    ipcMain.handle('search-online', (event, query) => MainApi.handleSearchRequest(query));
    ipcMain.handle('delete-track', (event, trackData) => MainApi.handleDeleteTrack(trackData));
    ipcMain.handle('get-music-url', (event, trackInfo) => MainApi.handleGetMusicUrl(trackInfo));

    ipcMain.on('download-douyin', (event, data) => MainApi.handleDownloadRequest(data));
    ipcMain.on('cache-track', (event, trackData) => MainApi.handleCacheRequest(trackData));

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