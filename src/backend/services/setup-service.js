// src/backend/services/setup-service.js

import path from 'path';
import fs from 'fs';
import https from 'https';
import AdmZip from 'adm-zip';
import WinReg from 'winreg';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { arch } from 'node:process';
import { dialog } from 'electron';

/**
 * 在 Windows 平台上检测系统代理设置。
 * (此函数保持不变)
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
 * 确保 yt-dlp 二进制文件存在，如果不存在则下载。
 * (此函数保持不变)
 */
async function ensureYtDlpBinary(userDataPath) {
    const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);
    console.log(`[yt-dlp Init] 检查二进制文件路径: ${binaryPath}`);
    if (fs.existsSync(binaryPath)) {
        console.log('[yt-dlp Init] 本地已存在二进制文件。');
        return binaryPath;
    }
    console.log('[yt-dlp Init] 二进制文件不存在，正在从 GitHub 下载...');
    try {
        await YTDlpClass.downloadFromGithub(binaryPath);
        console.log('[yt-dlp Init] 下载完成。');
        if (process.platform !== 'win32') {
            fs.chmodSync(binaryPath, '755');
        }
        console.log(`[yt-dlp Init] 返回最终路径: ${binaryPath}`);
        return binaryPath;
    } catch (error) {
        console.error('[yt-dlp Init] 下载二进制文件失败:', error);
        return null;
    }
}


// =========================================================================
// 【核心新增】确保 ffmpeg 二进制文件存在，如果不存在则下载和解压
// =========================================================================
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
 * 检查 ffmpeg 是否存在，如果不存在，则从 GitHub 下载并解压。
 * @param {string} userDataPath - 用户数据目录路径。
 * @returns {Promise<string|null>} - ffmpeg 可执行文件的路径，或在失败时返回 null。
 */
async function ensureFfmpegBinary(userDataPath) {
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const binaryPath = path.join(binDir, exeName);

    console.log(`[FFmpeg Init] 检查二进制文件路径: ${binaryPath}`);
    if (fs.existsSync(binaryPath)) {
        console.log('[FFmpeg Init] 本地已存在二进制文件。');
        return binaryPath;
    }

    console.log('[FFmpeg Init] 二进制文件不存在，准备下载...');
    // BtbN/FFmpeg-Builds 提供的 gpl-6.0 版本，体积较小且功能齐全
    const downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.0-latest-win64-gpl-8.0.zip';
    if (process.platform !== 'win32' || arch !== 'x64') {
        console.error('[FFmpeg Init] 错误：自动下载目前仅支持 Windows x64 平台。');
        // 此处可以为其他平台添加下载链接
        return null;
    }

    try {
        console.log(`[FFmpeg Init] 正在从以下地址下载: ${downloadUrl}`);
        const zipBuffer = await downloadToBuffer(downloadUrl);
        console.log('[FFmpeg Init] 下载完成，正在解压...');

        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        // 查找压缩包内的 ffmpeg.exe 文件
        const ffmpegEntry = zipEntries.find(entry =>
            entry.entryName.endsWith('ffmpeg.exe') && !entry.isDirectory
        );

        if (!ffmpegEntry) {
            throw new Error('在下载的压缩包中未找到 ffmpeg.exe。');
        }

        // 将 ffmpeg.exe 解压到目标路径
        const ffmpegData = ffmpegEntry.getData();
        fs.writeFileSync(binaryPath, ffmpegData);

        console.log(`[FFmpeg Init] 解压成功，ffmpeg 已保存至: ${binaryPath}`);
        return binaryPath;

    } catch (error) {
        console.error('[FFmpeg Init] 下载或解压 ffmpeg 失败:', error);
        dialog.showErrorBox(
            'FFmpeg 初始化失败',
            `无法自动下载核心组件 FFmpeg。\n\n错误详情: ${error.message}\n\n视频下载和合并功能可能无法正常工作。请检查您的网络连接并重启应用。`
        );
        return null;
    }
}
// =========================================================================


/**
 * 初始化应用配置和外部工具。
 * @param {Electron.App} app - Electron 的 app 实例。
 * @returns {Promise<object>} 包含配置和工具路径的对象 { config, ffmpegPath, ytDlpPath, systemProxy }。
 */
export async function initializeApp(app) {
    console.log('[Setup] Electron App 实例已就绪，开始初始化...');
    const userDataPath = app.getPath('userData');
    console.log(`[Setup] UserData 路径: ${userDataPath}`);

    const config = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        STATE_PATH: path.join(userDataPath, 'state.json'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
    };
    [config.VIDEOS_DIR, config.ALBUMART_DIR, config.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    console.log('--- [Tools Log] 开始定位外部工具 ---');

    let ffmpegPath = '';

    // =========================================================================
    // 【核心修改】区分开发和生产环境，采用不同的方式获取 FFmpeg
    // =========================================================================
    if (app.isPackaged) {
        // --- 生产环境 ---
        // 运行时检查并下载 ffmpeg
        console.log('[Setup] 生产环境：调用 ensureFfmpegBinary 检查并准备 FFmpeg。');
        ffmpegPath = await ensureFfmpegBinary(userDataPath);
    } else {
        // --- 开发环境 ---
        // 保持原有的 `require` 方式，因为它在开发时是可靠且方便的。
        console.log('[Setup] 开发环境：使用 require("ffmpeg-static") 定位 FFmpeg。');
        try {
            ffmpegPath = require('ffmpeg-static');
        } catch (e) {
            console.error('[Error] 开发环境无法加载 ffmpeg-static 模块:', e);
            ffmpegPath = '';
        }
    }
    // =========================================================================

    const ytDlpPath = await ensureYtDlpBinary(userDataPath);

    const ffmpegExists = ffmpegPath ? fs.existsSync(ffmpegPath) : false;
    const ytDlpExists = ytDlpPath ? fs.existsSync(ytDlpPath) : false;
    console.log(`[Setup] 最终确定的 FFmpeg 路径: ${ffmpegPath}`);
    console.log(`[Setup] 文件存在性检查 - FFmpeg: ${ffmpegExists}`);
    if (!ffmpegExists) console.error(`[Error] 未能找到有效的 FFmpeg 文件。`);

    console.log(`[Setup] 最终确定的 yt-dlp 路径: ${ytDlpPath}`);
    console.log(`[Setup] 文件存在性检查 - yt-dlp: ${ytDlpExists}`);
    if (!ytDlpExists) console.error(`[Error] yt-dlp 未就绪，YouTube 下载功能将失效。`);

    console.log('--- [Tools Log] 定位结束 ---');

    const systemProxy = await detectSystemProxy();
    const finalResult = { config, ffmpegPath, ytDlpPath, systemProxy };
    console.log('[Setup] initializeApp 即将返回:', JSON.stringify(finalResult, null, 2));

    return finalResult;
}