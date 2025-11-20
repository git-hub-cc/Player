// src/backend/main-api.js

import path from 'path';
import fs from 'fs';
import { BrowserWindow, dialog, shell } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import pluginManager from './plugins/manager.js';
import * as gdstudio from './providers/gdstudio.js'; // 【新增】引入 GDStudio 适配器

// --- 核心配置开关 ---
// 选项: 'LEGACY' (旧版爬虫) 或 'GD_STUDIO' (新版 API)
const PROVIDER_MODE = 'GD_STUDIO';
// -------------------

// --- 配置常量 ---
const CACHE_EXPIRATION_DAYS = 7;
const BACKGROUND_SEARCH_PAGE_DEPTH = 10;
const ITEMS_PER_PAGE = 10; // 旧版分页数，新版API默认为20，可调整

// --- 状态管理 ---
const ONGOING_CACHE_BUILDS = new Set();
const INITIAL_RESPONSE_PROMISES = new Map();

let appInstance;
let getWebContents;
let CONFIG = {};
let FFMPEG_PATH = '';

// --- 初始化 ---
export function initialize(app, webContentsProvider) {
    appInstance = app;
    getWebContents = webContentsProvider;

    const userDataPath = appInstance.getPath('userData');
    CONFIG = {
        MEDIA_ROOT: path.join(userDataPath, 'media'),
        VIDEOS_DIR: path.join(userDataPath, 'media', 'videos'),
        ALBUMART_DIR: path.join(userDataPath, 'media', 'albumArt'),
        MUSIC_DIR: path.join(userDataPath, 'media', 'music'),
        PLUGINS_DIR: path.join(userDataPath, 'plugins'),
        SEARCH_CACHE_DIR: path.join(userDataPath, 'search-cache'),
        STATE_PATH: path.join(userDataPath, 'state.json'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
        HEADLESS_MODE: true,
        // 旧版 API 地址
        ONLINE_SEARCH_API: 'https://www.myfreemp3.com.cn/',
    };

    // 确保目录存在
    [
        CONFIG.VIDEOS_DIR,
        CONFIG.ALBUMART_DIR,
        CONFIG.MUSIC_DIR,
        CONFIG.PLUGINS_DIR,
        CONFIG.SEARCH_CACHE_DIR
    ].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // --- FFmpeg 定位逻辑 (从旧代码补充完整) ---
    console.log('--- [FFmpeg 日志] 开始定位 FFmpeg ---');
    console.log(`[FFmpeg 日志] app.isPackaged: ${app.isPackaged}`);

    if (app.isPackaged) {
        FFMPEG_PATH = path.join(path.dirname(app.getAppPath()), 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
    } else {
        FFMPEG_PATH = path.join(process.cwd(), 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
    }
    console.log(`[FFmpeg 日志] 路径: ${FFMPEG_PATH}`);

    if (!fs.existsSync(FFMPEG_PATH)) {
        console.error(`[FFmpeg 日志] 错误: 未找到 FFmpeg。`);
        // 尝试检查目录以辅助调试
        const expectedDir = path.dirname(FFMPEG_PATH);
        if (fs.existsSync(expectedDir)) {
            console.log(`[FFmpeg 日志] 目录存在，但 ffmpeg.exe 不在其中。`);
        }
        FFMPEG_PATH = '';
    } else {
        console.log(`[FFmpeg 日志] 成功: FFmpeg 已就绪。`);
    }
    console.log('--- [FFmpeg 日志] 定位结束 ---');

    pluginManager.initialize(CONFIG.PLUGINS_DIR);
    console.log(`[MainAPI] Initialized. Mode: ${PROVIDER_MODE}`);
}

// --- 辅助函数 ---
function sendMessage(type, data) {
    const wc = getWebContents();
    if (wc && !wc.isDestroyed()) {
        wc.send(type, data);
    }
}

function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    return filename
        .replace(/[\/\\?%*:|"<>_,\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .trim();
}

function getCacheKey(query) {
    const normalizedQuery = query.trim().toLowerCase();
    return createHash('md5').update(normalizedQuery).digest('hex');
}

// 用于旧版逻辑的 URL 验证
async function validateUrl(url) {
    if (!url || !url.startsWith('http')) return false;
    try {
        const response = await axios.head(url, {
            timeout: 5000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return response.status >= 200 && response.status < 300 && response.headers['content-type']?.includes('audio');
    } catch (error) {
        return false;
    }
}

// --- 核心处理：搜索请求 ---
export async function handleSearchRequest({ query, page = 1 }) {
    console.log(`[Search] Request: query='${query}', page=${page}, mode=${PROVIDER_MODE}`);

    // 【分支 1】新版 GDStudio 逻辑
    if (PROVIDER_MODE === 'GD_STUDIO') {
        try {
            // 直接调用适配器，无需复杂的后台缓存逻辑，因为新 API 响应较快且支持分页
            const { list, total } = await gdstudio.search(query, page);
            return { success: true, data: { results: list, total } };
        } catch (error) {
            console.error('[Search] GDStudio error:', error.message);
            return { success: false, error: error.message };
        }
    }

    // 【分支 2】旧版 Legacy 逻辑 (带缓存和后台验证)
    const cacheKey = getCacheKey(query);
    const cacheFilePath = path.join(CONFIG.SEARCH_CACHE_DIR, `${cacheKey}.json`);

    try {
        if (fs.existsSync(cacheFilePath)) {
            const stats = await fs.promises.stat(cacheFilePath);
            const cacheAgeDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

            if (cacheAgeDays < CACHE_EXPIRATION_DAYS) {
                console.log(`[Cache] HIT for '${query}'.`);
                const cacheContent = await fs.promises.readFile(cacheFilePath, 'utf-8');
                const cacheData = JSON.parse(cacheContent);
                const total = cacheData.results.length;
                const startIndex = (page - 1) * ITEMS_PER_PAGE;
                const paginatedResults = cacheData.results.slice(startIndex, startIndex + ITEMS_PER_PAGE);
                return { success: true, data: { results: paginatedResults, total } };
            } else {
                fs.promises.unlink(cacheFilePath).catch(() => {});
            }
        }
    } catch (error) { console.error(`[Cache] Error reading cache:`, error.message); }

    if (page > 1) {
        return { success: true, data: { results: [], total: 0 } };
    }

    // 触发旧版后台搜索构建...
    if (!ONGOING_CACHE_BUILDS.has(cacheKey)) {
        triggerLegacyBackgroundBuild(query, cacheKey, cacheFilePath);
    }

    try {
        const promiseWrapper = INITIAL_RESPONSE_PROMISES.get(cacheKey);
        if (!promiseWrapper) {
            // 如果没有正在进行的 promise，可能是并发问题，简单重试
            await new Promise(r => setTimeout(r, 100));
            const retryWrapper = INITIAL_RESPONSE_PROMISES.get(cacheKey);
            if(retryWrapper) {
                const { results, total } = await retryWrapper.promise;
                return { success: true, data: { results, total } };
            }
            return { success: false, error: "Search initialization failed" };
        }
        const { results, total } = await promiseWrapper.promise;
        return { success: true, data: { results, total } };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// (旧版) 后台构建缓存逻辑
function triggerLegacyBackgroundBuild(query, cacheKey, cacheFilePath) {
    ONGOING_CACHE_BUILDS.add(cacheKey);
    let promiseResolver;
    const initialResponsePromise = new Promise((resolve, reject) => { promiseResolver = { resolve, reject }; });
    INITIAL_RESPONSE_PROMISES.set(cacheKey, { promise: initialResponsePromise, resolver: promiseResolver });

    (async () => {
        const allValidatedResults = [];
        let firstPageTotal = 0;
        let initialResponseSent = false;
        try {
            for (let currentPage = 1; currentPage <= BACKGROUND_SEARCH_PAGE_DEPTH; currentPage++) {
                const params = new URLSearchParams({ input: query, filter: 'name', page: currentPage.toString(), type: 'netease' });
                const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, timeout: 30000 });
                if (currentPage === 1) firstPageTotal = response.data?.data?.total || 0;
                const tracks = response.data?.data?.list;
                if (!tracks || tracks.length === 0) break;

                // 验证 URL
                const validationPromises = tracks.map(track => validateUrl(track.url));
                const validationResults = await Promise.allSettled(validationPromises);
                validationResults.forEach((result, index) => {
                    if (result.status === 'fulfilled' && result.value === true) {
                        allValidatedResults.push({ ...tracks[index], source: 'netease' });
                    }
                });

                if (!initialResponseSent && allValidatedResults.length >= ITEMS_PER_PAGE) {
                    INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.resolve({ results: allValidatedResults.slice(0, ITEMS_PER_PAGE), total: firstPageTotal });
                    initialResponseSent = true;
                }
            }
            if (!initialResponseSent) INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.resolve({ results: allValidatedResults, total: firstPageTotal });
            if (allValidatedResults.length > 0) await fs.promises.writeFile(cacheFilePath, JSON.stringify({ timestamp: Date.now(), results: allValidatedResults }));
        } catch (err) {
            if (!initialResponseSent) INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.reject(err);
        } finally {
            ONGOING_CACHE_BUILDS.delete(cacheKey);
            INITIAL_RESPONSE_PROMISES.delete(cacheKey);
        }
    })();
}

// --- 核心处理：获取播放链接 ---
export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo) return { success: false, error: 'No track info provided.' };
    console.log(`[URL Resolver] Resolving: ${trackInfo.title}`);

    try {
        // 1. 如果已经是 HTTP 链接，尝试直接探测真实地址 (旧版逻辑兼容)
        if (trackInfo.src && trackInfo.src.startsWith('http')) {
            // 如果是新版 API 返回的 ID 模式，前端 src 可能为空，这里跳过
            // 如果是旧版，src 是一个临时的 302 链接
            if (!trackInfo.id || PROVIDER_MODE === 'LEGACY') {
                console.log(`[URL Resolver] Proxying legacy URL...`);
                const response = await axios.head(trackInfo.src, { maxRedirects: 10, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                return { success: true, url: response.request.res.responseUrl || trackInfo.src };
            }
        }

        // 2. 【新增】 GDStudio 模式：使用 ID 获取真实链接
        if (PROVIDER_MODE === 'GD_STUDIO' && trackInfo.id && trackInfo.source) {
            console.log(`[URL Resolver] Fetching via GDStudio API (ID: ${trackInfo.id})...`);
            const url = await gdstudio.getMusicUrl(trackInfo);
            return { success: true, url };
        }

        // 3. 插件系统兜底 (原有逻辑)
        if (trackInfo.source) {
            const activePlugin = pluginManager.getActivePlugin();
            if (activePlugin && activePlugin.supportedSources[trackInfo.source]) {
                console.log(`[URL Resolver] Using plugin...`);
                const url = await activePlugin.getMusicUrl(trackInfo, '128k');
                return { success: true, url };
            }
        }

        throw new Error('No suitable method to resolve URL.');
    } catch (e) {
        console.error(`[URL Resolver] Failed:`, e.message);
        return { success: false, error: e.message };
    }
}

// --- 核心处理：缓存/下载请求 ---
export async function handleCacheRequest(trackData) {
    // 兼容处理：新旧 API 字段映射
    const title = trackData.title || 'Unknown';
    const artist = trackData.artist || 'Unknown';

    // 旧版字段: originalSrc, originalAlbumArt, originalLyrics
    // 新版字段: id, source, albumArt, lyricId

    console.log(`[Download] Request: ${artist} - ${title}`);
    const safeFilename = sanitizeFilename(`${artist} - ${title}`);
    const downloadPromises = [];

    // 1. 处理音频文件
    let audioUrl = trackData.originalSrc; // 旧版优先
    if (PROVIDER_MODE === 'GD_STUDIO' && !audioUrl && trackData.id) {
        try {
            // 新版需要先获取下载链接
            audioUrl = await gdstudio.getMusicUrl(trackData);
        } catch (e) {
            sendMessage('download-status', { message: `获取音频链接失败: ${e.message}`, type: 'error' });
            return;
        }
    }
    if (audioUrl) {
        downloadPromises.push(downloadFile(audioUrl, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
    }

    // 2. 处理封面
    // 新版 albumArt 已经是完整 URL，旧版是 originalAlbumArt
    const artUrl = trackData.albumArt || trackData.originalAlbumArt;
    if (artUrl) {
        downloadPromises.push(downloadFile(artUrl, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
    }

    // 3. 处理歌词
    const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
    let lyricContent = '';

    // 新版：通过 lyricId 获取
    if (PROVIDER_MODE === 'GD_STUDIO' && trackData.lyricId) {
        try {
            lyricContent = await gdstudio.getLyric(trackData.lyricId, trackData.source);
        } catch (e) { console.warn('Failed to fetch lyrics via API'); }
    }
    // 旧版：可能是 data URI 或 HTTP URL
    else if (trackData.originalLyrics) {
        if (trackData.originalLyrics.startsWith('data:text/plain,')) {
            lyricContent = decodeURIComponent(trackData.originalLyrics.substring('data:text/plain,'.length));
        } else if (trackData.originalLyrics.startsWith('http')) {
            // 如果是 URL，加入下载队列
            downloadPromises.push(downloadFile(trackData.originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
        }
    }

    // 如果获取到了文本内容，直接写入
    if (lyricContent) {
        fs.writeFileSync(lyricsPath, lyricContent, 'utf-8');
    }

    try {
        await Promise.all(downloadPromises);
        console.log(`[Download] Success: ${safeFilename}`);

        // 构造新的本地 Track 对象
        const newTrack = {
            title, artist,
            src: `music/${safeFilename}.mp3`,
            albumArt: fs.existsSync(path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : "",
            lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
            type: "audio",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
            // 保存元数据以便未来可能的重新解析
            id: trackData.id,
            source: trackData.source
        };

        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `下载完成: ${title}`, type: 'success' });

    } catch (error) {
        console.error(`[Download] Failed:`, error);
        sendMessage('download-status', { message: `下载失败: ${error.message}`, type: 'error' });
    }
}

// --- 歌词读取 ---
export async function handleGetLrcContent(relativePath) {
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodeURIComponent(relativePath));
    try {
        if (!fs.existsSync(fullPath)) throw new Error('File not found');
        return { success: true, data: await fs.promises.readFile(fullPath, 'utf-8') };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- 删除逻辑 ---
export async function handleDeleteTrack({ src: relativeSrc }) {
    if (!relativeSrc) return { success: false, error: 'Delete failed: No track path provided.' };
    try {
        let playlist = [];
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
        const trackToDelete = playlist.find(t => t.src === relativeSrc);
        if (!trackToDelete) return { success: false, error: 'Delete failed: Track not found in playlist.' };

        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist.filter(t => t.src !== relativeSrc), null, 2), 'utf-8');

        ['src', 'albumArt', 'lyrics'].forEach(key => {
            if (trackToDelete[key]) {
                const filePath = path.join(CONFIG.MEDIA_ROOT, trackToDelete[key]);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });
        console.log(`[Deletion] Successfully deleted "${trackToDelete.title}"`);
        return { success: true, message: `Successfully deleted "${trackToDelete.title}"` };
    } catch (error) {
        console.error(`[Deletion] Error during deletion:`, error);
        return { success: false, error: error.message };
    }
}

// --- 本地文件导入逻辑 (从旧代码补充完整) ---

export async function handleSelectDirectory() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    return dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
}

export function handleOpenMediaFolder() {
    if (CONFIG.MEDIA_ROOT) shell.openPath(CONFIG.MEDIA_ROOT);
}

// 递归扫描目录
async function scanDirectoryRecursive(dirPath) {
    const fileGroups = new Map();
    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
    const artExt = ['.jpg', '.jpeg', '.png'];
    const lrcExt = '.lrc';

    async function scan(currentDir) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await scan(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const baseName = path.join(currentDir, path.basename(entry.name, ext));

                if (!fileGroups.has(baseName)) {
                    fileGroups.set(baseName, { audio: null, lrc: null, art: null });
                }
                const group = fileGroups.get(baseName);

                if (audioExt.includes(ext) && !group.audio) {
                    group.audio = fullPath;
                } else if (lrcExt === ext && !group.lrc) {
                    group.lrc = fullPath;
                } else if (artExt.includes(ext) && !group.art) {
                    group.art = fullPath;
                }
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
            const originalName = path.basename(group.audio);
            sendMessage('import-status', { message: `正在导入: ${originalName}` });

            const title = path.basename(group.audio, path.extname(group.audio));
            const safeFilename = sanitizeFilename(title);

            try {
                const newAudioPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}${path.extname(group.audio)}`);
                await fs.promises.copyFile(group.audio, newAudioPath);

                const newTrack = {
                    title: title, artist: '本地导入',
                    src: `music/${path.basename(newAudioPath)}`,
                    albumArt: '', lyrics: '', type: 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                    initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
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
            } catch (copyError) { console.error(`导入文件 ${originalName} 时出错:`, copyError); }
        }

        if (newPlaylistTracks.length > 0) await updateLocalPlaylist(newPlaylistTracks);

        sendMessage('import-status', { message: `导入完成！成功导入 ${importedCount} 首歌曲。`, type: 'success' });
        return { success: true, importedCount };

    } catch (error) {
        console.error('[Import] 导入过程失败:', error);
        sendMessage('import-status', { message: `导入失败: ${error.message}`, type: 'error' });
        return { success: false, error: error.message };
    }
}

// --- 抖音/B站下载逻辑 (从旧代码补充完整) ---

export async function handleDownloadRequest(requestData) {
    let url, downloadType;
    if (typeof requestData === 'string') {
        url = requestData;
        downloadType = 'single';
    } else {
        url = requestData.url;
        downloadType = requestData.downloadType;
    }

    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) return sendMessage('download-status', { message: '未找到有效的URL或用户ID。', type: 'error' });

    const matchedContent = match[0];

    if (matchedContent.includes('bilibili.com/video/')) {
        await downloadBilibiliVideo(matchedContent);
    } else {
        let startUrl = matchedContent;
        if (startUrl.startsWith('MS4wLjAB')) {
            startUrl = `https://www.douyin.com/user/${startUrl}`;
        }
        sendMessage('download-status', { message: `抖音目标已提取: ${startUrl}` });

        if (downloadType === 'single') {
            await downloadSingleVideo(startUrl);
        } else {
            sendMessage('download-status', { message: `批量下载 (${downloadType}) 功能尚未实现。`, type: 'error' });
        }
    }
}

async function downloadSingleVideo(videoUrl) {
    sendMessage('download-status', { message: 'Launching headless browser...' });
    // 注意：这里引用了 'backend/douyin-preload.js'，请确保该文件在项目中存在
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
        // 使用通用的 downloadFile 函数
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
    if (!FFMPEG_PATH) {
        sendMessage('download-status', { message: '错误: FFmpeg 未找到，无法合并B站视频。', type: 'error' });
        return;
    }

    try {
        sendMessage('download-status', { message: '开始解析B站链接...', type: 'default' });

        const bvidMatch = videoUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (!bvidMatch) throw new Error('无法从URL中提取有效的BV号。');
        const bvid = bvidMatch[0];
        sendMessage('download-status', { message: `BV号: ${bvid}，正在获取视频信息...`, type: 'default' });

        const viewApiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
        const viewResponse = await axios.get(viewApiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const viewData = viewResponse.data.data;
        if (!viewData || !viewData.cid) throw new Error('无法获取视频信息，请检查链接是否有效。');
        const cid = viewData.cid;
        const title = viewData.title;
        const author = viewData.owner?.name || '未知UP主';
        const coverUrl = viewData.pic;
        const safeFilename = sanitizeFilename(`${author} - ${title}`);
        sendMessage('download-status', { message: `标题: ${title}，正在获取播放链接...`, type: 'default' });

        const playUrlApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048`;
        const playResponse = await axios.get(playUrlApi, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': videoUrl } });
        const dashData = playResponse.data.data?.dash;
        if (!dashData?.video || !dashData?.audio) throw new Error('无法获取DASH格式的音视频流。');

        const videoStream = dashData.video[0];
        const audioStream = dashData.audio[0];

        sendMessage('download-status', { message: '正在下载视频和音频文件...', type: 'default' });
        const videoTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_video_temp.m4s`);
        const audioTempPath = path.join(CONFIG.MEDIA_ROOT, `${safeFilename}_audio_temp.m4s`);
        const coverPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        const finalPath = path.join(CONFIG.VIDEOS_DIR, `${safeFilename}.mp4`);

        // 调用 Bilibili 专用下载函数
        await Promise.all([
            downloadBilibiliFile(videoStream.baseUrl, path.dirname(videoTempPath), path.basename(videoTempPath), videoUrl),
            downloadBilibiliFile(audioStream.baseUrl, path.dirname(audioTempPath), path.basename(audioTempPath), videoUrl),
            downloadBilibiliFile(coverUrl, CONFIG.ALBUMART_DIR, path.basename(coverPath), videoUrl),
        ]);
        sendMessage('download-status', { message: '下载完成，开始使用FFmpeg合并...', type: 'default' });

        const ffmpegCommand = `"${FFMPEG_PATH}" -i "${videoTempPath}" -i "${audioTempPath}" -c copy "${finalPath}"`;
        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (error, stdout, stderr) => {
                if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
                if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
                if (error) {
                    console.error('FFmpeg error:', stderr);
                    return reject(new Error('FFmpeg合并失败: ' + stderr));
                }
                resolve(stdout);
            });
        });
        sendMessage('download-status', { message: '合并成功！正在更新播放列表...', type: 'default' });

        const newTrack = {
            title,
            artist: author,
            src: `videos/${path.basename(finalPath)}`,
            albumArt: `albumArt/${path.basename(coverPath)}`,
            type: "video",
            lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        await updateLocalPlaylist([newTrack]);
        sendMessage('new-track-added', newTrack);
        sendMessage('download-status', { message: `"${title}" 下载完成！`, type: 'success' });

    } catch (error) {
        console.error('[Bilibili Download] 错误:', error);
        sendMessage('download-status', { message: `B站下载失败: ${error.message}`, type: 'error' });
    }
}

// --- 通用文件操作 & 工具 ---

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

async function downloadFile(url, folder, fileName) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) return;
    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url, method: 'GET', responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve); writer.on('error', reject);
    });
}

async function downloadBilibiliFile(url, folder, fileName, refererUrl) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) return;
    const writer = fs.createWriteStream(filePath);
    const response = await axios({
        url, method: 'GET', responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': refererUrl }
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve); writer.on('error', reject);
    });
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