// agent.js - 客户端代理 (v8.4 - 目录独立 & Stage 3 Plugin Integration)
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { chromium as playwright } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import { pinyin } from 'pinyin-pro';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';

import pluginManager from './plugins/manager.js';

const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
playwright.use(stealthPlugin);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT_DIR = path.resolve(__dirname, './');

const CONFIG = {
    HTTP_PORT: 9528,
    WEBSOCKET_PORT: 9527,
    VIDEOS_DIR: path.join(AGENT_ROOT_DIR, 'videos'),
    ALBUMART_DIR: path.join(AGENT_ROOT_DIR, 'albumArt'),
    MUSIC_DIR: path.join(AGENT_ROOT_DIR, 'music'),
    STATE_PATH: path.join(AGENT_ROOT_DIR, 'state.json'),
    PLAYLIST_PATH: path.join(AGENT_ROOT_DIR, 'playlist.json'),
    HEADLESS_MODE: false,
    USER_WORKS_DELAY_MIN: 2000,
    USER_WORKS_DELAY_MAX: 5000,
    USER_WORKS_DELAY_JITTER: 300,
    ONLINE_SEARCH_API: 'https://www.myfreemp3.com.cn/',
};

function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    return filename.replace(/[\/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim();
}

const app = express();
app.use(cors());

[CONFIG.VIDEOS_DIR, CONFIG.ALBUMART_DIR, CONFIG.MUSIC_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(`/videos`, express.static(CONFIG.VIDEOS_DIR));
app.use(`/albumArt`, express.static(CONFIG.ALBUMART_DIR));
app.use(`/music`, express.static(CONFIG.MUSIC_DIR));

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL parameter');
    try { new URL(targetUrl); } catch (error) { return res.status(400).send('Invalid URL parameter'); }

    console.log(`[Proxy] Fetching: ${targetUrl}`);
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Referer': new URL(targetUrl).origin
        };
        if (req.headers.range) headers.Range = req.headers.range;

        const response = await axios.get(targetUrl, { responseType: 'stream', headers });

        res.status(response.status);
        res.set('Content-Type', response.headers['content-type']);
        res.set('Content-Length', response.headers['content-length']);
        if (response.headers['content-range']) res.set('Content-Range', response.headers['content-range']);
        res.set('Accept-Ranges', 'bytes');

        response.data.pipe(res);
    } catch (error) {
        console.error(`[Proxy] Error fetching ${targetUrl}:`, error.message);
        res.status(error.response ? error.response.status : 500).send(`Proxy error: ${error.message}`);
    }
});

const server = app.listen(CONFIG.HTTP_PORT, async () => {
    console.log(`[HTTP Server] 媒体及代理服务器已启动，监听 http://localhost:${CONFIG.HTTP_PORT}`);

    await pluginManager.initialize();
});

const wss = new WebSocketServer({ port: CONFIG.WEBSOCKET_PORT });
wss.on('connection', (ws) => {
    console.log('[WebSocket] 网页播放器已连接。');
    const sendMessage = (type, data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
    };
    ws.on('message', async (message) => {
        try {
            const request = JSON.parse(message.toString());
            // ================== [修改] 扩展消息处理 ==================
            switch(request.type) {
                case 'download':
                    await handleDownloadRequest(request.data, sendMessage);
                    break;
                case 'search':
                    await handleSearchRequest(request.data, sendMessage);
                    break;
                case 'cache_track':
                    await handleCacheRequest(request.data, sendMessage);
                    break;
                case 'delete_track':
                    await handleDeleteTrack(request.data, sendMessage);
                    break;
                case 'get_local_playlist':
                    try {
                        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
                            sendMessage('local_playlist_data', JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8')));
                        } else {
                            sendMessage('local_playlist_data', []);
                        }
                    } catch (e) { console.error(`[Playlist] 读取代理 playlist.json 失败:`, e); }
                    break;

                // [修改] 插件管理相关消息
                case 'get_plugins':
                    sendMessage('plugins_list', {
                        plugins: pluginManager.getAllPluginsInfo(),
                        activePluginId: pluginManager.activePluginId,
                    });
                    break;
                case 'load_plugin':
                    try {
                        await pluginManager.addPlugin(request.data.code, request.data.name);
                        sendMessage('success', `插件 ${request.data.name} 添加成功!`);
                        sendMessage('plugins_list', {
                            plugins: pluginManager.getAllPluginsInfo(),
                            activePluginId: pluginManager.activePluginId,
                        });
                    } catch (e) {
                        sendMessage('error', `添加插件失败: ${e.message}`);
                    }
                    break;
                // [新增] 插件动作消息
                case 'select_plugin':
                    try {
                        pluginManager.setActivePlugin(request.data.id);
                        sendMessage('success', `已切换到插件: ${pluginManager.getPlugin(request.data.id).pluginInfo.name}`);
                        sendMessage('plugins_list', {
                            plugins: pluginManager.getAllPluginsInfo(),
                            activePluginId: pluginManager.activePluginId,
                        });
                    } catch(e) {
                        sendMessage('error', `切换插件失败: ${e.message}`);
                    }
                    break;
                case 'unload_plugin':
                    try {
                        const pluginName = pluginManager.getPlugin(request.data.id).pluginInfo.name;
                        await pluginManager.unloadPlugin(request.data.id);
                        sendMessage('success', `插件 ${pluginName} 已卸载。`);
                        sendMessage('plugins_list', {
                            plugins: pluginManager.getAllPluginsInfo(),
                            activePluginId: pluginManager.activePluginId,
                        });
                    } catch (e) {
                        sendMessage('error', `卸载插件失败: ${e.message}`);
                    }
                    break;
                // [新增] 获取音乐URL消息
                case 'get_music_url':
                    try {
                        const activePlugin = pluginManager.getActivePlugin();
                        if (!activePlugin) {
                            throw new Error('没有活动的音乐插件');
                        }
                        const url = await activePlugin.getMusicUrl(request.data.musicInfo, request.data.quality);
                        sendMessage('music_url', { requestId: request.data.requestId, url });
                    } catch (e) {
                        console.error(`[Agent] Get Music URL Error:`, e);
                        sendMessage('music_url', { requestId: request.data.requestId, error: e.message });
                    }
                    break;
                default:
                    console.warn(`[WebSocket] Received unknown message type: ${request.type}`);
            }
        } catch (e) {
            console.error('[WebSocket] 解析消息失败:', e);
            sendMessage('error', '无效的请求格式。');
        }
    });
    ws.on('close', () => console.log('[WebSocket] 网页播放器已断开。'));
    ws.on('error', (error) => console.error('[WebSocket] 发生错误:', error));
});

console.log(`[WebSocket] 代理服务器已启动，监听 ws://localhost:${CONFIG.WEBSOCKET_PORT}`);
console.log('-------------------------------------------------------------------\n');


async function handleSearchRequest(searchData, sendMessage) {
    const { query, sourceType } = searchData;
    try {
        const params = new URLSearchParams({ input: query, filter: 'name', page: '1', type: sourceType });
        const response = await axios.post(CONFIG.ONLINE_SEARCH_API, params, {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        });
        if (response.data.code !== 200 || !response.data.data?.list) throw new Error(response.data.error || 'API返回数据格式不正确');
        sendMessage('search_results', response.data.data.list);
    } catch (error) {
        sendMessage('error', `搜索失败: ${error.message}`);
    }
}

async function handleCacheRequest(trackData, sendMessage) {
    const { originalSrc, originalAlbumArt, originalLyrics, title, artist, pinyin: pinyinStr, initials } = trackData;
    console.log(`[Download] 收到下载请求: ${artist} - ${title}`);

    const safeFilename = sanitizeFilename(`${artist} - ${title}`);
    const downloadPromises = [];
    const encodedSafeFilename = encodeURIComponent(safeFilename);

    if (originalSrc) {
        const audioPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.mp3`);
        if (!fs.existsSync(audioPath)) {
            downloadPromises.push(downloadFile(originalSrc, CONFIG.MUSIC_DIR, `${safeFilename}.mp3`));
        }
    }
    if (originalAlbumArt) {
        const artPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`);
        if (!fs.existsSync(artPath)) {
            downloadPromises.push(downloadFile(originalAlbumArt, CONFIG.ALBUMART_DIR, `${safeFilename}.jpg`));
        }
    }
    const lyricsPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
    if (originalLyrics && !fs.existsSync(lyricsPath)) {
        if (originalLyrics.startsWith('data:text/plain,')) {
            try {
                const lrcContent = Buffer.from(originalLyrics.substring('data:text/plain,'.length), 'base64').toString('utf-8');
                fs.writeFileSync(lyricsPath, lrcContent, 'utf-8');
            } catch (e) { console.error(`[Download] 写入Data URL歌词失败: ${e.message}`); }
        } else if (originalLyrics.startsWith('http')) {
            downloadPromises.push(downloadFile(originalLyrics, CONFIG.MUSIC_DIR, `${safeFilename}.lrc`));
        }
    }

    if (downloadPromises.length > 0) {
        try {
            await Promise.all(downloadPromises);
            console.log(`[Download] 资源下载完成: ${safeFilename}`);
        } catch (error) {
            console.error(`[Download] 下载资源失败 for ${safeFilename}:`, error);
            sendMessage('error', `下载 '${title}' 失败: ${error.message}`);
            return;
        }
    } else {
        console.log(`[Download] '${safeFilename}' 所有资源已在本地，无需下载。`);
    }

    const newTrack = {
        title,
        artist,
        src: `music/${encodedSafeFilename}.mp3`,
        albumArt: `albumArt/${encodedSafeFilename}.jpg`,
        lyrics: fs.existsSync(lyricsPath) ? `music/${encodedSafeFilename}.lrc` : "",
        type: "audio",
        pinyin: pinyinStr,
        initials,
        originalSrc: originalSrc,
        originalAlbumArt: originalAlbumArt,
        originalLyrics: originalLyrics
    };

    await updateLocalPlaylist(newTrack, CONFIG.PLAYLIST_PATH);
    sendMessage('new_track', newTrack);
}

/**
 * [新增] 处理删除曲目的请求
 * @param {object} data - 包含要删除曲目 src 的对象
 * @param {function} sendMessage - WebSocket 发送消息函数
 */
async function handleDeleteTrack(data, sendMessage) {
    const relativeSrc = data.src;
    if (!relativeSrc) {
        sendMessage('error', '删除失败：未提供曲目路径。');
        return;
    }

    try {
        let playlist = [];
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }

        const trackToDelete = playlist.find(t => t.src === relativeSrc);
        if (!trackToDelete) {
            sendMessage('error', '删除失败：在播放列表中未找到该曲目。');
            return;
        }

        // 1. 从播放列表数组中移除
        const updatedPlaylist = playlist.filter(t => t.src !== relativeSrc);
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(updatedPlaylist, null, 2), 'utf-8');
        console.log(`[Deletion] 已从 playlist.json 中移除: ${trackToDelete.title}`);

        // 2. 从磁盘删除关联文件
        const filesToDelete = [];
        if (trackToDelete.src) filesToDelete.push(path.join(AGENT_ROOT_DIR, trackToDelete.src));
        if (trackToDelete.albumArt) filesToDelete.push(path.join(AGENT_ROOT_DIR, trackToDelete.albumArt));
        if (trackToDelete.lyrics) filesToDelete.push(path.join(AGENT_ROOT_DIR, trackToDelete.lyrics));

        for (const file of filesToDelete) {
            if (fs.existsSync(file)) {
                try {
                    fs.unlinkSync(file);
                    console.log(`  -> 已删除文件: ${path.basename(file)}`);
                } catch (e) {
                    console.error(`  -> 删除文件失败: ${file}`, e);
                }
            }
        }

        sendMessage('success', `已成功删除 "${trackToDelete.title}"`);

    } catch (error) {
        console.error(`[Deletion] 删除曲目时发生错误:`, error);
        sendMessage('error', `删除失败: ${error.message}`);
    }
}


// ... 省略抖音下载相关函数，保持不变 ...
async function handleDownloadRequest(requestData, sendMessage) {
    let url, downloadType;
    if (typeof requestData === 'string') {
        url = requestData;
        downloadType = 'single';
    } else {
        url = requestData.url;
        downloadType = requestData.downloadType;
    }
    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) return sendMessage('error', '未找到有效的URL或用户ID。');

    let startUrl = match[0];
    if (startUrl.startsWith('MS4wLjAB')) startUrl = `https://www.douyin.com/user/${startUrl}`;

    sendMessage('status', `成功提取目标: ${startUrl}`);
    if (downloadType === 'single') await downloadSingleVideo(startUrl, sendMessage);
    else await downloadUserContent(startUrl, downloadType, sendMessage);
}

async function launchBrowser(sendMessage) {
    try {
        return await playwright.launch({ headless: CONFIG.HEADLESS_MODE });
    } catch (error) {
        if (error.message.includes("Executable doesn't exist")) {
            sendMessage('error', "启动浏览器失败: 未找到可执行文件。请在代理程序的终端中运行 'npx playwright install' 来下载必要的浏览器。");
        } else {
            sendMessage('error', `启动浏览器时发生未知错误: ${error.message}`);
        }
        return null;
    }
}

async function randomDelay(min, max) {
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}

async function downloadSingleVideo(videoUrl, sendMessage) {
    let browser = await launchBrowser(sendMessage);
    if (!browser) return;

    try {
        sendMessage('status', '浏览器已启动 (单视频模式)...');
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        const page = await context.newPage();
        const apiResponsePromise = new Promise((resolve, reject) => {
            page.on('response', async (res) => {
                if (res.url().includes("aweme/v1/web/aweme/detail/") && res.status() === 200) {
                    try { resolve(await res.json()); } catch (e) { reject(e); }
                }
            });
        });
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const apiResponseJson = await Promise.race([apiResponsePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('API拦截超时')), 60000))]);
        if (!apiResponseJson?.aweme_detail) {
            sendMessage('error', '未能拦截到有效的API响应或数据结构错误。');
            return;
        }
        await processAndDownloadItem(apiResponseJson.aweme_detail, sendMessage);
        sendMessage('success', `视频下载完成！`);
    } catch (error) {
        sendMessage('error', `浏览器操作失败: ${error.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

async function downloadUserContent(userUrl, downloadType, sendMessage) {
    const configs = {
        works: { api: "aweme/v1/web/aweme/post/", tabSelector: '[data-e2e="user-tab-post"]', listSelector: 'div[data-e2e="user-post-list"]', name: "作品" },
        likes: { api: "aweme/v1/web/aweme/favorite/", tabSelector: '#semiTablike', listSelector: 'div[data-e2e="user-like-list"]', name: "喜欢" }
    };
    const currentConfig = configs[downloadType];
    if (!currentConfig) return sendMessage('error', `无效的下载类型: ${downloadType}`);

    let browser = await launchBrowser(sendMessage);
    if (!browser) return;

    try {
        sendMessage('status', `浏览器已启动 (${currentConfig.name}模式)...`);
        const contextOptions = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' };
        if (fs.existsSync(CONFIG.STATE_PATH)) {
            sendMessage('status', '发现会话状态，正在加载...');
            contextOptions.storageState = CONFIG.STATE_PATH;
        }
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await page.goto(userUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await closeLoginModalIfNeeded(page, sendMessage);
        if (downloadType === 'likes') {
            try {
                await page.waitForSelector(currentConfig.tabSelector, { state: 'visible', timeout: 20000 });
                await page.click(currentConfig.tabSelector);
            } catch (e) { return sendMessage('error', `切换到 "${currentConfig.name}" 列表失败。`); }
        }
        await page.waitForSelector(currentConfig.listSelector, { timeout: 60000 });

        let hasMore = true, pageNum = 1, downloadedCount = 0;
        const seenAwemeIds = new Set();
        while (hasMore) {
            const apiResponsePromise = new Promise((resolve) => page.once('response', async (res) => res.url().includes(currentConfig.api) && resolve(await res.json())));
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            sendMessage('status', `滚动加载第 ${pageNum} 页...`);
            await randomDelay(500, 1000);
            const postData = await Promise.race([apiResponsePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('API超时')), 20000))]);
            if (!postData?.aweme_list?.length) break;
            hasMore = postData.has_more;
            const newWorks = postData.aweme_list.filter(w => !seenAwemeIds.has(w.aweme_id));
            if (!newWorks.length && postData.aweme_list.length) break;
            for (const item of newWorks) {
                seenAwemeIds.add(item.aweme_id);
                sendMessage('status', `[${++downloadedCount}] 处理: ${item.desc || "无标题"}`);
                await processAndDownloadItem(item, sendMessage);
            }
            if (hasMore) {
                pageNum++;
                await new Promise(res => setTimeout(res, Math.round(randomDelay(CONFIG.USER_WORKS_DELAY_MIN, CONFIG.USER_WORKS_DELAY_MAX))));
            }
        }
        sendMessage('success', `所有${currentConfig.name}下载完成！共处理 ${downloadedCount} 个。`);
        await context.storageState({ path: CONFIG.STATE_PATH });
    } catch (error) {
        sendMessage('error', `批量下载失败: ${error.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

async function closeLoginModalIfNeeded(page, sendMessage) {
    try {
        const closeButton = page.locator(`svg path[d="M12.7929 22.2426C12.4024 22.6331 12.4024 23.2663 12.7929 23.6568C13.1834 24.0474 13.8166 24.0474 14.2071 23.6568L18.5 19.3639L22.7929 23.6568C23.1834 24.0474 23.8166 24.0474 24.2071 23.6568C24.5976 23.2663 24.5976 22.6331 24.2071 22.2426L19.9142 17.9497L24.1066 13.7573C24.4971 13.3668 24.4971 12.7336 24.1066 12.3431C23.7161 11.9526 23.0829 11.9526 22.6924 12.3431L18.5 16.5355L14.3076 12.3431C13.9171 11.9526 13.2839 11.9526 12.8934 12.3431C12.5029 12.7336 12.5029 13.3668 12.8934 13.7573L17.0858 17.9497L12.7929 22.2426Z"]`);
        await closeButton.waitFor({ state: 'visible', timeout: 15000 });
        await closeButton.click();
    } catch (error) { /* Modal not found, which is fine */ }
}

async function processAndDownloadItem(awemeDetail, sendMessage) {
    const awemeId = awemeDetail?.aweme_id;
    if (!awemeId) return;
    try {
        const promises = [];
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];
        if (videoUri) promises.push(downloadFile(`https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`));
        if (coverUrl) promises.push(downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`));
        if (promises.length === 0) return;
        await Promise.all(promises);

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
        await updateLocalPlaylist(newTrack, CONFIG.PLAYLIST_PATH);
        sendMessage('new_track', newTrack);
    } catch (e) { sendMessage('error', `下载作品 ${awemeId} 失败: ${e.message}`); }
}

async function downloadFile(url, folder, fileName) {
    try {
        const filePath = path.join(folder, fileName);

        // 确保目录存在
        fs.mkdirSync(folder, { recursive: true });

        if (fs.existsSync(filePath)) return;

        const response = await axios({ method: 'get', url, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 120000 });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (e) {
        // 重新抛出原始错误，以便调用者可以处理
        throw e;
    }
}

async function updateLocalPlaylist(newTrack, playlistPath) {
    let playlist = [];
    try {
        if (fs.existsSync(playlistPath)) {
            playlist = JSON.parse(fs.readFileSync(playlistPath, 'utf-8'));
        }
    } catch (e) { console.warn(`[Playlist] 读取 ${playlistPath} 失败，将创建新文件。`, e.message); }
    if (playlist.some(track => track.src === newTrack.src)) return;
    playlist.unshift(newTrack);
    try {
        fs.writeFileSync(playlistPath, JSON.stringify(playlist, null, 2), 'utf-8');
    } catch (e) { console.error(`[Playlist] 写入 ${playlistPath} 失败:`, e); }
}