// src/backend/main-api.js

import path from 'path';
import fs from 'fs';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { Buffer } from 'buffer';
import { createHash } from 'crypto'; // For generating cache filenames

import pluginManager from './plugins/manager.js';

// --- Caching Configuration ---
const CACHE_EXPIRATION_DAYS = 7;
const BACKGROUND_SEARCH_PAGE_DEPTH = 10;
const ITEMS_PER_PAGE = 10; // Corresponds to the API's page size
const ONGOING_CACHE_BUILDS = new Set(); // Prevents multiple concurrent builds for the same query

let appInstance;
let getWebContents;

let CONFIG = {};

// 应用启动时由 main.js 调用一次
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
        SEARCH_CACHE_DIR: path.join(userDataPath, 'search-cache'), // Cache directory
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
        CONFIG.SEARCH_CACHE_DIR // Ensure cache directory is created
    ].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    pluginManager.initialize(CONFIG.PLUGINS_DIR);

    console.log(`[MainAPI] Initialized. Media stored at: ${CONFIG.MEDIA_ROOT}`);
    console.log(`[MainAPI] Search cache stored at: ${CONFIG.SEARCH_CACHE_DIR}`);
}

// --- Helper Functions (Unchanged) ---

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

// --- New Caching Helper Functions ---

/**
 * Generates an MD5 hash for a query to be used as a cache filename.
 * @param {string} query The search query.
 * @returns {string} The MD5 hash.
 */
function getCacheKey(query) {
    const normalizedQuery = query.trim().toLowerCase();
    return createHash('md5').update(normalizedQuery).digest('hex');
}

/**
 * Validates a URL by making a HEAD request.
 * @param {string} url The URL to validate.
 * @returns {Promise<boolean>} True if the URL is valid, false otherwise.
 */
async function validateUrl(url) {
    if (!url || !url.startsWith('http')) {
        return false;
    }
    try {
        const response = await axios.head(url, {
            timeout: 5000, // 5-second timeout
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return response.status >= 200 && response.status < 300 && response.headers['content-type']?.includes('audio');
    } catch (error) {
        return false;
    }
}

/**
 * Fetches and validates all results for a query in the background and saves them to a cache file.
 * This function is designed to be "fire-and-forget".
 * @param {string} query The search query.
 */
async function buildCacheForQuery(query) {
    const cacheKey = getCacheKey(query);
    if (ONGOING_CACHE_BUILDS.has(cacheKey)) {
        console.log(`[Cache] Build for '${query}' is already in progress. Skipping.`);
        return;
    }

    ONGOING_CACHE_BUILDS.add(cacheKey);
    console.log(`[Cache] Starting background cache build for '${query}'...`);

    try {
        const validatedResults = [];

        for (let page = 1; page <= BACKGROUND_SEARCH_PAGE_DEPTH; page++) {
            console.log(`[Cache] Fetching page ${page}/${BACKGROUND_SEARCH_PAGE_DEPTH} for '${query}'...`);
            const params = new URLSearchParams({ input: query, filter: 'name', page: page.toString(), type: 'netease' });
            const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
                headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                timeout: 10000
            });

            const tracks = response.data?.data?.list;
            if (!tracks || tracks.length === 0) {
                console.log(`[Cache] No more results for '${query}' at page ${page}. Stopping build.`);
                break;
            }

            const validationPromises = tracks.map(track => validateUrl(track.url));
            const validationResults = await Promise.allSettled(validationPromises);

            validationResults.forEach((result, index) => {
                if (result.status === 'fulfilled' && result.value === true) {
                    validatedResults.push({ ...tracks[index], source: 'netease' });
                }
            });
        }

        if (validatedResults.length > 0) {
            const cacheFilePath = path.join(CONFIG.SEARCH_CACHE_DIR, `${cacheKey}.json`);
            const cacheData = {
                timestamp: Date.now(),
                results: validatedResults,
            };
            await fs.promises.writeFile(cacheFilePath, JSON.stringify(cacheData)); // No need for pretty print
            console.log(`[Cache] Successfully built and saved cache for '${query}'. Found ${validatedResults.length} valid tracks.`);
        } else {
            console.log(`[Cache] No valid tracks found for '${query}' after scanning ${BACKGROUND_SEARCH_PAGE_DEPTH} pages.`);
        }
    } catch (error) {
        console.error(`[Cache] Error during background cache build for '${query}':`, error.message);
    } finally {
        ONGOING_CACHE_BUILDS.delete(cacheKey);
    }
}

// --- IPC Handlers (Modified and Original) ---

export async function handleSearchRequest({ query, page = 1 }) {
    console.log(`[Search] Received request: query='${query}', page=${page}`);
    const cacheKey = getCacheKey(query);
    const cacheFilePath = path.join(CONFIG.SEARCH_CACHE_DIR, `${cacheKey}.json`);

    try {
        if (fs.existsSync(cacheFilePath)) {
            const cacheContent = await fs.promises.readFile(cacheFilePath, 'utf-8');
            const cacheData = JSON.parse(cacheContent);
            const cacheAgeDays = (Date.now() - cacheData.timestamp) / (1000 * 60 * 60 * 24);

            if (cacheAgeDays < CACHE_EXPIRATION_DAYS) {
                console.log(`[Cache] HIT for query '${query}'. Serving from cache.`);
                const total = cacheData.results.length;
                const startIndex = (page - 1) * ITEMS_PER_PAGE;
                const paginatedResults = cacheData.results.slice(startIndex, startIndex + ITEMS_PER_PAGE);

                return { success: true, data: { results: paginatedResults, total } };
            } else {
                console.log(`[Cache] STALE for query '${query}'. Deleting old cache.`);
                await fs.promises.unlink(cacheFilePath).catch(e => console.error(`Failed to delete stale cache: ${e.message}`));
            }
        }
    } catch (error) {
        console.error(`[Cache] Error reading cache for '${query}':`, error.message);
    }

    // --- Cache MISS or STALE ---
    console.log(`[Cache] MISS for query '${query}'. Performing live search and triggering background build.`);

    try {
        // Immediately fetch the requested page for the user
        const params = new URLSearchParams({ input: query, filter: 'name', page: page.toString(), type: 'netease' });
        const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        });

        if (response.data.code !== 200 || !response.data.data) {
            throw new Error(response.data.error || 'API returned invalid data format');
        }

        // Fire-and-forget the background cache build process if it's the first page.
        if (page === 1) {
            buildCacheForQuery(query);
        }

        const searchResults = response.data.data.list ? response.data.data.list.map(track => ({ ...track, source: 'netease' })) : [];
        const totalResults = response.data.data.total || 0;

        return { success: true, data: { results: searchResults, total: totalResults } };

    } catch (error) {
        console.error(`[Search] Live search failed for '${query}':`, error);
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

    if (originalSrc) {
        downloadPromises.push(downloadFile(originalSrc, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
    }
    if (originalAlbumArt) {
        downloadPromises.push(downloadFile(originalAlbumArt, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
    }
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
        albumArt: `albumArt/${safeFilename}.jpg`,
        lyrics: fs.existsSync(lyricsPath) ? `music/${safeFilename}.lrc` : "",
        type: "audio", pinyin: pinyinStr, initials,
        originalSrc, originalAlbumArt, originalLyrics
    };

    await updateLocalPlaylist(newTrack);
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
    if (!trackInfo) {
        return { success: false, error: 'Failed to get playback URL: No track info provided.' };
    }

    console.log(`[URL Resolver] Requesting URL for: ${trackInfo.title}`);

    try {
        if (trackInfo.src && trackInfo.src.startsWith('http')) {
            console.log(`[URL Resolver] Proxying initial URL: ${trackInfo.src}`);
            const response = await axios.head(trackInfo.src, {
                maxRedirects: 10,
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
            });
            const finalUrl = response.request.res.responseUrl;
            if (!finalUrl) throw new Error('Could not resolve final media address.');
            console.log(`[URL Resolver] Success, final URL: ${finalUrl}`);
            return { success: true, url: finalUrl };
        }

        const source = trackInfo.source;
        if (!source) {
            throw new Error('Track info is missing "source" field, cannot resolve with plugin.');
        }

        const activePlugin = pluginManager.getActivePlugin();
        if (!activePlugin) {
            throw new Error('No active music plugin to handle this request.');
        }

        if (!activePlugin.supportedSources[source]) {
            throw new Error(`Active plugin "${activePlugin.pluginInfo.name}" does not support "${source}" source.`);
        }

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
        url = requestData;
        downloadType = 'single';
    } else {
        url = requestData.url;
        downloadType = requestData.downloadType;
    }

    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) return sendMessage('download-status', { message: 'No valid URL or user ID found.', type: 'error' });

    let startUrl = match[0];
    if (startUrl.startsWith('MS4wLjAB')) startUrl = `https://www.douyin.com/user/${startUrl}`;

    sendMessage('download-status', { message: `Target extracted: ${startUrl}` });
    if (downloadType === 'single') {
        await downloadSingleVideo(startUrl);
    } else {
        sendMessage('download-status', { message: `Bulk download (${downloadType}) is not yet implemented.`, type: 'error' });
    }
}

export async function handleGetLrcContent(relativePath) {
    if (!relativePath) {
        return { success: false, error: 'No lyrics file path provided.' };
    }
    const decodedPath = decodeURIComponent(relativePath);
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodedPath);

    try {
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        return { success: true, data: content };
    } catch (e) {
        console.error(`[LRC Reader] Failed to read lyrics file: ${fullPath}`, e);
        return { success: false, error: `Failed to read lyrics: ${e.message}` };
    }
}


// --- Unchanged Functions ---

async function downloadSingleVideo(videoUrl) {
    sendMessage('download-status', { message: 'Launching headless browser...' });

    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            partition: `persist:douyin_session_${Date.now()}`,
            preload: path.join(__dirname, 'backend', 'douyin-preload.js'),
            contextIsolation: true,
            sandbox: true,
        },
    });

    win.webContents.setAudioMuted(true);

    try {
        const apiResponsePromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('API response timed out (60 seconds)'));
            }, 60000);

            let hasAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (hasAttached || win.isDestroyed()) return;
                hasAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');
                    sendMessage('download-status', { message: 'Page loaded, listening for network data...' });

                    debuggerApi.on('message', async (event, method, params) => {
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const responseBody = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                const jsonData = JSON.parse(responseBody.body);
                                clearTimeout(timeout);
                                resolve(jsonData);
                            } catch (err) {
                                if (!err.message.includes('No resource with given identifier found')) {
                                    reject(err);
                                }
                            }
                        }
                    });
                } catch (attachError) {
                    reject(new Error(`Failed to attach debugger: ${attachError.message}`));
                }
            });
        });

        await win.loadURL(videoUrl, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });

        sendMessage('download-status', { message: 'Navigating page, waiting for API response...' });
        const apiResponseJson = await apiResponsePromise;

        if (!apiResponseJson?.aweme_detail) {
            sendMessage('download-status', { message: 'Could not intercept a valid API response.', type: 'error' });
            return;
        }

        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessage('download-status', { message: 'Video download complete!', type: 'success' });

    } catch (error) {
        sendMessage('download-status', { message: `Browser operation failed: ${error.message}`, type: 'error' });
    } finally {
        if (win && !win.isDestroyed()) {
            if (win.webContents.debugger.isAttached()) {
                await win.webContents.debugger.detach();
            }
            win.close();
        }
        console.log('[Downloader] Headless browser closed.');
    }
}

async function processAndDownloadItem(awemeDetail) {
    const awemeId = awemeDetail?.aweme_id;
    if (!awemeId) return;
    try {
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];

        if (videoUri) await downloadFile(`https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`);
        if (coverUrl) await downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`);
        else return;

        const title = awemeDetail.desc || "Untitled Video";
        const newTrack = {
            title,
            artist: awemeDetail.author?.nickname || "Unknown Author",
            src: `videos/${awemeId}.mp4`,
            albumArt: `albumArt/${awemeId}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist(newTrack);
        sendMessage('new-track-added', newTrack);
    } catch (e) {
        sendMessage('download-status', { message: `Failed to download item ${awemeId}: ${e.message}`, type: 'error' });
    }
}

async function downloadFile(url, folder, fileName) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) return;
    const writer = fs.createWriteStream(filePath);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function updateLocalPlaylist(newTrack) {
    let playlist = [];
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
    } catch (e) { console.warn(`[Playlist] Failed to read playlist.json`, e.message); }
    if (playlist.some(track => track.src === newTrack.src)) return;
    playlist.unshift(newTrack);
    fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');
}