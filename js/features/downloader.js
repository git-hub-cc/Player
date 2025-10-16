
import * as dom from '../dom.js';
import * as state from '../state.js';
import { showToast, clearSearchResults, renderSearchResults, updateSearchResultItemStatus, closeActivePanels } from '../ui.js';
import { playTemporaryTrack } from '../player.js';

const WEBSOCKET_URL = 'ws://localhost:9527';
const HTTP_PORT = 9528; // 与 agent.js 中的端口一致

let socket = null;
let reconnectInterval = 3000;
let reconnectTimer = null;
let currentSearchResults = [];
let isConnecting = false;

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

// --- [修改] 视图切换和连接状态更新逻辑 ---
function switchView(view) {
    if (view === 'setup') {
        dom.setupView.style.display = 'flex';
        dom.downloaderView.style.display = 'none';
        dom.connectionStatusLine.classList.add('error');
        dom.connectionSpinner.style.display = 'none';
        dom.connectionStatusText.textContent = '连接失败，请检查代理是否已启动。';
        dom.retryConnectionBtn.style.display = 'flex';
        dom.retryConnectionBtn.disabled = false;
    } else { // 'downloader' or initial state
        dom.setupView.style.display = 'none';
        dom.downloaderView.style.display = 'flex';
        updateInputMode();
    }
}

function updateConnectionStatus(status, message) {
    dom.connectionStatusLine.classList.remove('error');
    dom.retryConnectionBtn.style.display = 'none';

    switch(status) {
        case 'connecting':
            dom.setupView.style.display = 'flex';
            dom.downloaderView.style.display = 'none';
            dom.connectionSpinner.style.display = 'block';
            dom.connectionStatusText.textContent = message || '正在尝试连接本地代理...';
            dom.retryConnectionBtn.disabled = true;
            isConnecting = true;
            break;
        case 'connected':
            switchView('downloader');
            isConnecting = false;
            break;
        case 'failed':
            switchView('setup');
            isConnecting = false;
            break;
    }
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) || isConnecting) return;

    updateConnectionStatus('connecting');

    socket = new WebSocket(WEBSOCKET_URL);

    socket.onopen = () => {
        console.log('成功连接到本地下载代理。');
        updateConnectionStatus('connected');
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
        if (dom.downloadPanel.classList.contains('active')) {
            updateConnectionStatus('failed');
        }
        isConnecting = false;
    };

    socket.onerror = () => {
        console.error('WebSocket 连接失败。');
        socket = null; // 确保在 onclose 前清除
        if (dom.downloadPanel.classList.contains('active')) {
            updateConnectionStatus('failed');
        }
        isConnecting = false;
    };
}


/**
 * [新增] 向代理发送删除曲目的请求
 * @param {object} track - 要删除的曲目对象
 */
export function requestTrackDeletion(track) {
    if (!checkConnectionAndShowSetup()) {
        showToast('删除失败：未连接到本地代理。', 'error');
        return;
    }

    // 从完整的URL中提取相对路径，这是后端识别文件的关键
    const AGENT_BASE_URL = `http://localhost:${HTTP_PORT}/`;
    const relativeSrc = track.src.startsWith(AGENT_BASE_URL)
        ? track.src.substring(AGENT_BASE_URL.length)
        : track.src;

    console.log(`[Deletion] 请求删除: ${relativeSrc}`);
    socket.send(JSON.stringify({
        type: 'delete_track',
        data: { src: relativeSrc }
    }));
}


// [新增] 请求获取音乐 URL
export function resolvePlayableUrl(track) {
    return new Promise((resolve, reject) => {
        // 如果是本地文件或已缓存的代理文件，直接返回
        if (track.src && !track.src.startsWith('http')) {
            return resolve(track.src);
        }
        if (track.src && track.src.startsWith(`http://localhost:${HTTP_PORT}`)) {
            return resolve(track.src);
        }

        if (!checkConnectionAndShowSetup()) {
            return reject(new Error('未连接到本地代理'));
        }

        const requestId = `req_${Date.now()}_${Math.random()}`;

        const messageHandler = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'music_url' && message.data.requestId === requestId) {
                    socket.removeEventListener('message', messageHandler);
                    if (message.data.url) {
                        resolve(message.data.url);
                    } else {
                        reject(new Error(message.data.error || '未能获取播放链接'));
                    }
                }
            } catch (e) { /* ignore */ }
        };

        socket.addEventListener('message', messageHandler);

        // 设置超时
        setTimeout(() => {
            socket.removeEventListener('message', messageHandler);
            reject(new Error('获取播放链接超时'));
        }, 20000); // 20秒超时

        // 发送请求
        socket.send(JSON.stringify({
            type: 'get_music_url',
            data: {
                requestId,
                musicInfo: track,
                quality: '128k', // 暂时硬编码，后续可从设置中读取
            }
        }));
    });
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
        case 'new_track':
            // 注意：此处不再调用 renderDownloadedItem
            document.dispatchEvent(new CustomEvent('new-track-added', { detail: data }));
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
        default:
            console.warn(`收到未知的代理消息类型: ${type}`);
    }
}

function checkConnectionAndShowSetup() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus('未连接到本地代理，请先启动代理程序。', 'error');
        updateConnectionStatus('failed'); // 切换到引导页
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


function setupSearchResultsListener() {
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;

        const downloadBtn = e.target.closest('.playlist-download-btn');
        const trackIndex = parseInt(item.dataset.index, 10);
        const clickedTrack = currentSearchResults[trackIndex];

        if (downloadBtn && !downloadBtn.classList.contains('cached')) {
            e.stopPropagation();
            if (clickedTrack) {
                updateSearchResultItemStatus(item, 'downloading');
                requestTrackCache(clickedTrack);
            }
        } else {
            // 【核心修改】直接播放临时曲目，不修改下载列表
            if (clickedTrack) {
                playTemporaryTrack(clickedTrack);
                closeActivePanels(); // 播放后关闭面板
            }
        }
    });
}

export function setupDownloaderListeners() {
    // [修改] 打开面板时，总是尝试连接
    dom.downloadPanelBtn.addEventListener('click', connectWebSocket);

    // [新增] 重试按钮点击事件
    dom.retryConnectionBtn.addEventListener('click', connectWebSocket);

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

    setupSearchResultsListener();

    // 初始加载时尝试连接一次
    connectWebSocket();
}