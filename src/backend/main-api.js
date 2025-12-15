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

    mainWindow.on('enter-full-screen', () => sendMessage('fullscreen-change', true));
    mainWindow.on('leave-full-screen', () => sendMessage('fullscreen-change', false));
};

/**
 * 注册所有 IPC 监听器。
 * @description 此函数现在从 DI 容器中获取服务实例来处理 IPC 事件。
 */
function registerIpcHandlers() {
    // --- 从 DI 容器中按需获取已完全配置好的服务实例 ---
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
    ipcMain.handle('get-lrc-content', (_, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.on('cache-track', (_, trackData) => onlineService.handleCacheRequest(trackData));
    ipcMain.handle('get-online-lyric', (_, { lyricId, source }) => onlineService.handleGetOnlineLyric({ lyricId, source }));

    // --- 下载与工具相关 ---
    ipcMain.on('download-douyin', (_, data) => downloadService.handleDownloadRequest(data));
    ipcMain.handle('separate-video', (_, trackData) => libraryService.handleSeparateVideo(trackData));
    ipcMain.handle('handle-file-drop', (_, files) => libraryService.handleDroppedFiles(files, sendMessage));

    // --- 窗口控制 ---
    ipcMain.on('toggle-fullscreen', (_, state) => mainWindow?.setFullScreen(state));
    ipcMain.on('show-user-data', () => shell.openPath(app.getPath('userData')));

    // --- 工具下载 (与 DI 解耦，因为它更像一个独立的工具函数) ---
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
            } else {
                throw new Error(`未知的工具名称: ${toolName}`);
            }
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

/**
 * 设置生产环境下的日志记录。
 */
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

/**
 * 注册全局快捷键。
 */
function registerGlobalShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
        mainWindow?.webContents.toggleDevTools();
    });
    globalShortcut.register('CommandOrControl+Shift+L', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
        if (mainWindow) {
            dialog.showMessageBox(mainWindow, { type: 'info', title: '日志与工具目录', message: `数据目录位于:\n\n${userDataPath}` });
        }
    });
}

/**
 * 应用主入口点。
 */
app.whenReady().then(async () => {
    setupLogging();

    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    // --- 核心修改：使用 bootstrap 配置 DI 容器 ---
    try {
        diContainer = await configureContainer(app, sendMessage);
    } catch (error) {
        console.error('[Main API] DI 容器配置失败，应用无法启动:', error);
        dialog.showErrorBox('应用初始化失败', `启动核心服务失败: ${error.message}\n\n应用即将退出。`);
        app.quit();
        return;
    }

    // 从容器中获取 config 来注册协议
    const config = diContainer.get('config');
    protocol.registerFileProtocol('media', (request, callback) => {
        const url = request.url.substring('media://'.length);
        const filePath = path.join(config.MEDIA_ROOT, decodeURIComponent(url));
        callback({ path: path.normalize(filePath) });
    });

    // 注册所有 IPC 处理器
    registerIpcHandlers();

    // 创建窗口并注册快捷键
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