// js/features/downloader.js (Upgraded with dynamic buttons)

import * as dom from '../dom.js';
import { showToast } from '../ui.js';

const WEBSOCKET_URL = 'ws://localhost:9527';
let socket = null;
let reconnectInterval = 3000;
let reconnectTimer = null;

// --- DOM 元素 (引导视图) ---
const setupView = document.getElementById('setup-view');
const downloaderView = document.getElementById('downloader-view');
const copyInstallCommandBtn = document.getElementById('copy-command-btn-install');
const copyRunCommandBtn = document.getElementById('copy-command-btn-run');
const connectionStatusText = document.getElementById('connection-status-text');

/**
 * 【新增】根据输入内容更新下载按钮的显示状态
 */
function updateDownloadButtons() {
    const urlText = dom.douyinUrlInput.value.trim();
    const isUserUrl = urlText.includes('/user/') || urlText.startsWith('MS4wLjAB');

    if (isUserUrl) {
        dom.startDownloadBtn.style.display = 'none';
        dom.downloadWorksBtn.style.display = 'flex';
        dom.downloadLikesBtn.style.display = 'flex';
    } else {
        dom.startDownloadBtn.style.display = 'flex';
        dom.downloadWorksBtn.style.display = 'none';
        dom.downloadLikesBtn.style.display = 'none';
    }
}

function switchView(isConnected) {
    if (isConnected) {
        setupView.style.display = 'none';
        downloaderView.style.display = 'flex';
        updateDownloadButtons(); // 连接成功时也更新一次按钮
        [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn].forEach(btn => {
            btn.disabled = false;
            btn.classList.remove('loading');
        });
        dom.downloadStatusEl.style.display = 'none';
        dom.douyinUrlInput.value = '';
    } else {
        setupView.style.display = 'flex';
        downloaderView.style.display = 'none';
        connectionStatusText.textContent = '正在尝试连接本地代理...';
    }
}

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    socket = new WebSocket(WEBSOCKET_URL);
    connectionStatusText.textContent = '正在尝试连接本地代理...';

    socket.onopen = () => {
        console.log('成功连接到本地下载代理。');
        switchView(true);
        socket.send(JSON.stringify({ type: 'get_local_playlist' }));
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleAgentMessage(message.type, message.data);
        } catch (e) {
            console.error('无法解析来自代理的消息:', event.data);
        }
    };

    socket.onclose = () => {
        console.log('与本地下载代理的连接已断开。');
        socket = null;
        switchView(false);
        reconnectTimer = setTimeout(connectWebSocket, reconnectInterval);
    };

    socket.onerror = () => {
        connectionStatusText.textContent = '连接失败，请检查代理是否已启动。';
    };
}

function handleAgentMessage(type, data) {
    const allButtons = [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn];
    switch (type) {
        case 'status':
            updateStatus(data, 'default');
            break;
        case 'error':
            updateStatus(`错误: ${data}`, 'error');
            allButtons.forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
            break;
        case 'success':
            updateStatus(data, 'success');
            allButtons.forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
            dom.douyinUrlInput.value = '';
            updateDownloadButtons(); // 成功后重置按钮状态
            break;
        case 'new_track':
            document.dispatchEvent(new CustomEvent('new-track-added', { detail: data }));
            break;
        case 'local_playlist_data':
            if (data && data.length > 0) {
                document.dispatchEvent(new CustomEvent('local-playlist-loaded', { detail: data }));
            }
            break;
        default:
            console.warn(`收到未知的代理消息类型: ${type}`);
    }
}

function updateStatus(message, type) {
    const statusEl = dom.downloadStatusEl;
    statusEl.textContent = message;
    statusEl.className = 'download-status';
    if (type === 'success') statusEl.classList.add('success');
    else if (type === 'error') statusEl.classList.add('error');
    statusEl.style.display = 'block';
}

/**
 * 【修改】通用发送请求函数
 */
function sendRequest(clickedButton, downloadType = 'single') {
    const urlText = dom.douyinUrlInput.value;
    if (!urlText.trim()) {
        updateStatus('错误：请输入有效的分享文本。', 'error');
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        updateStatus('错误：未连接到本地代理。', 'error');
        return;
    }

    [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn].forEach(btn => {
        btn.disabled = true;
    });
    clickedButton.classList.add('loading');
    updateStatus('已发送请求到本地代理，请稍候...', 'default');

    // 【修改】根据下载类型发送不同结构的数据
    const requestData = downloadType === 'single'
        ? urlText
        : { url: urlText, downloadType: downloadType };

    socket.send(JSON.stringify({ type: 'download', data: requestData }));
}

function setupCopyButton(button, textToCopy) {
    if (!button) return;
    button.addEventListener('click', () => {
        navigator.clipboard.writeText(textToCopy).then(() => {
            button.classList.add('copied');
            setTimeout(() => button.classList.remove('copied'), 2000);
        }).catch(err => {
            showToast('复制失败: ' + err);
        });
    });
}

export function setupDownloaderListeners() {
    dom.downloadPanelBtn.addEventListener('click', () => {
        if (!socket) connectWebSocket();
    });

    dom.closeDownloadBtn.addEventListener('click', () => {
        clearTimeout(reconnectTimer);
        if (socket) {
            socket.onclose = null;
            socket.close();
            socket = null;
        }
    });

    setupCopyButton(copyInstallCommandBtn, 'npm install');
    setupCopyButton(copyRunCommandBtn, 'node agent.js');

    // 【新增】监听输入框，动态切换按钮
    dom.douyinUrlInput.addEventListener('input', updateDownloadButtons);

    // 【修改】为所有按钮绑定事件
    dom.startDownloadBtn.addEventListener('click', (e) => sendRequest(e.currentTarget, 'single'));
    dom.downloadWorksBtn.addEventListener('click', (e) => sendRequest(e.currentTarget, 'works'));
    dom.downloadLikesBtn.addEventListener('click', (e) => sendRequest(e.currentTarget, 'likes'));

    // 初始加载时尝试连接一次
    connectWebSocket();
}