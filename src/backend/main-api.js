import path from 'path';
import fs from 'fs';
import { chromium as playwright } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
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
        HEADLESS_MODE: true, // 在生产环境中应为 true
        ONLINE_SEARCH_API: 'https://www.myfreemp3.com.cn/',
    };

    // 确保所有媒体目录存在
    [CONFIG.VIDEOS_DIR, CONFIG.ALBUMART_DIR, CONFIG.MUSIC_DIR, CONFIG.PLUGINS_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // 初始化插件管理器，并传入正确的插件目录
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
    // 【修改】增强文件名清理逻辑
    // 1. 将所有可能引起问题的字符（包括逗号）和连续的空格替换为单个连字符
    // 2. 将连续的连字符合并为一个
    // 3. 移除开头和结尾的连字符
    return filename
        .replace(/[\/\\?%*:|"<>_,\s]+/g, '-') // 替换非法字符、逗号和空格
        .replace(/-+/g, '-')              // 合并多个连字符
        .replace(/^-+|-+$/g, '')          // 移除首尾的连字符
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

export async function handleSearchRequest(query) {
    console.log(`[Search] 收到搜索请求: query='${query}'`);
    try {
        const params = new URLSearchParams({ input: query, filter: 'name', page: '1', type: 'netease' });
        const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        });
        if (response.data.code !== 200 || !response.data.data?.list) {
            throw new Error(response.data.error || 'API返回数据格式不正确');
        }

        const searchResults = response.data.data.list.map(track => ({
            ...track,
            source: 'netease',
        }));

        console.log(`[Search] 成功，找到 ${searchResults.length} 条结果。`);
        return { success: true, data: searchResults };
    } catch (error) {
        console.error(`[Search] 失败:`, error);
        return { success: false, error: error.message };
    }
}

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
            fs.writeFileSync(lyricsPath, originalLyrics.substring('data:text/plain,'.length), 'utf-8');
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

// 【核心修复】函数签名简化，直接接收 trackInfo 对象
export async function handleGetMusicUrl(trackInfo) {
    if (!trackInfo) {
        return { success: false, error: '获取播放链接失败: 未提供有效的曲目信息。' };
    }

    console.log(`[URL Resolver] 请求解析URL: ${trackInfo.title}`);

    try {
        // 1. 优先处理直接的 HTTP 链接 (在线搜索播放路径)
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

        // 2. 尝试使用插件系统
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
        const url = await activePlugin.getMusicUrl(trackInfo, '128k'); // 默认品质

        const response = await axios.head(url, { maxRedirects: 10, timeout: 15000 });
        const finalUrl = response.request.res.responseUrl;

        return { success: true, url: finalUrl };

    } catch (e) {
        const errorMessage = e.response ? `HTTP ${e.response.status}` : e.message;
        console.error(`[URL Resolver] 解析失败:`, errorMessage);
        return { success: false, error: `获取播放链接失败: ${errorMessage}` };
    }
}

// --- Playwright/Downloader Logic ---
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
playwright.use(stealthPlugin);

async function launchBrowser() {
    try {
        return await playwright.launch({ headless: CONFIG.HEADLESS_MODE });
    } catch (error) {
        if (error.message.includes("Executable doesn't exist")) {
            sendMessage('download-status', { message: "启动浏览器失败: 请运行 'npx playwright install' 下载必要的浏览器。", type: 'error' });
        } else {
            sendMessage('download-status', { message: `启动浏览器时发生未知错误: ${error.message}`, type: 'error' });
        }
        return null;
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
    if (downloadType === 'single') await downloadSingleVideo(startUrl);
    else await downloadUserContent(startUrl, downloadType);
}

async function downloadSingleVideo(videoUrl) {
    let browser = await launchBrowser();
    if (!browser) return;

    try {
        sendMessage('download-status', { message: '浏览器已启动 (单视频模式)...' });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        const page = await context.newPage();
        const apiResponsePromise = page.waitForResponse(res => res.url().includes("aweme/v1/web/aweme/detail/") && res.status() === 200, { timeout: 60000 });

        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const apiResponse = await apiResponsePromise;
        const apiResponseJson = await apiResponse.json();

        if (!apiResponseJson?.aweme_detail) {
            sendMessage('download-status', { message: '未能拦截到有效的API响应或数据结构错误。', type: 'error' });
            return;
        }
        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessage('download-status', { message: '视频下载完成！', type: 'success' });
    } catch (error) {
        sendMessage('download-status', { message: `浏览器操作失败: ${error.message}`, type: 'error' });
    } finally {
        if (browser) await browser.close();
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