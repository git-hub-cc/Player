// src/backend/services/setup-service.js

import path from 'path';
import fs from 'fs';
import WinReg from 'winreg';
import YTDlpWrap from 'yt-dlp-wrap-plus';

/**
 * 在 Windows 平台上检测系统代理设置。
 * @returns {Promise<string|null>} 代理服务器 URL 或 null。
 */
async function detectSystemProxy() {
    // 仅支持 Windows 平台检测注册表
    if (process.platform !== 'win32') {
        const proxyVar = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (proxyVar) {
            console.log(`[Proxy Detector] 从环境变量中发现代理: ${proxyVar}`);
            return proxyVar;
        }
        return null;
    }

    try {
        const regKey = new WinReg({
            hive: WinReg.HKCU,
            key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
        });

        // Promisify the values method
        const values = await new Promise((resolve, reject) => {
            regKey.values((err, items) => {
                if (err) return reject(err);
                const result = {};
                items.forEach(item => { result[item.name] = item.value; });
                resolve(result);
            });
        });

        if (values.ProxyEnable === '0x1' && values.ProxyServer) {
            const proxyServer = values.ProxyServer.split(';')[0]; // 处理可能存在的多个代理
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
 * 确保 yt-dlp 二进制文件存在。
 * 如果本地不存在，则尝试从 GitHub 自动下载最新版本。
 * @param {string} userDataPath - Electron 应用的用户数据目录路径。
 * @returns {Promise<string|null>} yt-dlp 的完整路径或 null。
 */
async function ensureYtDlpBinary(userDataPath) {
    const YTDlpClass = YTDlpWrap.default || YTDlpWrap;

    // 将二进制文件统一存放在 userData 目录下的 bin 文件夹中，便于管理
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    // 根据操作系统决定可执行文件名
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

        // 在非 Windows 系统上，需要为文件添加执行权限
        if (process.platform !== 'win32') {
            fs.chmodSync(binaryPath, '755');
        }

        return binaryPath;
    } catch (error) {
        console.error('[yt-dlp Init] 下载二进制文件失败:', error);
        return null;
    }
}

/**
 * 初始化应用配置和外部工具。
 * @param {Electron.App} app - Electron 的 app 实例。
 * @returns {Promise<object>} 包含配置和工具路径的对象 { config, ffmpegPath, ytDlpPath, systemProxy }。
 */
export async function initializeApp(app) {
    const userDataPath = app.getPath('userData');

    // --- 1. 初始化应用配置 (CONFIG) ---
    const config = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        STATE_PATH: path.join(userDataPath, 'state.json'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
    };

    // 确保所有媒体目录都存在
    [config.VIDEOS_DIR, config.ALBUMART_DIR, config.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    // --- 2. 定位外部工具 ---
    console.log('--- [Tools Log] 开始定位外部工具 ---');

    // 定位 FFmpeg
    let ffmpegPath;
    try {
        ffmpegPath = require('ffmpeg-static');
    } catch (e) {
        console.error('[Error] 无法加载 ffmpeg-static 模块。请确保已正确安装。');
        ffmpegPath = '';
    }
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        console.error(`[Error] 未能找到有效的 ffmpeg 路径。`);
        ffmpegPath = '';
    }

    // 初始化并可能下载 yt-dlp
    const ytDlpPath = await ensureYtDlpBinary(userDataPath);
    if (!ytDlpPath || !fs.existsSync(ytDlpPath)) {
        console.error(`[Error] yt-dlp 未就绪，YouTube 下载功能将失效。`);
    }

    console.log(`[FFmpeg Path]: ${ffmpegPath}`);
    console.log(`[yt-dlp Path]: ${ytDlpPath}`);
    console.log('--- [Tools Log] 定位结束 ---');

    // --- 3. 检测系统代理 ---
    const systemProxy = await detectSystemProxy();

    return {
        config,
        ffmpegPath,
        ytDlpPath,
        systemProxy
    };
}