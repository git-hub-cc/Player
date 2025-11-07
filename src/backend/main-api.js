import path from 'path';
import fs from 'fs';
import { BrowserWindow } from 'electron';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { Buffer } from 'buffer';

import pluginManager from './plugins/manager.js';

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
        STATE_PATH: path.join(userDataPath, 'state.json'),
        PLAYLIST_PATH: path.join(userDataPath, 'media', 'playlist.json'),
        HEADLESS_MODE: true,
        ONLINE_SEARCH_API: 'https://www.myfreemp3.com.cn/',
    };

    [CONFIG.VIDEOS_DIR, CONFIG.ALBUMART_DIR, CONFIG.MUSIC_DIR, CONFIG.PLUGINS_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    pluginManager.initialize(CONFIG.PLUGINS_DIR);

    console.log(`[MainAPI] Initialized. Media stored at: ${CONFIG.MEDIA_ROOT}`);
}

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

// --- IPC Handlers ---

export async function getLocalPlaylist() {
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            const playlistData = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
            return { success: true, data: playlistData };
        } else {
            return { success: true, data: [] };
        }
    } catch (e) {
        console.error(`[Playlist] 读取 playlist.json 失败:`, e);
        return { success: false, error: e.message };
    }
}

// =========================================================================
// 【修改】handleSearchRequest 函数现在接受一个包含 query 和 page 的对象
// =========================================================================
export async function handleSearchRequest({ query, page = 1 }) {
    console.log(`[Search] 收到搜索请求: query='${query}', page=${page}`);
    try {
        const params = new URLSearchParams({
            input: query,
            filter: 'name',
            page: page.toString(),
            type: 'netease'
        });
        const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        });

        if (response.data.code !== 200 || !response.data.data) {
            throw new Error(response.data.error || 'API返回数据格式不正确');
        }

        const searchResults = response.data.data.list ? response.data.data.list.map(track => ({
            ...track,
            source: 'netease',
        })) : [];

        const totalResults = response.data.data.total || 0;

        console.log(`[Search] 成功，找到 ${searchResults.length} 条结果。总数: ${totalResults}`);
        // 返回包含结果列表和总数的对象
        return { success: true, data: { results: searchResults, total: totalResults } };
    } catch (error) {
        console.error(`[Search] 失败:`, error);
        return { success: false, error: error.message };
    }
}
// =========================================================================


export async function handleCacheRequest(trackData) {
    const { originalSrc, originalAlbumArt, originalLyrics, title, artist, pinyin: pinyinStr, initials } = trackData;
    console.log(`[Download] 收到缓存请求: ${artist} - ${title}`);

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
        console.log(`[Download] 资源下载完成: ${safeFilename}`);
    } catch (error) {
        console.error(`[Download] 资源下载失败 for ${safeFilename}:`, error);
        sendMessage('download-status', { message: `下载 '${title}' 失败: ${error.message}`, type: 'error' });
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
    if (!relativeSrc) return { success: false, error: '删除失败：未提供曲目路径。' };
    try {
        let playlist = [];
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
        const trackToDelete = playlist.find(t => t.src === relativeSrc);
        if (!trackToDelete) return { success: false, error: '删除失败：在播放列表中未找到该曲目。' };

        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist.filter(t => t.src !== relativeSrc), null, 2), 'utf-8');

        ['src', 'albumArt', 'lyrics'].forEach(key => {
            if (trackToDelete[key]) {
                const filePath = path.join(CONFIG.MEDIA_ROOT, trackToDelete[key]);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });
        console.log(`[Deletion] 已成功删除 "${trackToDelete.title}"`);
        return { success: true, message: `已成功删除 "${trackToDelete.title}"` };
    } catch (error) {
        console.error(`[Deletion] 删除时发生错误:`, error);
        return { success: false, error: error.message };
    }
}

export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo) {
        return { success: false, error: '获取播放链接失败: 未提供有效的曲目信息。' };
    }

    console.log(`[URL Resolver] 请求解析URL: ${trackInfo.title}`);

    try {
        if (trackInfo.src && trackInfo.src.startsWith('http')) {
            console.log(`[URL Resolver] 代理请求初始URL: ${trackInfo.src}`);
            const response = await axios.head(trackInfo.src, {
                maxRedirects: 10,
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
            });
            const finalUrl = response.request.res.responseUrl;
            if (!finalUrl) throw new Error('无法解析出最终的媒体文件地址。');
            console.log(`[URL Resolver] 解析成功，最终URL: ${finalUrl}`);
            return { success: true, url: finalUrl };
        }

        const source = trackInfo.source;
        if (!source) {
            throw new Error('曲目信息缺少 "source" 字段，无法使用插件解析。');
        }

        const activePlugin = pluginManager.getActivePlugin();
        if (!activePlugin) {
            throw new Error('没有活动的音乐插件来处理此请求。');
        }

        if (!activePlugin.supportedSources[source]) {
            throw new Error(`活动的插件 "${activePlugin.pluginInfo.name}" 不支持 "${source}" 来源。`);
        }

        console.log(`[URL Resolver] 使用插件 "${activePlugin.pluginInfo.name}" 解析...`);
        const url = await activePlugin.getMusicUrl(trackInfo, '128k');

        const response = await axios.head(url, { maxRedirects: 10, timeout: 15000 });
        const finalUrl = response.request.res.responseUrl;

        return { success: true, url: finalUrl };

    } catch (e) {
        const errorMessage = e.response ? `HTTP ${e.response.status}` : e.message;
        console.error(`[URL Resolver] 解析失败:`, errorMessage);
        return { success: false, error: `获取播放链接失败: ${errorMessage}` };
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
    if (!match) return sendMessage('download-status', { message: '未找到有效的URL或用户ID。', type: 'error' });

    let startUrl = match[0];
    if (startUrl.startsWith('MS4wLjAB')) startUrl = `https://www.douyin.com/user/${startUrl}`;

    sendMessage('download-status', { message: `成功提取目标: ${startUrl}` });
    if (downloadType === 'single') {
        await downloadSingleVideo(startUrl);
    } else {
        sendMessage('download-status', { message: `批量下载功能 (${downloadType}) 暂未迁移。`, type: 'error' });
    }
}

export async function handleGetLrcContent(relativePath) {
    if (!relativePath) {
        return { success: false, error: '未提供歌词文件路径。' };
    }
    const decodedPath = decodeURIComponent(relativePath);
    const fullPath = path.join(CONFIG.MEDIA_ROOT, decodedPath);

    try {
        if (!fs.existsSync(fullPath)) {
            throw new Error(`文件不存在: ${fullPath}`);
        }
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        return { success: true, data: content };
    } catch (e) {
        console.error(`[LRC Reader] 读取歌词文件失败: ${fullPath}`, e);
        return { success: false, error: `读取歌词失败: ${e.message}` };
    }
}

async function downloadSingleVideo(videoUrl) {
    sendMessage('download-status', { message: '正在后台启动浏览器引擎...' });

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
                reject(new Error('API响应超时 (60秒)'));
            }, 60000);

            let hasAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (hasAttached || win.isDestroyed()) return;
                hasAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');
                    sendMessage('download-status', { message: '后台页面加载完成，正在监听网络...' });

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
                } catch(attachError) {
                    reject(new Error(`附加调试器失败: ${attachError.message}`));
                }
            });
        });

        await win.loadURL(videoUrl, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });

        sendMessage('download-status', { message: '后台页面导航中，等待数据响应...' });
        const apiResponseJson = await apiResponsePromise;

        if (!apiResponseJson?.aweme_detail) {
            sendMessage('download-status', { message: '未能拦截到有效的API响应或数据结构错误。', type: 'error' });
            return;
        }

        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessage('download-status', { message: '视频下载完成！', type: 'success' });

    } catch (error) {
        sendMessage('download-status', { message: `浏览器操作失败: ${error.message}`, type: 'error' });
    } finally {
        if (win && !win.isDestroyed()) {
            if (win.webContents.debugger.isAttached()) {
                await win.webContents.debugger.detach();
            }
            win.close();
        }
        console.log('[Downloader] 隐形浏览器已关闭。');
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

        const title = awemeDetail.desc || "无标题视频";
        const newTrack = {
            title,
            artist: awemeDetail.author?.nickname || "未知作者",
            src: `videos/${awemeId}.mp4`,
            albumArt: `albumArt/${awemeId}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };
        await updateLocalPlaylist(newTrack);
        sendMessage('new-track-added', newTrack);
    } catch (e) {
        sendMessage('download-status', { message: `下载作品 ${awemeId} 失败: ${e.message}`, type: 'error' });
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
    } catch (e) { console.warn(`[Playlist] 读取 playlist.json 失败`, e.message); }
    if (playlist.some(track => track.src === newTrack.src)) return;
    playlist.unshift(newTrack);
    fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');
}