// src/backend/main-api.js

import path from 'path';
import fs from 'fs';
// =========================================================================
// 【修改】从 electron 导入 shell 模块
// =========================================================================
import { BrowserWindow, dialog, shell } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';

import pluginManager from './plugins/manager.js';

// --- 配置 ---
const CACHE_EXPIRATION_DAYS = 7;
const BACKGROUND_SEARCH_PAGE_DEPTH = 10;
const ITEMS_PER_PAGE = 10;

// --- 状态管理 ---
const ONGOING_CACHE_BUILDS = new Set();
const INITIAL_RESPONSE_PROMISES = new Map();

let appInstance;
let getWebContents;
let CONFIG = {};

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
        ONLINE_SEARCH_API: 'https://www.myfreemp3.com.cn/',
    };

    [
        CONFIG.VIDEOS_DIR,
        CONFIG.ALBUMART_DIR,
        CONFIG.MUSIC_DIR,
        CONFIG.PLUGINS_DIR,
        CONFIG.SEARCH_CACHE_DIR
    ].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    pluginManager.initialize(CONFIG.PLUGINS_DIR);

    console.log(`[MainAPI] Initialized. Media stored at: ${CONFIG.MEDIA_ROOT}`);
    console.log(`[MainAPI] Search cache stored at: ${CONFIG.SEARCH_CACHE_DIR}`);
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

async function validateUrl(url) {
    if (!url || !url.startsWith('http')) {
        return false;
    }
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

// --- 本地导入函数 ---
export async function handleSelectDirectory() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    return dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
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
    if (!directoryPath) {
        return { success: false, error: 'No directory provided.' };
    }
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
// =========================================================================
// 【新增】处理打开媒体目录请求的函数
// =========================================================================
export function handleOpenMediaFolder() {
    if (CONFIG.MEDIA_ROOT) {
        shell.openPath(CONFIG.MEDIA_ROOT).catch(err => {
            console.error(`[Folder] 无法打开媒体目录: ${CONFIG.MEDIA_ROOT}`, err);
        });
    } else {
        console.error('[Folder] 媒体目录路径未初始化。');
    }
}
// =========================================================================

// --- 核心 IPC 处理函数 ---
export async function handleSearchRequest({ query, page = 1 }) {
    console.log(`[Search] Request: query='${query}', page=${page}`);
    const cacheKey = getCacheKey(query);
    const cacheFilePath = path.join(CONFIG.SEARCH_CACHE_DIR, `${cacheKey}.json`);

    try {
        if (fs.existsSync(cacheFilePath)) {
            const stats = await fs.promises.stat(cacheFilePath);
            const cacheAgeDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);

            if (cacheAgeDays < CACHE_EXPIRATION_DAYS) {
                console.log(`[Cache] HIT for '${query}'. Serving from cache.`);
                const cacheContent = await fs.promises.readFile(cacheFilePath, 'utf-8');
                const cacheData = JSON.parse(cacheContent);
                const total = cacheData.results.length;
                const startIndex = (page - 1) * ITEMS_PER_PAGE;
                const paginatedResults = cacheData.results.slice(startIndex, startIndex + ITEMS_PER_PAGE);
                return { success: true, data: { results: paginatedResults, total } };
            } else {
                console.log(`[Cache] STALE for '${query}'. Deleting old cache.`);
                await fs.promises.unlink(cacheFilePath).catch(e => console.error(`[Cache] Failed to delete stale cache: ${e.message}`));
            }
        }
    } catch (error) { console.error(`[Cache] Error reading cache for '${query}':`, error.message); }

    // --- 缓存未命中或已过期 ---
    if (page > 1) {
        // 如果用户在缓存建立前请求后续页面，返回空结果
        console.log(`[Search] Cache MISS for '${query}', page ${page}. Waiting for cache build.`);
        return { success: true, data: { results: [], total: 0 } };
    }

    // --- 首次搜索 (page === 1) ---
    console.log(`[Search] Cache MISS for '${query}'. Triggering live search and background build.`);

    if (ONGOING_CACHE_BUILDS.has(cacheKey)) {
        console.log(`[Cache] Build for '${query}' is already in progress. Awaiting initial response.`);
    } else {
        ONGOING_CACHE_BUILDS.add(cacheKey);

        let promiseResolver;
        const initialResponsePromise = new Promise((resolve, reject) => {
            promiseResolver = { resolve, reject };
        });
        INITIAL_RESPONSE_PROMISES.set(cacheKey, { promise: initialResponsePromise, resolver: promiseResolver });

        // == 启动后台缓存构建任务 (不使用 await) ==
        (async () => {
            console.log(`[Cache] Starting background build for '${query}'...`);
            const allValidatedResults = [];
            let firstPageTotal = 0;
            let initialResponseSent = false;

            try {
                for (let currentPage = 1; currentPage <= BACKGROUND_SEARCH_PAGE_DEPTH; currentPage++) {
                    const params = new URLSearchParams({ input: query, filter: 'name', page: currentPage.toString(), type: 'netease' });
                    const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
                        headers: { 'X-Requested-With': 'XMLHttpRequest' },
                        timeout: 30000
                    });

                    if (currentPage === 1) firstPageTotal = response.data?.data?.total || 0;

                    const tracks = response.data?.data?.list;
                    if (!tracks || tracks.length === 0) {
                        console.log(`[Cache] No more results for '${query}' at page ${currentPage}. Stopping build.`);
                        break;
                    }

                    const validationPromises = tracks.map(track => validateUrl(track.url));
                    const validationResults = await Promise.allSettled(validationPromises);
                    validationResults.forEach((result, index) => {
                        if (result.status === 'fulfilled' && result.value === true) {
                            allValidatedResults.push({ ...tracks[index], source: 'netease' });
                        }
                    });

                    if (!initialResponseSent && allValidatedResults.length >= ITEMS_PER_PAGE) {
                        INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.resolve({
                            results: allValidatedResults.slice(0, ITEMS_PER_PAGE),
                            total: firstPageTotal,
                        });
                        initialResponseSent = true;
                        console.log(`[Cache] Sent initial response for '${query}'.`);
                    }
                }

                if (!initialResponseSent) {
                    INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.resolve({
                        results: allValidatedResults,
                        total: firstPageTotal,
                    });
                    initialResponseSent = true;
                }

                if (allValidatedResults.length > 0) {
                    await fs.promises.writeFile(cacheFilePath, JSON.stringify({
                        timestamp: Date.now(),
                        results: allValidatedResults,
                    }));
                    console.log(`[Cache] Successfully built cache for '${query}' with ${allValidatedResults.length} tracks.`);
                }

            } catch (err) {
                console.error(`[Cache] Background build for '${query}' failed:`, err.message);
                if (!initialResponseSent) {
                    INITIAL_RESPONSE_PROMISES.get(cacheKey)?.resolver.reject(err);
                }
            } finally {
                ONGOING_CACHE_BUILDS.delete(cacheKey);
                INITIAL_RESPONSE_PROMISES.delete(cacheKey);
            }
        })();
    }

    try {
        const promiseWrapper = INITIAL_RESPONSE_PROMISES.get(cacheKey);
        if (!promiseWrapper) throw new Error("Promise for initial response was not found.");
        const { results, total } = await promiseWrapper.promise;
        return { success: true, data: { results, total } };
    } catch (error) {
        return { success: false, error: error.message };
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
        console.error(`[Playlist] Failed to read playlist.json:`, e);
        return { success: false, error: e.message };
    }
}

export async function handleCacheRequest(trackData) {
    const { originalSrc, originalAlbumArt, originalLyrics, title, artist, pinyin: pinyinStr, initials } = trackData;
    console.log(`[Download] Received cache request: ${artist} - ${title}`);

    const safeFilename = sanitizeFilename(`${artist} - ${title}`);
    const downloadPromises = [];

    if (originalSrc) downloadPromises.push(downloadFile(originalSrc, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
    if (originalAlbumArt) downloadPromises.push(downloadFile(originalAlbumArt, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));

    const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
    if (originalLyrics) {
        if (originalLyrics.startsWith('data:text/plain,')) {
            fs.writeFileSync(lyricsPath, decodeURIComponent(originalLyrics.substring('data:text/plain,'.length)), 'utf-8');
        } else if (originalLyrics.startsWith('http')) {
            downloadPromises.push(downloadFile(originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
        }
    }

    try {
        await Promise.all(downloadPromises);
        console.log(`[Download] Resources downloaded for: ${safeFilename}`);
    } catch (error) {
        console.error(`[Download] Resource download failed for ${safeFilename}:`, error);
        sendMessage('download-status', { message: `Download '${title}' failed: ${error.message}`, type: 'error' });
        return;
    }

    const newTrack = {
        title, artist,
        src: `music/${safeFilename}.mp3`,
        albumArt: fs.existsSync(path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`)) ? `albumArt/${safeFilename}.jpg` : "",
        lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
        type: "audio", pinyin: pinyinStr, initials,
        originalSrc, originalAlbumArt, originalLyrics
    };

    await updateLocalPlaylist([newTrack]);
    sendMessage('new-track-added', newTrack);
}

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

export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo) return { success: false, error: 'Failed to get playback URL: No track info provided.' };
    console.log(`[URL Resolver] Requesting URL for: ${trackInfo.title}`);
    try {
        if (trackInfo.src && trackInfo.src.startsWith('http')) {
            console.log(`[URL Resolver] Proxying initial URL: ${trackInfo.src}`);
            const response = await axios.head(trackInfo.src, { maxRedirects: 10, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const finalUrl = response.request.res.responseUrl;
            if (!finalUrl) throw new Error('Could not resolve final media address.');
            console.log(`[URL Resolver] Success, final URL: ${finalUrl}`);
            return { success: true, url: finalUrl };
        }
        const source = trackInfo.source;
        if (!source) throw new Error('Track info is missing "source" field.');
        const activePlugin = pluginManager.getActivePlugin();
        if (!activePlugin) throw new Error('No active music plugin.');
        if (!activePlugin.supportedSources[source]) throw new Error(`Active plugin does not support "${source}" source.`);
        console.log(`[URL Resolver] Using plugin "${activePlugin.pluginInfo.name}" to resolve...`);
        const url = await activePlugin.getMusicUrl(trackInfo, '128k');
        const response = await axios.head(url, { maxRedirects: 10, timeout: 15000 });
        const finalUrl = response.request.res.responseUrl;
        return { success: true, url: finalUrl };
    } catch (e) {
        const errorMessage = e.response ? `HTTP ${e.response.status}` : e.message;
        console.error(`[URL Resolver] Failed:`, errorMessage);
        return { success: false, error: `Failed to get playback URL: ${errorMessage}` };
    }
}

export async function handleDownloadRequest(requestData) {
    let url, downloadType;
    if (typeof requestData === 'string') {
        url = requestData; downloadType = 'single';
    } else {
        url = requestData.url; downloadType = requestData.downloadType;
    }
    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) return sendMessage('download-status', { message: 'No valid URL or user ID found.', type: 'error' });
    let startUrl = match[0];
    if (startUrl.startsWith('MS4wLjAB')) startUrl = `https://www.douyin.com/user/${startUrl}`;
    sendMessage('download-status', { message: `Target extracted: ${startUrl}` });
    if (downloadType === 'single') await downloadSingleVideo(startUrl);
    else sendMessage('download-status', { message: `Bulk download (${downloadType}) is not yet implemented.`, type: 'error' });
}

export async function handleGetLrcContent(relativePath) {
    if (!relativePath) return { success: false, error: 'No lyrics file path provided.' };
    const decodedPath = decodeURIComponent(relativePath);
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodedPath);
    try {
        if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        return { success: true, data: content };
    } catch (e) {
        console.error(`[LRC Reader] Failed to read lyrics file: ${fullPath}`, e);
        return { success: false, error: `Failed to read lyrics: ${e.message}` };
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

async function downloadFile(url, folder, fileName) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) return;
    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve); writer.on('error', reject);
    });
}

async function updateLocalPlaylist(newTracks) {
    let playlist = [];
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
    } catch (e) { console.warn(`[Playlist] Failed to read playlist.json`, e.message); }
    const existingSrcs = new Set(playlist.map(track => track.src));
    const uniqueNewTracks = newTracks.filter(track => !existingSrcs.has(track.src));
    if (uniqueNewTracks.length > 0) {
        const updatedPlaylist = [...uniqueNewTracks, ...playlist];
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(updatedPlaylist, null, 2), 'utf-8');
    }
}