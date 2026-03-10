// src/backend/main-api.js

import { app, BrowserWindow, ipcMain, protocol, Menu, nativeTheme, globalShortcut, shell, dialog, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import fs from 'fs';
import { configureContainer } from './bootstrap.js';
import * as setupService from './services/setup-service.js';

// --- 全局变量 ---
let mainWindow;
let diContainer;
let initialFileToOpen = null;

// --- 常量配置 ---
// 伪装 User-Agent 以避免部分在线服务拦截
const SPOOF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 注册特权协议，支持流媒体播放和 CORS
protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetch: true, corsEnabled: true } }
]);

// 如果是 Squirrel 安装/更新过程，立即退出
if (started) {
    app.quit();
}

// =========================================================================
// 【文件关联】核心逻辑：处理“使用此应用打开”
// =========================================================================
function findFilePathInArgs(argv) {
    // 过滤掉开发环境的参数，寻找真实文件路径
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
        // 如果窗口未就绪，暂存路径等待加载完成
        initialFileToOpen = filePath;
    }
}

// 单实例锁：防止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // 当用户试图打开第二个实例时，聚焦主窗口并处理新文件
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            const filePath = findFilePathInArgs(commandLine);
            if (filePath) sendFileToRenderer(filePath);
        }
    });

    // 处理冷启动时的文件参数
    const initialFilePath = findFilePathInArgs(process.argv);
    if (initialFilePath) initialFileToOpen = initialFilePath;
}
// =========================================================================

/**
 * 通用发送消息到渲染进程
 */
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

        // =========================================================================
        // 【核心修改】强制深色标题栏配置
        // titleBarStyle: 'hidden' -> 隐藏原生白色标题栏，接管绘制权
        // titleBarOverlay -> 在原位置绘制深色背景和原生控制按钮
        // =========================================================================
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#121212',       // 深灰色背景，匹配应用主题
            symbolColor: '#FFFFFF', // 白色控制按钮（最小化/关闭等）
            height: 32              // 标准标题栏高度
        },
        // =========================================================================

        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true,
            contextIsolation: true,
            webSecurity: true, // 保持开启以确保安全
        }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        // 开发模式下默认打开控制台，方便调试
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../renderer/main_window/index.html'));
    }

    // 窗口加载完成后，处理暂存的文件打开请求
    mainWindow.webContents.on('did-finish-load', () => {
        if (initialFileToOpen) {
            sendFileToRenderer(initialFileToOpen);
            initialFileToOpen = null;
        }
    });

    // 监听全屏事件，同步状态给前端 UI
    mainWindow.on('enter-full-screen', () => sendMessage('fullscreen-change', true));
    mainWindow.on('leave-full-screen', () => sendMessage('fullscreen-change', false));
};

function registerIpcHandlers() {
    const libraryService = diContainer.get('libraryService');
    const onlineService = diContainer.get('onlineService');
    const downloadService = diContainer.get('downloadService');
    const config = diContainer.get('config');

    // --- 1. 媒体库服务 ---
    ipcMain.handle('get-local-playlist', () => libraryService.getLocalPlaylist());
    ipcMain.handle('delete-track', (_, trackData) => libraryService.handleDeleteTrack(trackData));
    ipcMain.handle('select-import-directory', () => libraryService.handleSelectDirectory());
    ipcMain.handle('start-local-import', (_, dirPath) => libraryService.handleLocalImport(dirPath, sendMessage));
    ipcMain.on('open-media-folder', (_, type) => libraryService.handleOpenMediaFolder(type));
    ipcMain.handle('separate-video', (_, trackData) => libraryService.handleSeparateVideo(trackData));
    ipcMain.handle('handle-file-drop', (_, files) => libraryService.handleDroppedFiles(files, sendMessage));
    ipcMain.handle('change-media-directory', () => libraryService.handleChangeMediaDirectory());

    // --- 2. 在线搜索与解析服务 ---
    ipcMain.handle('search-online', (_, { query, page }) => onlineService.handleSearchRequest({ query, page }));
    ipcMain.handle('get-music-url', (_, trackInfo) => onlineService.handleGetMusicUrl(trackInfo));
    ipcMain.handle('get-vip-music-url', (_, trackInfo) => onlineService.handleGetVipMusicUrl(trackInfo));
    ipcMain.handle('get-lrc-content', (_, relativePath) => onlineService.handleGetLrcContent(relativePath));
    ipcMain.handle('get-online-lyric', (_, trackInfo) => onlineService.handleGetOnlineLyric(trackInfo));
    ipcMain.on('cache-track', (_, trackData) => onlineService.handleCacheRequest(trackData));

    // --- 3. 下载管理服务 ---
    ipcMain.on('download-douyin', (_, data) => downloadService.handleDownloadRequest(data));

    // 取消下载（支持 URL 下载和在线缓存）
    ipcMain.on('cancel-download', (_, { id, type }) => {
        if (type === 'url-download') {
            downloadService.cancelCurrentTask();
        } else if (type === 'cache-download') {
            onlineService.cancelTask(id);
        }
    });

    // --- 4. 核心工具管理 (FFmpeg / yt-dlp) ---
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

    ipcMain.handle('check-core-tools', () => {
        const binDir = config.BIN_DIR;
        const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        const ytDlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        return {
            ffmpeg: { exists: fs.existsSync(path.join(binDir, ffmpegName)), path: path.join(binDir, ffmpegName) },
            ytDlp: { exists: fs.existsSync(path.join(binDir, ytDlpName)), path: path.join(binDir, ytDlpName) }
        };
    });

    ipcMain.handle('open-tools-folder', () => {
        if (config.BIN_DIR) shell.openPath(config.BIN_DIR);
        return !!config.BIN_DIR;
    });

    // --- 5. 系统交互 ---
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
        process.on('uncaughtException', (err) => console.error('未捕获的异常:', err, err.stack));
        console.log('主进程日志记录已启动...');
    } catch (error) {
        dialog.showErrorBox('日志初始化失败', `错误: ${error.message}`);
    }
}

function registerGlobalShortcuts() {
    // DevTools 快捷键
    globalShortcut.register('CommandOrControl+Shift+I', () => mainWindow?.webContents.toggleDevTools());
    // 快速打开数据目录快捷键
    globalShortcut.register('CommandOrControl+Shift+L', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });
}

// =========================================================================
// 应用生命周期入口
// =========================================================================
app.whenReady().then(async () => {
    // 拦截请求头，注入伪装 User-Agent
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = SPOOF_USER_AGENT;
        delete details.requestHeaders['X-Electron-Version']; // 隐藏 Electron 标识
        delete details.requestHeaders['Electron'];
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });
    console.log('[Main API] 全局 User-Agent 伪装已激活。');

    setupLogging();

    // 【双重保险】设置原生主题为深色（配合 titleBarOverlay 使用效果最佳）
    nativeTheme.themeSource = 'dark';

    // 移除默认的应用菜单（Windows/Linux）
    Menu.setApplicationMenu(null);

    // 初始化依赖注入容器
    try {
        diContainer = await configureContainer(app, sendMessage);
    } catch (error) {
        console.error('[Main API] DI 容器配置失败，应用无法启动:', error);
        dialog.showErrorBox('应用初始化失败', `启动核心服务失败: ${error.message}\n\n应用即将退出。`);
        app.quit();
        return;
    }

    const config = diContainer.get('config');
    // 注册 'media://' 协议，用于安全地加载本地资源
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