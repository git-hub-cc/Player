// src/backend/services/setup-service.js

import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import AdmZip from 'adm-zip';
import WinReg from 'winreg';
import { arch } from 'node:process';
// 【修改】不再需要 dialog 和 shell 来阻止启动，但可能在下载函数中用到 mainWindow 发送进度
import { dialog, shell } from 'electron';

// --- 全局变量 ---
let mainWindow; // 用于发送 IPC 消息

/**
 * 在 Windows 平台上检测系统代理设置。
 * @returns {Promise<string|null>} 代理服务器地址或 null。
 */
async function detectSystemProxy() {
    console.log('[Proxy Detector] 开始检测系统代理...');
    if (process.platform !== 'win32') {
        const proxyVar = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (proxyVar) {
            console.log(`[Proxy Detector] 从环境变量中发现代理: ${proxyVar}`);
            return proxyVar;
        }
        console.log('[Proxy Detector] 非 Windows 平台且未在环境变量中找到代理。');
        return null;
    }
    try {
        const regKey = new WinReg({
            hive: WinReg.HKCU,
            key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
        });
        const values = await new Promise((resolve, reject) => {
            regKey.values((err, items) => {
                if (err) return reject(err);
                const result = {};
                items.forEach(item => { result[item.name] = item.value; });
                resolve(result);
            });
        });
        if (values.ProxyEnable === '0x1' && values.ProxyServer) {
            const proxyServer = values.ProxyServer.split(';')[0];
            const proxyUrl = `http://${proxyServer}`;
            console.log(`[Proxy Detector] 系统代理已检测: ${proxyUrl}`);
            return proxyUrl;
        }
        console.log('[Proxy Detector] 系统代理未启用。');
        return null;
    } catch (error) {
        console.error('[Proxy Detector] 读取注册表代理设置失败:', error);
        return null;
    }
}

/**
 * 使用流式下载文件，支持进度报告和重试。
 * @param {string} url - 要下载的文件的 URL。
 * @param {string} destPath - 文件保存的完整路径。
 * @param {string} displayName - 用于在UI中显示的文件名。
 * @returns {Promise<void>} - 下载成功时 resolve，失败时 reject。
 */
function downloadFileWithProgress(url, destPath, displayName) {
    const MAX_RETRIES = 3;
    let attempts = 0;

    // 向渲染进程发送进度更新的节流函数
    let lastProgress = -1;
    const sendProgress = (progress) => {
        if (progress > lastProgress) {
            lastProgress = progress;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', { file: displayName, progress });
            }
        }
    };

    async function attemptDownload() {
        attempts++;
        try {
            console.log(`[Downloader] 开始下载 ${displayName} (第 ${attempts} 次尝试)...`);
            sendProgress(0); // 开始下载时发送 0% 进度

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                // 跟随重定向
                httpsAgent: new https.Agent({ keepAlive: true }),
                // 设置超时
                timeout: 60000, // 60秒超时
            });

            // 处理重定向后的最终 URL
            const finalUrl = response.request.res.responseUrl || url;
            if (finalUrl !== url) {
                console.log(`[Downloader] 重定向到: ${finalUrl}`);
            }

            const totalLength = parseInt(response.headers['content-length'], 10);
            const writer = fs.createWriteStream(destPath);
            let downloadedLength = 0;

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                if (totalLength) {
                    const progress = Math.round((downloadedLength / totalLength) * 100);
                    sendProgress(progress);
                }
            });

            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    sendProgress(100); // 确保完成时发送 100%
                    console.log(`[Downloader] ${displayName} 下载完成。`);
                    resolve();
                });
                writer.on('error', (err) => {
                    console.error(`[Downloader] 写入文件 ${displayName} 时出错:`, err);
                    // 清理不完整的文件
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`[Downloader] 下载 ${displayName} (第 ${attempts} 次尝试) 失败:`, error.message);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);

            if (attempts < MAX_RETRIES) {
                console.log(`[Downloader] ${MAX_RETRIES - attempts} 次重试剩余，将在 2 秒后重试...`);
                await new Promise(res => setTimeout(res, 2000));
                return attemptDownload(); // 递归调用进行重试
            } else {
                throw new Error(`下载 ${displayName} 失败，已达最大重试次数。`);
            }
        }
    }
    return attemptDownload();
}

/**
 * 【修改】导出此函数，以便主进程 API 可以按需调用。
 * 下载并准备 yt-dlp 二进制文件。
 * 【修复】直接使用 GitHub 官方 release 链接，移除导致错误的库函数调用。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {Promise<string>} - 成功则返回二进制文件路径。
 */
export async function downloadYtDlp(binDir) {
    // 确定文件名
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);

    // 确定下载地址：直接使用 GitHub latest release 链接
    // 这比依赖库函数更稳定，且不需要维护库版本
    let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'; // Linux 默认
    if (process.platform === 'win32') {
        downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    } else if (process.platform === 'darwin') {
        downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { file: 'yt-dlp' });
    }
    console.log(`[yt-dlp Downloader] 开始从 GitHub 下载: ${downloadUrl}`);

    try {
        await downloadFileWithProgress(downloadUrl, binaryPath, 'yt-dlp');

        console.log('[yt-dlp Downloader] 下载完成。');
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(binaryPath, '755');
            } catch (e) {
                console.warn('[yt-dlp Downloader] 设置执行权限失败:', e);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: true, tool: 'yt-dlp', path: binaryPath });
        }
        return binaryPath;
    } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: false, tool: 'yt-dlp', error: error.message });
        }
        throw error;
    }
}

/**
 * 【修改】导出此函数，以便主进程 API 可以按需调用。
 * 下载并准备 ffmpeg 二进制文件。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {Promise<string>} - 成功则返回二进制文件路径。
 */
export async function downloadFfmpeg(binDir) {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const binaryPath = path.join(binDir, exeName);
    const zipPath = path.join(binDir, 'ffmpeg.zip');

    // BtbN/FFmpeg-Builds 提供的 gpl-6.0 版本，体积较小且功能齐全
    const downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip';
    if (process.platform !== 'win32' || arch !== 'x64') {
        throw new Error('FFmpeg 自动下载目前仅支持 Windows x64 平台。');
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { file: 'FFmpeg' });
    }
    console.log(`[FFmpeg Downloader] 正在从以下地址下载: ${downloadUrl}`);

    try {
        await downloadFileWithProgress(downloadUrl, zipPath, 'FFmpeg');

        console.log('[FFmpeg Downloader] 下载完成，正在解压...');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', { file: 'FFmpeg', progress: -1, status: '正在解压...' }); // -1 表示不确定进度
        }

        const zip = new AdmZip(zipPath);
        const ffmpegEntry = zip.getEntries().find(entry =>
            entry.entryName.endsWith('ffmpeg.exe') && !entry.isDirectory
        );

        if (!ffmpegEntry) {
            throw new Error('在下载的压缩包中未找到 ffmpeg.exe。');
        }

        fs.writeFileSync(binaryPath, ffmpegEntry.getData());
        fs.unlinkSync(zipPath); // 解压成功后删除zip包
        console.log(`[FFmpeg Downloader] 解压成功，ffmpeg 已保存至: ${binaryPath}`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: true, tool: 'ffmpeg', path: binaryPath });
        }
        return binaryPath;
    } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: false, tool: 'ffmpeg', error: error.message });
        }
        throw error;
    }
}

/**
 * 检查指定工具的二进制文件是否存在。
 * @param {('ffmpeg'|'yt-dlp')} toolName - 工具名称。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {string|null} - 如果存在，返回完整路径；否则返回 null。
 */
export function checkBinaryExists(toolName, binDir) {
    let exeName;
    if (toolName === 'ffmpeg') {
        exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    } else if (toolName === 'yt-dlp') {
        exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    } else {
        return null;
    }

    const binaryPath = path.join(binDir, exeName);
    return fs.existsSync(binaryPath) ? binaryPath : null;
}

/**
 * 初始化应用配置和外部工具。
 * 【核心修改】不再阻塞启动，即使缺少工具也允许进入应用。
 * @param {Electron.App} app - Electron 的 app 实例。
 * @param {BrowserWindow} mainWin - 主窗口实例。
 * @returns {Promise<object>} 包含配置、工具路径和是否应继续运行标志的对象。
 */
export async function initializeApp(app, mainWin) {
    mainWindow = mainWin; // 保存主窗口引用以供IPC通信
    console.log('[Setup] Electron App 实例已就绪，开始初始化...');
    const userDataPath = app.getPath('userData');
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    console.log(`[Setup] UserData 路径: ${userDataPath}`);
    console.log(`[Setup] 二进制工具目录: ${binDir}`);

    let ffmpegPath = checkBinaryExists('ffmpeg', binDir);
    let ytDlpPath = checkBinaryExists('yt-dlp', binDir);

    const missingTools = [];
    if (!ffmpegPath) missingTools.push('FFmpeg');
    if (!ytDlpPath) missingTools.push('yt-dlp');

    // 【修改】仅记录日志，不再弹出阻塞对话框
    if (missingTools.length > 0) {
        console.warn(`[Setup] 缺少可选核心组件: ${missingTools.join(', ')}。应用将继续启动，相关功能将在使用时按需下载。`);
    } else {
        console.log('[Setup] 所有核心组件已就绪。');
    }

    const config = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
        // 【新增】将 bin 目录也放入 config，方便其他模块（如 main-api）获取
        BIN_DIR: binDir
    };

    [config.VIDEOS_DIR, config.ALBUMART_DIR, config.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    const systemProxy = await detectSystemProxy();

    console.log(`[Setup] - FFmpeg 路径: ${ffmpegPath || '未安装'}`);
    console.log(`[Setup] - yt-dlp 路径: ${ytDlpPath || '未安装'}`);
    console.log(`[Setup] - 系统代理: ${systemProxy || '无'}`);

    return {
        config,
        ffmpegPath, // 可能是 null
        ytDlpPath,  // 可能是 null
        systemProxy,
        shouldContinue: true, // 始终允许继续
    };
}