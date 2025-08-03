// agent.js - 客户端下载代理 (Upgraded for Works and Likes - v4 with Modal Closing)
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const playwright = require('playwright-extra').chromium;
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');

stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');

// --- 配置 ---
const CONFIG = {
    HTTP_PORT: 9528,
    WEBSOCKET_PORT: 9527,
    VIDEOS_DIR: 'videos',
    ALBUMART_DIR: 'albumArt',
    STATE_PATH: 'state.json',
    PLAYLIST_PATH: 'playlist.json',
    HEADLESS_MODE: false,
    USER_WORKS_DELAY_MIN: 2000,
    USER_WORKS_DELAY_MAX: 5000,
    USER_WORKS_DELAY_JITTER: 300,
};

playwright.use(stealth);

// --- 辅助函数 ---
const randomDelay = (min, max) => new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));

/**
 * 【新增】尝试关闭登录提示弹窗的函数
 * @param {import('playwright').Page} page
 * @param {(type: string, data: any) => void} sendMessage
 */
async function closeLoginModalIfNeeded(page, sendMessage) {
    // 使用您提供的SVG路径数据构造一个精确的CSS属性选择器
    const closeButtonSelector = `svg path[d="M12.7929 22.2426C12.4024 22.6331 12.4024 23.2663 12.7929 23.6568C13.1834 24.0474 13.8166 24.0474 14.2071 23.6568L18.5 19.3639L22.7929 23.6568C23.1834 24.0474 23.8166 24.0474 24.2071 23.6568C24.5976 23.2663 24.5976 22.6331 24.2071 22.2426L19.9142 17.9497L24.1066 13.7573C24.4971 13.3668 24.4971 12.7336 24.1066 12.3431C23.7161 11.9526 23.0829 11.9526 22.6924 12.3431L18.5 16.5355L14.3076 12.3431C13.9171 11.9526 13.2839 11.9526 12.8934 12.3431C12.5029 12.7336 12.5029 13.3668 12.8934 13.7573L17.0858 17.9497L12.7929 22.2426Z"]`;

    try {
        sendMessage('status', '检查登录弹窗...');
        const closeButton = page.locator(closeButtonSelector);

        // 【修改】等待登录弹窗的超时时间从 5 秒增加到 20 秒
        await closeButton.waitFor({ state: 'visible', timeout: 20000 });

        sendMessage('status', '检测到登录弹窗，正在尝试关闭...');
        await closeButton.click();

        // 等待弹窗动画消失
        await page.waitForTimeout(1000);
        sendMessage('status', '成功关闭登录弹窗。');
    } catch (error) {
        // 如果超时，说明弹窗没有出现，这是正常情况，直接继续
        sendMessage('status', '未检测到登录弹窗，继续操作。');
    }
}


// ==============================================================================
// 1. HTTP 服务器 (无变化)
// ==============================================================================
const app = express();
app.use(cors());
if (!fs.existsSync(CONFIG.VIDEOS_DIR)) fs.mkdirSync(CONFIG.VIDEOS_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.ALBUMART_DIR)) fs.mkdirSync(CONFIG.ALBUMART_DIR, { recursive: true });
app.use(`/${CONFIG.VIDEOS_DIR}`, express.static(path.join(__dirname, CONFIG.VIDEOS_DIR)));
app.use(`/${CONFIG.ALBUMART_DIR}`, express.static(path.join(__dirname, CONFIG.ALBUMART_DIR)));
app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`[HTTP Server] 媒体文件服务器已启动，正在监听 http://localhost:${CONFIG.HTTP_PORT}`);
});

// ==============================================================================
// 2. WebSocket 服务器 (无变化)
// ==============================================================================
const wss = new WebSocketServer({ port: CONFIG.WEBSOCKET_PORT });
wss.on('connection', (ws) => {
    console.log('[WebSocket] 网页播放器已连接。');
    const sendMessage = (type, data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
    };
    ws.on('message', async (message) => {
        try {
            const request = JSON.parse(message);
            if (request.type === 'download' && request.data) {
                console.log(`[WebSocket] 收到下载请求:`, request.data);
                await handleDownloadRequest(request.data, sendMessage);
            }
            if (request.type === 'get_local_playlist') {
                console.log('[WebSocket] 收到获取本地播放列表的请求。');
                try {
                    if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
                        const playlistData = fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8');
                        sendMessage('local_playlist_data', JSON.parse(playlistData));
                    }
                } catch (e) { console.error(`[Playlist] 读取本地 playlist.json 失败:`, e); }
            }
        } catch (e) { console.error('[WebSocket] 解析消息失败:', e); sendMessage('error', '无效的请求格式。'); }
    });
    ws.on('close', () => console.log('[WebSocket] 网页播放器已断开连接。'));
    ws.on('error', (error) => console.error('[WebSocket] 发生错误:', error));
});
console.log(`[WebSocket] 下载代理服务器已启动，正在监听 ws://localhost:${CONFIG.WEBSOCKET_PORT}`);
console.log('-------------------------------------------------------------------\n');


// ==============================================================================
// 3. 请求处理器与逻辑分发 (无变化)
// ==============================================================================
async function handleDownloadRequest(requestData, sendMessage) {
    let url, downloadType;

    if (typeof requestData === 'string') {
        url = requestData;
        downloadType = 'single';
    } else {
        url = requestData.url;
        downloadType = requestData.downloadType;
    }

    sendMessage('status', '开始处理，正在提取URL...');
    const match = url.match(/(https?:\/\/[^\s]+)|(MS4wLjABAAAA[^\s]+)/);
    if (!match) {
        sendMessage('error', '错误：未在文本中找到有效的URL或用户ID。');
        return;
    }
    let startUrl = match[0];
    if (startUrl.startsWith('MS4wLjAB')) {
        startUrl = `https://www.douyin.com/user/${startUrl}`;
    }
    sendMessage('status', `成功提取目标: ${startUrl}`);

    if (downloadType === 'single') {
        await downloadSingleVideo(startUrl, sendMessage);
    } else {
        await downloadUserContent(startUrl, downloadType, sendMessage);
    }
}

// ==============================================================================
// 4. 核心下载逻辑
// ==============================================================================

async function downloadSingleVideo(videoUrl, sendMessage) {
    const targetApiUrl = "aweme/v1/web/aweme/detail/";
    let browser;
    try {
        sendMessage('status', '正在启动隐身浏览器 (单视频模式)...');
        browser = await playwright.launch({ headless: CONFIG.HEADLESS_MODE });
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        const page = await context.newPage();

        const apiResponsePromise = new Promise((resolve, reject) => {
            page.on('response', async (response) => {
                if (response.url().includes(targetApiUrl) && response.status() === 200) {
                    sendMessage('status', `成功拦截到目标API: ${response.url()}`);
                    try { resolve(await response.json()); } catch (e) { reject(new Error(`解析API响应为JSON时出错: ${e.message}`)); }
                }
            });
        });

        sendMessage('status', `正在导航至目标页面...`);
        // 【修改】页面导航超时从 45 秒增加到 90 秒
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

        const apiResponseJson = await Promise.race([
            apiResponsePromise,
            // 【修改】API 拦截超时从 30 秒增加到 60 秒
            new Promise((_, reject) => setTimeout(() => reject(new Error('API拦截超时')), 60000))
        ]);

        if (!apiResponseJson) {
            sendMessage('error', '未能拦截到有效的API响应，下载失败。');
            return;
        }

        const awemeDetail = apiResponseJson?.aweme_detail;
        if (!awemeDetail) {
            sendMessage('error', 'API响应中缺少关键的 aweme_detail 数据。');
            return;
        }

        await processAndDownloadItem(awemeDetail, sendMessage);
        sendMessage('success', `视频下载完成！已将新媒体项添加到播放列表。`);

    } catch (error) {
        sendMessage('error', `浏览器操作失败: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
            sendMessage('status', '浏览器已关闭。');
        }
    }
}


async function downloadUserContent(userUrl, downloadType, sendMessage) {
    const configs = {
        works: {
            api: "aweme/v1/web/aweme/post/",
            tabSelector: '[data-e2e="user-tab-post"]',
            listSelector: 'div[data-e2e="user-post-list"]',
            name: "作品"
        },
        likes: {
            api: "aweme/v1/web/aweme/favorite/",
            tabSelector: '#semiTablike',
            listSelector: 'div[data-e2e="user-like-list"]',
            name: "喜欢"
        }
    };
    const currentConfig = configs[downloadType];
    if (!currentConfig) {
        sendMessage('error', `无效的下载类型: ${downloadType}`);
        return;
    }

    let browser;
    try {
        sendMessage('status', `启动浏览器 (用户${currentConfig.name}模式)...`);
        browser = await playwright.launch({ headless: CONFIG.HEADLESS_MODE });
        const contextOptions = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' };
        if (fs.existsSync(CONFIG.STATE_PATH)) {
            sendMessage('status', '发现已有会话状态，正在加载...');
            contextOptions.storageState = CONFIG.STATE_PATH;
        }
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        sendMessage('status', `正在导航至用户主页...`);
        // 【修改】页面导航超时从 60 秒增加到 120 秒
        await page.goto(userUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

        // 【新增】调用函数关闭登录弹窗
        await closeLoginModalIfNeeded(page, sendMessage);

        if (downloadType === 'likes') {
            sendMessage('status', `正在切换到 "${currentConfig.name}" 列表...`);
            try {
                // 【修改】等待 “喜欢” 标签的超时时间从 10 秒增加到 20 秒
                await page.waitForSelector(currentConfig.tabSelector, { state: 'visible', timeout: 20000 });
                await page.click(currentConfig.tabSelector);
            } catch (e) {
                sendMessage('error', `切换到 "${currentConfig.name}" 列表失败，可能是用户隐藏了此列表或页面结构已更新。`);
                return;
            }
        }

        sendMessage('status', `页面加载中，等待${currentConfig.name}列表出现...`);
        // 【修改】等待作品列表的超时时间从 30 秒增加到 60 秒
        await page.waitForSelector(currentConfig.listSelector, { timeout: 60000 });
        sendMessage('status', `${currentConfig.name}列表已加载，开始抓取...`);

        let hasMore = true;
        let pageNum = 1;
        let downloadedCount = 0;
        const seenAwemeIds = new Set();

        while (hasMore) {
            const apiResponsePromise = new Promise((resolve, reject) => {
                const responseHandler = async (response) => {
                    if (response.url().includes(currentConfig.api)) {
                        page.removeListener('response', responseHandler);
                        try { resolve(await response.json()); } catch (e) { reject(new Error("解析API失败: " + e.message)); }
                    }
                };
                page.on('response', responseHandler);
            });

            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            sendMessage('status', `正在滚动加载第 ${pageNum} 页${currentConfig.name}...`);
            await randomDelay(500, 1000);

            const postData = await Promise.race([
                apiResponsePromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('获取API超时')), 20000))
            ]);

            if (!postData || !postData.aweme_list || postData.aweme_list.length === 0) {
                sendMessage('status', 'API未返回列表，可能已到达末页。');
                break;
            }

            hasMore = postData.has_more;
            const worksOnPage = postData.aweme_list;
            const newWorks = worksOnPage.filter(work => !seenAwemeIds.has(work.aweme_id));

            if (newWorks.length === 0 && worksOnPage.length > 0) {
                sendMessage('status', `第 ${pageNum} 页未发现新作品，可能已全部加载。`);
                hasMore = false;
                break;
            }

            sendMessage('status', `第 ${pageNum} 页获取成功，发现 ${newWorks.length} 个新${currentConfig.name}。`);

            for (const item of newWorks) {
                seenAwemeIds.add(item.aweme_id);
                sendMessage('status', `[${++downloadedCount}] 开始处理: ${item.desc || "无标题视频"}`);
                await processAndDownloadItem(item, sendMessage);
            }

            if (hasMore) {
                pageNum++;
                const delay = CONFIG.USER_WORKS_DELAY_MIN + Math.random() * (CONFIG.USER_WORKS_DELAY_MAX - CONFIG.USER_WORKS_DELAY_MIN);
                const jitter = (Math.random() - 0.5) * 2 * CONFIG.USER_WORKS_DELAY_JITTER;
                const finalDelay = Math.round(delay + jitter);

                sendMessage('status', `本页处理完毕。延迟 ${(finalDelay / 1000).toFixed(1)} 秒后获取下一页...`);
                await new Promise(resolve => setTimeout(resolve, finalDelay));
            }
        }

        sendMessage('success', `所有${currentConfig.name}下载完成！共处理 ${downloadedCount} 个视频。`);
        await context.storageState({ path: CONFIG.STATE_PATH });
        sendMessage('status', '会话状态已保存。');

    } catch (error) {
        sendMessage('error', `批量下载失败: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
            sendMessage('status', '浏览器已关闭。');
        }
    }
}


async function processAndDownloadItem(awemeDetail, sendMessage) {
    const awemeId = awemeDetail?.aweme_id;
    if (!awemeId) {
        sendMessage('status', '警告: 作品缺少 aweme_id，跳过。');
        return;
    }

    try {
        const downloadPromises = [];
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const staticCoverUrl = awemeDetail?.video?.cover?.url_list?.[0];

        if (videoUri) {
            const videoUrl = `https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`;
            downloadPromises.push(downloadFile(videoUrl, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`, `视频 ${awemeId}`, sendMessage));
        }
        if (staticCoverUrl) {
            downloadPromises.push(downloadFile(staticCoverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`, `封面 ${awemeId}`, sendMessage));
        }

        if (downloadPromises.length === 0) {
            sendMessage('status', `警告: 作品 ${awemeId} 无有效下载链接，跳过。`);
            return;
        }

        await Promise.all(downloadPromises);

        const { pinyin } = await import('pinyin-pro');
        const title = awemeDetail.desc || "无标题视频";
        const newTrack = {
            title: title,
            artist: awemeDetail.author?.nickname || "未知作者",
            src: `http://localhost:${CONFIG.HTTP_PORT}/${CONFIG.VIDEOS_DIR}/${awemeId}.mp4`,
            albumArt: `http://localhost:${CONFIG.HTTP_PORT}/${CONFIG.ALBUMART_DIR}/${awemeId}.jpg`,
            type: "video", lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        await updateLocalPlaylist(newTrack);
        sendMessage('new_track', newTrack);
    } catch (downloadError) {
        sendMessage('error', `下载作品 ${awemeId} 时发生错误: ${downloadError.message}`);
    }
}

// ==============================================================================
// 5. 通用文件下载函数
// ==============================================================================
async function downloadFile(url, folder, fileName, description, sendMessage) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) {
        sendMessage('status', `文件 ${fileName} 已存在，跳过下载。`);
        return;
    }
    sendMessage('status', ` -> 开始下载 ${description}...`);
    try {
        const response = await axios({
            method: 'get', url, responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
            // 【修改】下载文件本身的超时时间从 60 秒增加到 120 秒
            timeout: 120000,
        });
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => { sendMessage('status', ` -> 下载成功: ${fileName}`); resolve(); });
            writer.on('error', (err) => { fs.unlink(filePath, () => {}); reject(err); });
        });
    } catch (e) { throw new Error(`下载 ${description} 失败: ${e.message}`); }
}

// ==============================================================================
// 6. 本地播放列表管理 (无变化)
// ==============================================================================
async function updateLocalPlaylist(newTrack) {
    let playlist = [];
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error(`[Playlist] 解析本地 playlist.json 失败，将创建新文件:`, e);
        playlist = [];
    }

    if (playlist.some(track => track.src === newTrack.src)) {
        console.log(`[Playlist] 曲目 "${newTrack.title}" 已存在，跳过添加。`);
        return;
    }

    playlist.unshift(newTrack);

    try {
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist, null, 2));
        console.log(`[Playlist] 成功更新本地 playlist.json，已添加 "${newTrack.title}"。`);
    } catch (e) {
        console.error(`[Playlist] 写入本地 playlist.json 失败:`, e);
    }
}