// src/backend/main-api.js

import path from 'path';
import fs from 'fs';
import { BrowserWindow, dialog, shell } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { exec } from 'child_process';
// 【删除】移除了 pluginManager 的导入
import * as gdstudio from './providers/gdstudio.js';
import * as jableProvider from './providers/jable.js';
import * as youtubeProvider from './providers/youtube.js';
import WinReg from 'winreg';
import YTDlpWrap from 'yt-dlp-wrap-plus';

// =========================================================================
// 【核心修改】使用 require 引入 ffmpeg-static
// =========================================================================
let ffmpegPath;
try {
    // 这种方式可以避免 Vite 在构建时静态解析路径，从而在运行时动态获取正确的路径。
    ffmpegPath = require('ffmpeg-static');
} catch (e) {
    console.error('[Error] 无法加载 ffmpeg-static 模块。请确保它已正确安装。');
    ffmpegPath = ''; // 设置为空字符串，以便后续逻辑可以检测到错误
}

// 【删除】移除了 PROVIDER_MODE 常量

const DOWNLOAD_RETRY_COUNT = 3;

let appInstance;
let getWebContents;
let CONFIG = {};
let FFMPEG_PATH = ffmpegPath; // 直接使用导入的路径
let YT_DLP_PATH = '';
let systemProxy = null;

async function detectSystemProxy() {
    if (process.platform !== 'win32') {
        const proxyVar = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (proxyVar) {
            console.log(`[Proxy Detector] Found proxy from environment variables: ${proxyVar}`);
            return proxyVar;
        }
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
            const proxyServer = values.ProxyServer;
            const proxyUrl = `http://${proxyServer.split(';')[0]}`;
            console.log(`[Proxy Detector] System proxy detected: ${proxyUrl}`);
            return proxyUrl;
        }
        console.log('[Proxy Detector] System proxy is not enabled.');
        return null;
    } catch (error) {
        console.error('[Proxy Detector] Failed to read registry for proxy settings:', error);
        return null;
    }
}

/**
 * 确保 yt-dlp 二进制文件存在。
 * 如果不存在，尝试自动下载。
 */
async function ensureYtDlpBinary(userDataPath) {
    const YTDlpClass = YTDlpWrap.default || YTDlpWrap;

    // 将二进制文件存放在 userData 目录下的 bin 文件夹中
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
    }

    // 根据平台决定文件名
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);

    console.log(`[yt-dlp Init] Checking binary at: ${binaryPath}`);

    if (fs.existsSync(binaryPath)) {
        console.log('[yt-dlp Init] Binary found locally.');
        return binaryPath;
    }

    console.log('[yt-dlp Init] Binary not found. Downloading from GitHub...');
    try {
        // 使用 yt-dlp-wrap-plus 的内置功能下载最新版本
        await YTDlpClass.downloadFromGithub(binaryPath);
        console.log('[yt-dlp Init] Download complete.');

        // 在 Linux/Mac 上赋予执行权限
        if (process.platform !== 'win32') {
            fs.chmodSync(binaryPath, '755');
        }

        return binaryPath;
    } catch (error) {
        console.error('[yt-dlp Init] Failed to download binary:', error);
        return null;
    }
}

export async function initialize(app, webContentsProvider) {
    appInstance = app;
    getWebContents = webContentsProvider;

    systemProxy = await detectSystemProxy();

    const userDataPath = appInstance.getPath('userData');
    CONFIG = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        // 【删除】移除了 PLUGINS_DIR 和 SEARCH_CACHE_DIR 的配置
        STATE_PATH: path.join(userDataPath, 'state.json'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
        HEADLESS_MODE: true,
        // 【删除】移除了 ONLINE_SEARCH_API 的配置
    };

    // 【修改】移除了 PLUGINS_DIR 和 SEARCH_CACHE_DIR 的目录创建逻辑
    [CONFIG.VIDEOS_DIR, CONFIG.ALBUMART_DIR, CONFIG.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    console.log('--- [Tools Log] 开始定位外部工具 ---');

    // =========================================================================
    // 【核心修改】初始化 yt-dlp，支持自动下载
    // =========================================================================
    YT_DLP_PATH = await ensureYtDlpBinary(userDataPath);

    console.log(`[FFmpeg Path]: ${FFMPEG_PATH}`);
    console.log(`[yt-dlp Path]: ${YT_DLP_PATH}`);

    if (!FFMPEG_PATH || !fs.existsSync(FFMPEG_PATH)) {
        console.error(`[Error] 未能找到有效的 ffmpeg 路径。`);
        FFMPEG_PATH = '';
    }
    if (!YT_DLP_PATH || !fs.existsSync(YT_DLP_PATH)) {
        console.error(`[Error] yt-dlp 未就绪，YouTube 下载功能将失效。`);
        YT_DLP_PATH = '';
    }

    console.log('--- [Tools Log] 定位结束 ---');
    // 【删除】移除了 pluginManager.initialize 的调用
}

function sendMessage(type, data) {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) wc.send(type, data);
}

function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * =========================================================================
 * 【重构】handleSearchRequest 函数
 * 移除了所有 Legacy 模式的逻辑，仅保留 GD_STUDIO 模式。
 * =========================================================================
 */
export async function handleSearchRequest({ query, page = 1 }) {
    try {
        const { list, total } = await gdstudio.search(query, page);
        return { success: true, data: { results: list, total } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// 【删除】移除了 triggerLegacyBackgroundBuild 函数、validateUrl 辅助函数、getCacheKey 辅助函数
// 以及 ONGOING_CACHE_BUILDS, INITIAL_RESPONSE_PROMISES, REALTIME_SEARCH_BUFFER 等相关变量

export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo) return { success: false, error: 'No track info provided.' };
    try {
        if (trackInfo.src && trackInfo.src.startsWith('http')) {
            // 如果已有 HTTP 链接且不是 gdstudio 源（或者没有 ID），尝试直接验证链接有效性
            if (!trackInfo.id || !trackInfo.source) {
                const response = await axios.head(trackInfo.src, { maxRedirects: 10, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                return { success: true, url: response.request.res.responseUrl || trackInfo.src };
            }
        }
        // 【核心修改】只处理 gdstudio 的 URL 解析，移除了插件处理逻辑
        if (trackInfo.id && trackInfo.source) {
            const url = await gdstudio.getMusicUrl(trackInfo);
            return { success: true, url };
        }
        throw new Error('No suitable method to resolve URL.');
    } catch (e) { return { success: false, error: e.message }; }
}

export async function handleCacheRequest(trackData) {
    const title = trackData.title || 'Unknown';
    const artist = trackData.artist || 'Unknown';
    console.log(`[Download] Request: ${artist} - ${title}`);
    const safeFilename = sanitizeFilename(`${artist} - ${title}`);
    const downloadPromises = [];
    let audioUrl = trackData.originalSrc;
    // 【核心修改】默认使用 gdstudio 解析下载链接，移除了 PROVIDER_MODE 判断
    if (!audioUrl && trackData.id) {
        try { audioUrl = await gdstudio.getMusicUrl(trackData); } catch (e) { sendMessage('download-status', { message: `获取音频链接失败: ${e.message}`, type: 'error' }); return; }
    }
    if (audioUrl) downloadPromises.push(downloadFile(audioUrl, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
    const artUrl = trackData.albumArt || trackData.originalAlbumArt;
    if (artUrl) downloadPromises.push(downloadFile(artUrl, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
    const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
    let lyricContent = '';
    // 【核心修改】默认使用 gdstudio 获取歌词，移除了 PROVIDER_MODE 判断
    if (trackData.lyricId) {
        try { lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source); } catch (e) {}
    } else if (trackData.originalLyrics) {
        if (trackData.originalLyrics.startsWith('data:text/plain,')) lyricContent = decodeURIComponent(trackData.originalLyrics.substring('data:text/plain,'.length));
        else if (trackData.originalLyrics.startsWith('http')) downloadPromises.push(downloadFile(trackData.originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
    }
    if (lyricContent) fs.writeFileSync(lyricsPath, lyricContent, 'utf-8');
    try {
        await Promise.all(downloadPromises);
        const newTrack = {
            title, artist, src: `music/${safeFilename}.mp3`, albumArt: fs.existsSync(path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : "", lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "", type: "audio", pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''), id: trackData.id, source: trackData.source
        };
        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `下载完成: ${title}`, type: 'success' });
    } catch (error) { sendMessage('download-status', { message: `下载失败: ${error.message}`, type: 'error' }); }
}

export async function handleGetLrcContent(relativePath) {
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodeURIComponent(relativePath));
    try {
        if (!fs.existsSync(fullPath)) throw new Error('File not found');
        return { success: true, data: await fs.promises.readFile(fullPath, 'utf-8') };
    } catch (e) { return { success: false, error: e.message }; }
}

export async function handleDeleteTrack({ src: relativeSrc }) {
    if (!relativeSrc) return { success: false, error: 'Delete failed: No track path provided.' };
    try {
        let playlist = [];
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        const trackToDelete = playlist.find(t => t.src === relativeSrc);
        if (!trackToDelete) return { success: false, error: 'Delete failed: Track not found in playlist.' };
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist.filter(t => t.src !== relativeSrc), null, 2), 'utf-8');
        ['src', 'albumArt', 'lyrics'].forEach(key => {
            if (trackToDelete[key]) {
                const filePath = path.join(CONFIG.MEDIA_ROOT, trackToDelete[key]);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });
        return { success: true, message: `Successfully deleted "${trackToDelete.title}"` };
    } catch (error) { return { success: false, error: error.message }; }
}

export async function handleSelectDirectory() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    return dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
}

export function handleOpenMediaFolder() {
    if (CONFIG.MEDIA_ROOT) shell.openPath(CONFIG.MEDIA_ROOT);
}

async function scanDirectoryRecursive(dirPath) {
    const fileGroups = new Map();
    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
    const artExt = ['.jpg', '.jpeg', '.png'];
    const lrcExt = '.lrc';
    async function scan(currentDir) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) await scan(fullPath);
            else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const baseName = path.join(currentDir, path.basename(entry.name, ext));
                if (!fileGroups.has(baseName)) fileGroups.set(baseName, { audio: null, lrc: null, art: null });
                const group = fileGroups.get(baseName);
                if (audioExt.includes(ext) && !group.audio) group.audio = fullPath;
                else if (lrcExt === ext && !group.lrc) group.lrc = fullPath;
                else if (artExt.includes(ext) && !group.art) group.art = fullPath;
            }
        }
    }
    await scan(dirPath);
    return fileGroups;
}

export async function handleLocalImport(directoryPath) {
    if (!directoryPath) return { success: false, error: 'No directory provided.' };
    sendMessage('import-status', { message: '开始扫描目录...', type: 'default' });
    try {
        const fileGroups = await scanDirectoryRecursive(directoryPath);
        const audioTracks = Array.from(fileGroups.values()).filter(group => group.audio);
        if (audioTracks.length === 0) {
            sendMessage('import-status', { message: '在所选目录中未找到支持的音频文件。', type: 'error' });
            return { success: true, importedCount: 0 };
        }
        sendMessage('import-status', { message: `扫描完成，发现 ${audioTracks.length} 首歌曲。开始导入...` });
        let importedCount = 0;
        const newPlaylistTracks = [];
        for (const group of audioTracks) {
            const title = path.basename(group.audio, path.extname(group.audio));
            const safeFilename = sanitizeFilename(title);
            try {
                const newAudioPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}${path.extname(group.audio)}`);
                await fs.promises.copyFile(group.audio, newAudioPath);
                const newTrack = {
                    title: title, artist: '本地导入', src: `music/${path.basename(newAudioPath)}`, albumArt: '', lyrics: '', type: 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                };
                if (group.art) {
                    const newArtPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}${path.extname(group.art)}`);
                    await fs.promises.copyFile(group.art, newArtPath);
                    newTrack.albumArt = `albumArt/${path.basename(newArtPath)}`;
                }
                if (group.lrc) {
                    const newLrcPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
                    await fs.promises.copyFile(group.lrc, newLrcPath);
                    newTrack.lyrics = `music/${path.basename(newLrcPath)}`;
                }
                newPlaylistTracks.push(newTrack);
                importedCount++;
            } catch (copyError) { console.error(`导入文件 ${title} 时出错:`, copyError); }
        }
        if (newPlaylistTracks.length > 0) await updateLocalPlaylist(newPlaylistTracks);
        sendMessage('import-status', { message: `导入完成！成功导入 ${importedCount} 首歌曲。`, type: 'success' });
        return { success: true, importedCount };
    } catch (error) { return { success: false, error: error.message }; }
}

export async function handleDownloadRequest(requestData) {
    // 【修改】移除了 downloadType 参数处理，默认为 url 字符串
    let url = requestData;

    // 容错处理：如果前端传来了对象，提取 url
    if (typeof requestData === 'object' && requestData.url) {
        url = requestData.url;
    }

    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) return sendMessage('download-status', { message: '未找到有效的URL或用户ID。', type: 'error' });

    const matchedContent = match[0];

    if (matchedContent.includes('bilibili.com/video/')) {
        await downloadBilibiliVideo(matchedContent);
    } else if (matchedContent.includes('jable.tv/videos/')) {
        await downloadJableVideo(matchedContent);
    } else if (matchedContent.includes('youtube.com/') || matchedContent.includes('youtu.be/')) {
        await downloadYoutubeVideo(matchedContent, systemProxy);
    } else {
        let startUrl = matchedContent;
        if (startUrl.startsWith('MS4wLjAB')) {
            startUrl = `https://www.douyin.com/user/${startUrl}`;
        }
        sendMessage('download-status', { message: `抖音目标已提取: ${startUrl}` });

        // 【修改】直接执行单视频下载，不再判断下载类型
        await downloadSingleVideo(startUrl);
    }
}

async function downloadSingleVideo(videoUrl) {
    sendMessage('download-status', { message: 'Launching headless browser...' });
    const win = new BrowserWindow({ show: false, webPreferences: { partition: `persist:douyin_session_${Date.now()}`, preload: path.join(__dirname, 'backend', 'douyin-preload.js'), contextIsolation: true, sandbox: true } });
    win.webContents.setAudioMuted(true);
    try {
        const apiResponsePromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('API response timed out')), 60000);
            let hasAttached = false;
            win.webContents.on('did-finish-load', async () => {
                if (hasAttached || win.isDestroyed()) return;
                hasAttached = true;
                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3'); await debuggerApi.sendCommand('Network.enable');
                    sendMessage('download-status', { message: 'Page loaded, listening for network data...' });
                    debuggerApi.on('message', async (event, method, params) => {
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const responseBody = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                clearTimeout(timeout); resolve(JSON.parse(responseBody.body));
                            } catch (err) { if (!err.message.includes('No resource with given identifier found')) reject(err); }
                        }
                    });
                } catch (attachError) { reject(new Error(`Failed to attach debugger: ${attachError.message}`)); }
            });
        });
        await win.loadURL(videoUrl, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        sendMessage('download-status', { message: 'Navigating page, waiting for API response...' });
        const apiResponseJson = await apiResponsePromise;
        if (!apiResponseJson?.aweme_detail) {
            sendMessage('download-status', { message: 'Could not intercept a valid API response.', type: 'error' }); return;
        }
        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessage('download-status', { message: 'Video download complete!', type: 'success' });
    } catch (error) {
        sendMessage('download-status', { message: `Browser operation failed: ${error.message}`, type: 'error' });
    } finally {
        if (win && !win.isDestroyed()) {
            if (win.webContents.debugger.isAttached()) await win.webContents.debugger.detach();
            win.close();
        }
    }
}

async function processAndDownloadItem(awemeDetail) {
    const awemeId = awemeDetail?.aweme_id; if (!awemeId) return;
    try {
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];
        if (videoUri) await downloadFile(`https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`);
        if (coverUrl) await downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`); else return;
        const title = awemeDetail.desc || "Untitled Video";
        const newTrack = {
            title, artist: awemeDetail.author?.nickname || "Unknown Author",
            src: `videos/${awemeId}.mp4`, albumArt: `albumArt/${awemeId}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
    } catch (e) { sendMessage('download-status', { message: `Failed to download item ${awemeId}: ${e.message}`, type: 'error' }); }
}

async function downloadBilibiliVideo(videoUrl) {
    if (!FFMPEG_PATH) { sendMessage('download-status', { message: '错误: FFmpeg 未找到，无法合并B站视频。', type: 'error' }); return; }
    try {
        sendMessage('download-status', { message: '开始解析B站链接...', type: 'default' });
        const bvidMatch = videoUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (!bvidMatch) throw new Error('无法从URL中提取有效的BV号。');
        const bvid = bvidMatch[0];
        const viewApiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
        const viewResponse = await axios.get(viewApiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const viewData = viewResponse.data.data;
        if (!viewData || !viewData.cid) throw new Error('无法获取视频信息，请检查链接是否有效。');
        const cid = viewData.cid; const title = viewData.title; const author = viewData.owner?.name || '未知UP主'; const coverUrl = viewData.pic;
        const safeFilename = sanitizeFilename(`${author} - ${title}`);
        const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048`;
        const playResponse = await axios.get(playUrlApi, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': videoUrl } });
        const dashData = playResponse.data.data?.dash;
        if (!dashData?.video || !dashData?.audio) throw new Error('无法获取DASH格式的音视频流。');
        const videoStream = dashData.video[0]; const audioStream = dashData.audio[0];
        sendMessage('download-status', { message: '正在下载视频和音频文件...', type: 'default' });
        const videoTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_video_temp.m4s`);
        const audioTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_audio_temp.m4s`);
        const coverPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        const finalPath = path.join(CONFIG.VIDEOS_DIR, `${safeFilename}.mp4`);
        await Promise.all([
            downloadBilibiliFile(videoStream.baseUrl, path.dirname(videoTempPath), path.basename(videoTempPath), videoUrl),
            downloadBilibiliFile(audioStream.baseUrl, path.dirname(audioTempPath), path.basename(audioTempPath), videoUrl),
            downloadBilibiliFile(coverUrl, CONFIG.ALBUMART_DIR, path.basename(coverPath), videoUrl),
        ]);
        sendMessage('download-status', { message: '下载完成，开始使用FFmpeg合并...', type: 'default' });
        const ffmpegCommand = `"${FFMPEG_PATH}" -y -i "${videoTempPath}" -i "${audioTempPath}" -c copy "${finalPath}"`;
        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (error, stdout, stderr) => {
                if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
                if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
                if (error) return reject(new Error('FFmpeg合并失败: ' + stderr));
                resolve(stdout);
            });
        });
        const newTrack = { title, artist: author, src: `videos/${path.basename(finalPath)}`, albumArt: `albumArt/${path.basename(coverPath)}`, type: "video", lyrics: "", pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '') };
        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `"${title}" 下载完成！`, type: 'success' });
    } catch (error) { console.error('[Bilibili Download] 错误:', error); sendMessage('download-status', { message: `B站下载失败: ${error.message}`, type: 'error' }); }
}

async function downloadJableVideo(videoUrl) {
    if (!FFMPEG_PATH) { sendMessage('download-status', { message: '错误: FFmpeg 未找到，无法处理Jable视频。', type: 'error' }); return; }
    try {
        sendMessage('download-status', { message: '正在解析 Jable 视频信息(含Cookies)...', type: 'default' });
        const info = await jableProvider.getVideoInfo(videoUrl);
        if (!info.m3u8Url) throw new Error('未找到 m3u8 播放地址');
        const safeFilename = sanitizeFilename(info.title);
        const finalFilename = `${safeFilename}.mp4`;
        const coverFilename = `${safeFilename}.jpg`;
        sendMessage('download-status', { message: `标题: ${info.title}\n准备下载封面...`, type: 'default' });
        if (info.coverUrl) await downloadFile(info.coverUrl, CONFIG.ALBUMART_DIR, coverFilename);
        sendMessage('download-status', { message: '开始下载并解密视频分片 (使用浏览器Cookies)...', type: 'default' });
        const finalPath = await jableProvider.downloadVideo(
            info.m3u8Url, CONFIG.VIDEOS_DIR, finalFilename,
            (progress) => {
                const percent = (progress * 100).toFixed(1);
                sendMessage('download-status', { message: `下载进度: ${percent}%`, type: 'default' });
            }, FFMPEG_PATH, info.cookieString
        );
        sendMessage('download-status', { message: '处理完成！正在添加至播放列表...', type: 'default' });
        const newTrack = {
            title: info.title, artist: 'Jable TV', src: `videos/${finalFilename}`, albumArt: `albumArt/${coverFilename}`, type: "video", lyrics: "",
            pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });
    } catch (error) { console.error('[Jable Download] Error:', error); sendMessage('download-status', { message: `Jable 下载失败: ${error.message}`, type: 'error' }); }
}

async function downloadYoutubeVideo(videoUrl, proxy) {
    // 检查 yt-dlp 是否就绪
    if (!YT_DLP_PATH || !FFMPEG_PATH) {
        sendMessage('download-status', { message: '错误: yt-dlp 或 FFmpeg 未就绪，无法下载 YouTube 视频。', type: 'error' });
        return;
    }

    try {
        sendMessage('download-status', { message: '正在获取 YouTube 视频信息...', type: 'default' });
        // 使用新版的 getVideoInfo
        const info = await youtubeProvider.getVideoInfo(videoUrl, YT_DLP_PATH, proxy);

        const safeFilename = sanitizeFilename(info.title);
        const finalFilename = `${safeFilename}.mp4`;
        const coverFilename = `${safeFilename}.jpg`;

        sendMessage('download-status', { message: `标题: ${info.title}\n准备下载封面...`, type: 'default' });
        if (info.thumbnail) {
            await downloadFile(info.thumbnail, CONFIG.ALBUMART_DIR, coverFilename);
        }

        sendMessage('download-status', { message: '开始调用 yt-dlp 下载...', type: 'default' });

        // 使用新版的 downloadVideo，它内部使用 yt-dlp-wrap-plus
        await youtubeProvider.downloadVideo(
            videoUrl,
            CONFIG.VIDEOS_DIR,
            safeFilename,
            YT_DLP_PATH,
            FFMPEG_PATH,
            (progress) => {
                const percent = (progress * 100).toFixed(1);
                sendMessage('download-status', { message: `下载进度: ${percent}%`, type: 'default' });
            },
            proxy
        );

        sendMessage('download-status', { message: '下载完成！正在更新列表...', type: 'default' });

        const newTrack = {
            title: info.title,
            artist: info.uploader || 'YouTube',
            src: `videos/${finalFilename}`,
            albumArt: `albumArt/${coverFilename}`,
            type: "video",
            lyrics: "",
            pinyin: pinyin(info.title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(info.title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

    } catch (error) {
        console.error('[YouTube Download] Error:', error);
        sendMessage('download-status', { message: `YouTube 下载失败: ${error.message}`, type: 'error' });
    }
}

export async function getLocalPlaylist() {
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            const playlistData = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
            return { success: true, data: playlistData };
        } else {
            return { success: true, data: [] };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function downloadFile(url, folder, fileName, retries = DOWNLOAD_RETRY_COUNT) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) {
        try { const stats = await fs.promises.stat(filePath); if (stats.size > 0) return; }
        catch (e) { /* ignore stat error */ }
    }

    for (let i = 0; i < retries; i++) {
        try {
            const writer = fs.createWriteStream(filePath);
            const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return; // 下载成功且文件非空
            throw new Error('Downloaded file is empty.');

        } catch (error) {
            console.warn(`[Download] Attempt ${i + 1} failed for ${fileName}: ${error.message}`);
            if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(e => console.error(e));
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * (i + 1))); // 增加等待时间
        }
    }
}

// =========================================================================
// 【增强】为 Bilibili 下载增加重试和文件校验
// =========================================================================
async function downloadBilibiliFile(url, folder, fileName, refererUrl, retries = DOWNLOAD_RETRY_COUNT) {
    const filePath = path.join(folder, fileName);
    // 如果文件已存在且大小不为0，则跳过下载
    if (fs.existsSync(filePath)) {
        try {
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) {
                console.log(`[Bilibili Download] File ${fileName} already exists and is not empty. Skipping.`);
                return;
            }
        } catch (e) { /* 忽略 stat 错误，继续下载 */ }
    }

    for (let i = 0; i < retries; i++) {
        try {
            const writer = fs.createWriteStream(filePath);
            const response = await axios({
                url, method: 'GET', responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': refererUrl }
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // 【核心校验】下载完成后检查文件大小
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) {
                console.log(`[Bilibili Download] Attempt ${i + 1}: Success, downloaded ${fileName} (${stats.size} bytes).`);
                return; // 下载成功且文件非空，直接返回
            }

            // 如果文件为空，抛出错误以触发重试
            throw new Error('Downloaded file is empty.');

        } catch (error) {
            console.warn(`[Bilibili Download] Attempt ${i + 1} failed for ${fileName}: ${error.message}`);
            // 删除可能存在的空文件或损坏文件
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(e => console.error(`Failed to delete temporary file: ${filePath}`, e));
            }

            if (i === retries - 1) {
                // 如果是最后一次重试，则向上抛出错误
                throw new Error(`Failed to download ${fileName} after ${retries} attempts. Last error: ${error.message}`);
            }
            // 等待时间随重试次数增加
            await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
    }
}


async function updateLocalPlaylist(newTracks) {
    let playlist = [];
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
    } catch (e) {}
    const existingSrcs = new Set(playlist.map(track => track.src));
    const uniqueNewTracks = newTracks.filter(track => !existingSrcs.has(track.src));
    if (uniqueNewTracks.length > 0) {
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify([...uniqueNewTracks, ...playlist], null, 2), 'utf-8');
    }
}