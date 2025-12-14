// src/backend/main-api.js

import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, globalShortcut, shell, dialog, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import fs from 'fs';

// --- 导入服务模块 ---
import * as setupService from './services/setup-service.js';
import * as libraryService from './services/library-service.js';
import * as onlineService from './services/online-service.js';
import * as downloadService from './services/download-service.js';

// --- 全局变量 ---
let mainWindow;
let CONFIG = {};

// 将自定义的 'media' 协议注册为特权协议
protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetch: true, corsEnabled: true } }
]);

// 处理 Windows 上的快捷方式创建/删除
if (started) {
    app.quit();
}

/**
 * 向渲染进程发送消息。
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
            webSecurity: true,
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
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
    // --- 媒体库相关 ---
    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (event, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (event, dirPath) => libraryService.handleLocalImport(dirPath, sendMessage));
    ipcMain.on('open-media-folder', () => libraryService.handleOpenMediaFolder());

    // --- 在线服务相关 ---
    ipcMain.handle('search-online', (event, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (event, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (event, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.on('cache-track', (event, trackData) => onlineService.handleCacheRequest(trackData));
    // =========================================================================
    // 【核心新增】添加 IPC 句柄，用于获取在线歌曲的歌词
    // =========================================================================
    ipcMain.handle('get-online-lyric', (event, { lyricId, source }) =>
        onlineService.handleGetOnlineLyric({ lyricId, source })
    );
    // =========================================================================

    // --- 下载与工具相关 ---
    ipcMain.on('download-douyin', (event, data) => downloadService.handleDownloadRequest(data));

    // --- 窗口控制 ---
    ipcMain.on('toggle-fullscreen', (event, state) => {
        if (mainWindow) {
            mainWindow.setFullScreen(state);
        }
    });
    ipcMain.on('show-user-data', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });

    // --- 视频分离 ---
    ipcMain.handle('separate-video', (event, trackData) =>
        libraryService.handleSeparateVideo(trackData)
    );

    // --- 文件拖拽 ---
    ipcMain.handle('handle-file-drop', (event, files) => {
        console.log('🔍 [Main IPC] handle-file-drop invoked');
        if (Array.isArray(files) && files.length > 0) {
            console.log(`   - Receiving ${files.length} files. First item path: ${files[0].path}`);
        } else {
            console.warn('   - Warning: Received empty or invalid file list:', files);
        }
        return libraryService.handleDroppedFiles(files, sendMessage);
    });

    // --- 工具下载 ---
    ipcMain.handle('download-core-tool', async (event, toolName) => {
        try {
            const binDir = CONFIG.BIN_DIR;
            let newPath;

            if (toolName === 'ffmpeg') {
                newPath = await setupService.downloadFfmpeg(binDir);
                downloadService.setFfmpegPath(newPath);
                libraryService.setFfmpegPath(newPath);
            } else if (toolName === 'yt-dlp') {
                newPath = await setupService.downloadYtDlp(binDir);
                downloadService.setYtDlpPath(newPath);
            } else {
                throw new Error(`未知的工具名称: ${toolName}`);
            }

            return { success: true, path: newPath };
        } catch (error) {
            console.error(`[Main API] 下载工具 ${toolName} 失败:`, error);
            return { success: false, error: error.message };
        }
    });

    // --- 打开工具目录 ---
    ipcMain.handle('open-tools-folder', () => {
        const binDir = CONFIG.BIN_DIR;
        if (binDir) {
            shell.openPath(binDir);
            return true;
        }
        return false;
    });
}

/**
 * 应用主入口点。
 */
app.whenReady().then(async () => {
    // 生产环境下设置日志记录
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

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [
                    "default-src 'self'",
                    `script-src 'self' ${MAIN_WINDOW_VITE_DEV_SERVER_URL ? "'unsafe-eval'" : ""}`,
                    "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' media: data: http: https:",
                    "media-src 'self' media: http: https:",
                    "connect-src 'self' https://music-api.gdstudio.xyz"
                ].join('; ')
            }
        });
    });

    console.log(`[Main API] 应用启动，app.isPackaged = ${app.isPackaged}`);

    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    try {
        const setupResult = await setupService.initializeApp(app, mainWindow);
        const { config, ffmpegPath, ytDlpPath, systemProxy } = setupResult;
        CONFIG = config;

        console.log(`[Main API] 成功接收到初始化参数:`);
        console.log(`  - FFmpeg: ${ffmpegPath || '未就绪'}`);
        console.log(`  - yt-dlp: ${ytDlpPath || '未就绪'}`);
        console.log(`  - Proxy: ${systemProxy}`);

        const serviceInitParams = { config, ffmpegPath, ytDlpPath, systemProxy, sendMessageFunc: sendMessage };

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
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '日志与工具目录',
                message: `日志文件、配置文件和下载的工具位于以下目录中：\n\n${userDataPath}`
            });
        }
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