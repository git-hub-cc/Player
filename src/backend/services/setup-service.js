// src/backend/services/setup-service.js

import path from 'path';
import fs from 'fs';
import https from 'https';
import AdmZip from 'adm-zip';
import WinReg from 'winreg';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { arch } from 'node:process';
import { dialog, shell } from 'electron';

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
 * 下载文件并返回 Buffer。
 * @param {string} url - 要下载的文件的 URL。
 * @returns {Promise<Buffer>} - 包含文件数据的 Buffer。
 */
function downloadToBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            // 处理重定向
            if (response.statusCode === 302 || response.statusCode === 301) {
                console.log(`[Downloader] 重定向到: ${response.headers.location}`);
                return downloadToBuffer(response.headers.location).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`下载失败，状态码: ${response.statusCode}`));
            }
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', (err) => reject(err));
    });
}


/**
 * 下载并准备 yt-dlp 二进制文件。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {Promise<string>} - 成功则返回二进制文件路径。
 */
async function downloadYtDlp(binDir) {
    const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);
    console.log('[yt-dlp Downloader] 开始从 GitHub 下载...');
    await YTDlpClass.downloadFromGithub(binaryPath);
    console.log('[yt-dlp Downloader] 下载完成。');
    if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, '755');
    }
    return binaryPath;
}


/**
 * 下载并准备 ffmpeg 二进制文件。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {Promise<string>} - 成功则返回二进制文件路径。
 */
async function downloadFfmpeg(binDir) {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const binaryPath = path.join(binDir, exeName);

    // BtbN/FFmpeg-Builds 提供的 gpl-6.0 版本，体积较小且功能齐全
    const downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.0-latest-win64-gpl-8.0.zip';
    if (process.platform !== 'win32' || arch !== 'x64') {
        throw new Error('FFmpeg 自动下载目前仅支持 Windows x64 平台。');
    }

    console.log(`[FFmpeg Downloader] 正在从以下地址下载: ${downloadUrl}`);
    const zipBuffer = await downloadToBuffer(downloadUrl);
    console.log('[FFmpeg Downloader] 下载完成，正在解压...');

    const zip = new AdmZip(zipBuffer);
    const ffmpegEntry = zip.getEntries().find(entry =>
        entry.entryName.endsWith('ffmpeg.exe') && !entry.isDirectory
    );

    if (!ffmpegEntry) {
        throw new Error('在下载的压缩包中未找到 ffmpeg.exe。');
    }

    fs.writeFileSync(binaryPath, ffmpegEntry.getData());
    console.log(`[FFmpeg Downloader] 解压成功，ffmpeg 已保存至: ${binaryPath}`);
    return binaryPath;
}


/**
 * 检查指定工具的二进制文件是否存在。
 * @param {('ffmpeg'|'yt-dlp')} toolName - 工具名称。
 * @param {string} binDir - 二进制文件存放目录。
 * @returns {string|null} - 如果存在，返回完整路径；否则返回 null。
 */
function checkBinaryExists(toolName, binDir) {
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
 * @param {Electron.App} app - Electron 的 app 实例。
 * @returns {Promise<object>} 包含配置、工具路径和是否应继续运行标志的对象。
 */
export async function initializeApp(app) {
    console.log('[Setup] Electron App 实例已就绪，开始初始化...');
    const userDataPath = app.getPath('userData');
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    console.log(`[Setup] UserData 路径: ${userDataPath}`);
    console.log(`[Setup] 二进制工具目录: ${binDir}`);

    // --- 1. 检查所有必需的二进制文件 ---
    let ffmpegPath = null;
    if (app.isPackaged) {
        ffmpegPath = checkBinaryExists('ffmpeg', binDir);
    } else {
        // 开发环境下，保持原有方式，方便调试
        try {
            ffmpegPath = require('ffmpeg-static');
            console.log('[Setup] 开发环境：使用 require("ffmpeg-static") 定位 FFmpeg。');
        } catch (e) {
            console.error('[Setup] 开发环境无法加载 ffmpeg-static 模块:', e);
            ffmpegPath = null;
        }
    }
    let ytDlpPath = checkBinaryExists('yt-dlp', binDir);

    const missingTools = [];
    if (!ffmpegPath) missingTools.push('FFmpeg');
    if (!ytDlpPath) missingTools.push('yt-dlp');

    // --- 2. 如果有文件缺失，则与用户交互 ---
    if (missingTools.length > 0) {
        const choice = dialog.showMessageBoxSync({
            type: 'info',
            title: '缺少核心组件',
            message: `应用需要以下组件来支持视频下载和格式转换：\n\n- ${missingTools.join('\n- ')}`,
            detail: '您可以选择自动下载，或查看手动说明。如果选择退出，应用将关闭。',
            buttons: ['自动下载', '手动下载说明', '退出应用'],
            defaultId: 0,
            cancelId: 2,
        });

        switch (choice) {
            // --- Case 0: 自动下载 ---
            case 0:
                try {
                    const downloadPromises = [];
                    if (missingTools.includes('FFmpeg')) {
                        downloadPromises.push(downloadFfmpeg(binDir));
                    }
                    if (missingTools.includes('yt-dlp')) {
                        downloadPromises.push(downloadYtDlp(binDir));
                    }
                    const results = await Promise.all(downloadPromises);
                    // 下载后重新获取路径
                    ffmpegPath = checkBinaryExists('ffmpeg', binDir);
                    ytDlpPath = checkBinaryExists('yt-dlp', binDir);

                    if (!ffmpegPath || !ytDlpPath) {
                        throw new Error("部分组件下载后仍未找到，请尝试手动下载。");
                    }

                    dialog.showMessageBoxSync({
                        title: '下载完成',
                        message: '所有核心组件已准备就绪！应用将继续启动。'
                    });
                } catch (error) {
                    dialog.showErrorBox('自动下载失败', `下载组件时发生错误：\n\n${error.message}\n\n请检查您的网络连接，或尝试手动下载。应用即将退出。`);
                    return { shouldContinue: false };
                }
                break;

            // --- Case 1: 手动下载说明 ---
            case 1:
                dialog.showMessageBoxSync({
                    type: 'info',
                    title: '手动下载说明',
                    message: '请按以下步骤操作，完成后重启应用：',
                    detail: `1. 打开以下链接下载文件：\n   - FFmpeg: github.com/BtbN/FFmpeg-Builds/releases\n   - yt-dlp: github.com/yt-dlp/yt-dlp/releases\n\n2. 将下载的 "ffmpeg.exe" 和 "yt-dlp.exe" 两个文件，放置到下面的文件夹中 (点击“打开目录”可直接访问)：\n\n${binDir}`,
                    buttons: ['打开目录并退出', '仅退出']
                });
                // 即使用户不点，也打开目录方便操作
                shell.openPath(binDir);
                return { shouldContinue: false };

            // --- Case 2: 退出应用 ---
            case 2:
            default:
                return { shouldContinue: false };
        }
    }

    // --- 3. 所有组件就绪，继续初始化流程 ---
    const config = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
    };
    [config.VIDEOS_DIR, config.ALBUMART_DIR, config.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    const systemProxy = await detectSystemProxy();

    console.log('[Setup] 所有组件已就绪。');
    console.log(`[Setup] - FFmpeg 路径: ${ffmpegPath}`);
    console.log(`[Setup] - yt-dlp 路径: ${ytDlpPath}`);
    console.log(`[Setup] - 系统代理: ${systemProxy || '无'}`);

    return {
        config,
        ffmpegPath,
        ytDlpPath,
        systemProxy,
        shouldContinue: true,
    };
}