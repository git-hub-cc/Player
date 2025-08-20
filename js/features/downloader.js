// js/features/downloader.js (合并在线搜索与抖音下载功能，并增加后台缓存)

import * as dom from '../dom.js';
import * as state from '../state.js';
import { showToast, clearSearchResults, renderSearchResults, renderDownloadedItem, updateSearchResultItemStatus, renderPlaylist, closeActivePanels } from '../ui.js';
import { loadTrack } from '../player.js';

const WEBSOCKET_URL = 'ws://localhost:9527';
const HTTP_PORT = 9528; // 与 agent.js 中的端口一致

let socket = null;
let reconnectInterval = 3000;
let reconnectTimer = null;
let currentSearchResults = []; // 【新增】用于暂存搜索结果

/**
 * 创建指向本地代理的URL
 */
function createProxyUrl(originalUrl) {
    if (!originalUrl || originalUrl.startsWith(`http://localhost:${HTTP_PORT}`)) {
        return originalUrl || '';
    }
    return `http://localhost:${HTTP_PORT}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * 将API数据转换为内部格式，同时保存原始和代理URL
 */
function transformApiData(apiTrack) {
    const { pinyin } = window.pinyinPro;
    const title = apiTrack.title || '未知标题';
    return {
        title: title,
        artist: apiTrack.author || '未知艺术家',
        src: createProxyUrl(apiTrack.url),
        albumArt: createProxyUrl(apiTrack.pic),
        lyrics: apiTrack.lrc,
        type: 'audio',
        originalSrc: apiTrack.url,
        originalAlbumArt: apiTrack.pic,
        originalLyrics: apiTrack.lrc,
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };
}

// ... updateInputMode, switchView, connectWebSocket 等函数保持不变 ...
function updateInputMode() {
    const inputText = dom.urlOrSearchInput.value.trim();
    const isUrlMode = inputText.toLowerCase().includes('http');

    const isUserUrl = isUrlMode && (inputText.includes('/user/') || inputText.includes('MS4wLjAB'));
    dom.downloadWorksBtn.style.display = isUserUrl ? 'flex' : 'none';
    dom.downloadLikesBtn.style.display = isUserUrl ? 'flex' : 'none';
    dom.startDownloadBtn.style.display = isUrlMode && !isUserUrl ? 'flex' : 'none';

    dom.searchNeteaseBtn.style.display = isUrlMode ? 'none' : 'flex';

    if (isUrlMode) {
        dom.panelDescription.textContent = '检测到链接，已切换至抖音下载模式。需要本地代理程序运行。';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴抖音分享链接进行本地下载。';
    }
}

function switchView(view) {
    if (view === 'setup') {
        dom.setupView.style.display = 'flex';
        dom.downloaderView.style.display = 'none';
        dom.connectionStatusText.textContent = '连接失败，请检查代理是否已启动。';
    } else {
        dom.setupView.style.display = 'none';
        dom.downloaderView.style.display = 'flex';
        updateInputMode();
    }
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    socket = new WebSocket(WEBSOCKET_URL);

    socket.onopen = () => {
        console.log('成功连接到本地下载代理。');
        switchView('downloader');
        socket.send(JSON.stringify({ type: 'get_local_playlist' }));
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleAgentMessage(message.type, message.data);
        } catch (e) { console.error('无法解析来自代理的消息:', event.data); }
    };

    socket.onclose = () => {
        console.log('与本地下载代理的连接已断开。');
        socket = null;
        updateInputMode();
    };

    socket.onerror = () => {
        console.error('WebSocket 连接失败。');
        socket = null;
    };
}

function handleAgentMessage(type, data) {
    const allButtons = [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn, dom.searchNeteaseBtn];
    const unLoading = () => allButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('loading');
    });

    switch (type) {
        case 'status':
            updateStatus(data);
            break;
        case 'error':
            updateStatus(`错误: ${data}`, 'error');
            unLoading();
            break;
        case 'success':
            updateStatus(data, 'success');
            unLoading();
            break;
        case 'new_track': // 来自抖音下载或音频缓存
            renderDownloadedItem(data);
            document.dispatchEvent(new CustomEvent('new-track-added', { detail: data }));
            // 找到搜索结果列表中的对应项并更新其状态为 "cached"
            const itemInSearchResults = dom.searchResultsList.querySelector(`.playlist-item[data-src="${data.originalSrc || data.src}"]`);
            if (itemInSearchResults) {
                updateSearchResultItemStatus(itemInSearchResults, 'cached');
            }
            break;
        case 'local_playlist_data':
            if (data && data.length > 0) document.dispatchEvent(new CustomEvent('local-playlist-loaded', { detail: data }));
            break;
        case 'search_results':
            currentSearchResults = data.map(transformApiData);
            renderSearchResults(currentSearchResults);
            updateStatus(`搜索成功！已加载 ${data.length} 首歌曲。`, 'success');
            unLoading();
            break;
        // 【关键修改】移除不再使用的 'track_cached' case
        default:
            console.warn(`收到未知的代理消息类型: ${type}`);
    }
}

// ... checkConnectionAndShowSetup, requestTrackCache, performSearch, sendDouyinRequest, updateStatus, setupCopyButton 等函数保持不变 ...

function checkConnectionAndShowSetup() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus('未连接到本地代理，请先启动代理程序。', 'error');
        switchView('setup');
        return false;
    }
    return true;
}

export function requestTrackCache(trackData) {
    if (!checkConnectionAndShowSetup()) {
        showToast('缓存失败：未连接到本地代理。');
        const item = dom.searchResultsList.querySelector(`.playlist-item[data-src="${trackData.originalSrc}"]`);
        if (item) updateSearchResultItemStatus(item, 'downloadable');
        return;
    }

    console.log(`[Cache] 发送缓存请求: ${trackData.title}`);
    socket.send(JSON.stringify({
        type: 'cache_track',
        data: trackData
    }));
}


function performSearch(searchType) {
    if (!checkConnectionAndShowSetup()) return;

    const query = dom.urlOrSearchInput.value.trim();
    if (!query) {
        showToast('请输入歌曲名或歌手名！');
        return;
    }

    clearSearchResults();

    const clickedButton = dom.searchNeteaseBtn;
    const allSearchButtons = [dom.searchNeteaseBtn];

    allSearchButtons.forEach(btn => btn.disabled = true);
    clickedButton.classList.add('loading');
    updateStatus(`正在从 [${searchType}] 源搜索 "${query}"...`);

    socket.send(JSON.stringify({
        type: 'search',
        data: { query, sourceType: searchType }
    }));
}

function sendDouyinRequest(clickedButton, downloadType = 'single') {
    if (!checkConnectionAndShowSetup()) return;

    const urlText = dom.urlOrSearchInput.value;
    if (!urlText.trim()) {
        updateStatus('错误：请输入有效的分享文本。', 'error');
        return;
    }

    clearSearchResults();

    const allDownloadButtons = [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn];
    allDownloadButtons.forEach(btn => btn.disabled = true);
    clickedButton.classList.add('loading');
    updateStatus('已发送请求到本地代理，请稍候...', 'default');

    const requestData = (downloadType === 'single') ? urlText : { url: urlText, downloadType };
    socket.send(JSON.stringify({ type: 'download', data: requestData }));
}

function updateStatus(message, type = 'default') {
    const statusEl = dom.downloadStatusEl;
    statusEl.textContent = message;
    statusEl.className = 'download-status';
    if (type === 'success') statusEl.classList.add('success');
    else if (type === 'error') statusEl.classList.add('error');
    statusEl.style.display = 'block';
}

function setupCopyButton(button, textToCopy) {
    if (!button) return;
    button.addEventListener('click', () => {
        navigator.clipboard.writeText(textToCopy).then(() => {
            button.classList.add('copied');
            setTimeout(() => button.classList.remove('copied'), 2000);
        }).catch(err => showToast('复制失败: ' + err));
    });
}


/**
 * 【新增】设置搜索/下载结果列表的事件监听器
 */
function setupSearchResultsListener() {
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;

        const downloadBtn = e.target.closest('.playlist-download-btn');
        const trackIndex = parseInt(item.dataset.index, 10);
        const clickedTrack = currentSearchResults[trackIndex];

        if (downloadBtn && !downloadBtn.classList.contains('cached')) {
            // --- 点击了下载按钮 ---
            e.stopPropagation();
            if (clickedTrack) {
                updateSearchResultItemStatus(item, 'downloading');
                // 发送包含原始URL的track对象
                requestTrackCache(clickedTrack);
            }
        } else {
            // --- 点击了列表项本身（播放） ---
            if (clickedTrack) {
                // 派发事件，让 main.js 处理播放逻辑
                document.dispatchEvent(new CustomEvent('play-search-result', { detail: clickedTrack }));
            }
        }
    });
}

export function setupDownloaderListeners() {
    dom.downloadPanelBtn.addEventListener('click', () => {
        if (!socket) connectWebSocket();
        switchView('downloader');
    });

    dom.closeDownloadBtn.addEventListener('click', () => {
        clearTimeout(reconnectTimer);
        if (socket) {
            socket.onclose = null;
            socket.close();
            socket = null;
        }
    });

    dom.urlOrSearchInput.addEventListener('input', updateInputMode);

    setupCopyButton(dom.copyInstallCommandBtn, 'npm install');
    setupCopyButton(dom.copyRunCommandBtn, 'node agent.js');

    dom.searchNeteaseBtn.addEventListener('click', () => performSearch('netease'));
    dom.startDownloadBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'single'));
    dom.downloadWorksBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'works'));
    dom.downloadLikesBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'likes'));

    setupSearchResultsListener(); // 【新增】
    connectWebSocket();
}