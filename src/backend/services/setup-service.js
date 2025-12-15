// src/backend/services/setup-service.js
// [无改动]
import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import AdmZip from 'adm-zip';
import WinReg from 'winreg';
import { arch } from 'node:process';
import { dialog, shell } from 'electron';

// --- 全局变量 ---
let mainWindow;

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

function downloadFileWithProgress(url, destPath, displayName) {
    const MAX_RETRIES = 3;
    let attempts = 0;

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
            sendProgress(0);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                httpsAgent: new https.Agent({ keepAlive: true }),
                timeout: 60000,
            });

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
                    sendProgress(100);
                    console.log(`[Downloader] ${displayName} 下载完成。`);
                    resolve();
                });
                writer.on('error', (err) => {
                    console.error(`[Downloader] 写入文件 ${displayName} 时出错:`, err);
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
                return attemptDownload();
            } else {
                throw new Error(`下载 ${displayName} 失败，已达最大重试次数。`);
            }
        }
    }
    return attemptDownload();
}

export async function downloadYtDlp(binDir) {
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);

    let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
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

export async function downloadFfmpeg(binDir) {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const binaryPath = path.join(binDir, exeName);
    const zipPath = path.join(binDir, 'ffmpeg.zip');

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
            mainWindow.webContents.send('download-progress', { file: 'FFmpeg', progress: -1, status: '正在解压...' });
        }

        const zip = new AdmZip(zipPath);
        const ffmpegEntry = zip.getEntries().find(entry =>
            entry.entryName.endsWith('ffmpeg.exe') && !entry.isDirectory
        );

        if (!ffmpegEntry) {
            throw new Error('在下载的压缩包中未找到 ffmpeg.exe。');
        }

        fs.writeFileSync(binaryPath, ffmpegEntry.getData());
        fs.unlinkSync(zipPath);
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

export async function initializeApp(app, mainWin) {
    mainWindow = mainWin;
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
        ffmpegPath,
        ytDlpPath,
        systemProxy,
        shouldContinue: true,
    };
}