// src/renderer/js/features/downloader.js

import * as dom from '../dom.js';
import * as ui from '../ui.js';
import * as mediaService from '../services/mediaService.js';
import { subscribe } from '../state.js';
import { getTemplate } from '../utils.js';
import * as ICONS from '../icons.js';

// --- 模块私有状态 ---
let currentSearchResults = [];
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 20;

const activeCacheDownloads = new Set();

// =========================================================================
// 【核心修改】精简前端策略类
// 不再需要为 B 站和 YouTube 定义单独的类，UI 提示逻辑将更加通用。
// =========================================================================
class DownloadStrategy {
    isApplicable(url) { throw new Error("策略必须实现 isApplicable 方法。"); }
    getDescription() { throw new Error("策略必须实现 getDescription 方法。"); }
    execute(url) { window.electronAPI.startDownload(url); }
}

class JableStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('jable.tv/videos/'); }
    getDescription() { return '检测到Jable链接，点击“开始下载”进行处理。'; }
}

class DouyinStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('douyin.com') || url.includes('iesdouyin.com'); }
    getDescription() { return '检测到抖音链接，点击“开始下载”进行处理。'; }
    execute(url) {
        const isShortLink = url.includes('v.douyin.com');
        const hasVideoId = /\/(?:video|note)\/\d+/.test(url);
        const hasModalId = /modal_id=\d+/.test(url);
        if (!isShortLink && !hasVideoId && !hasModalId) {
            const errorMsg = '无法识别的抖音链接格式。\n请进入视频详情页复制链接，或使用分享短链。';
            ui.showToast(errorMsg, 'error');
            throw new Error('Invalid Douyin URL');
        }
        window.electronAPI.startDownload(url);
    }
}

class IyfStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('iyf.lv') || url.includes('iyf.tv'); }
    getDescription() { return '检测到爱壹帆(IYF)链接，点击“开始下载”进行处理。'; }
}

// 仅保留专用策略
const downloadStrategies = [
    new JableStrategy(),
    new DouyinStrategy(),
    new IyfStrategy()
];
// =========================================================================

function findStrategyFor(url) {
    if (!url) return null;
    return downloadStrategies.find(s => s.isApplicable(url)) || null;
}

// --- 核心逻辑 ---

function transformApiData(apiTrack) {
    return {
        id: apiTrack.id,
        title: apiTrack.name,
        artist: Array.isArray(apiTrack.artist) ? apiTrack.artist.join(' / ') : apiTrack.artist,
        album: apiTrack.album,
        pic_id: apiTrack.pic_id,
        lyric_id: apiTrack.lyric_id,
        url_id: apiTrack.url_id,
        source: apiTrack.source,
        type: 'audio',
        albumArt: '',
        originalSrc: `meting://${apiTrack.source}/${apiTrack.id}`
    };
}

function extractUrlFromInput(input) {
    const text = input.trim();
    if (!text) return '';
    const protocolMatch = text.match(/https?:\/\/[^\s]+/);
    if (protocolMatch) return protocolMatch[0];

    // 简化URL提取逻辑，主要依赖 http/https 协议头
    return '';
}

function updateInputMode() {
    if (dom.startDownloadBtn.classList.contains('downloading')) return;

    const text = dom.urlOrSearchInput.value;
    const url = extractUrlFromInput(text);
    const strategy = findStrategyFor(url);

    const isUrlMode = !!url; // 只要是URL，就进入URL下载模式
    dom.startDownloadBtn.style.display = isUrlMode ? 'flex' : 'none';
    dom.searchOnlineBtn.style.display = isUrlMode ? 'none' : 'flex';

    if (strategy) {
        dom.panelDescription.textContent = strategy.getDescription();
    } else if (url) {
        // 【核心修改】通用下载提示
        dom.panelDescription.textContent = '检测到链接，将使用通用引擎处理 (支持B站/YouTube等)。';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴视频链接进行本地下载。';
    }
}

function updateStatus(message, type = 'default', progress) {
    const statusEl = dom.downloadStatusEl;
    const progressContainer = document.querySelector('.download-progress-container');
    const progressBar = document.querySelector('.download-progress-bar');
    statusEl.textContent = message;
    statusEl.className = 'download-status';
    if (type === 'success') statusEl.classList.add('success');
    else if (type === 'error') statusEl.classList.add('error');
    statusEl.style.display = 'block';
    if (type === 'progress' && typeof progress === 'number') {
        progressContainer.style.display = 'block';
        progressBar.style.width = `${Math.min(100, progress * 100)}%`;
    } else {
        progressContainer.style.display = 'none';
        progressBar.style.width = '0%';
    }
}

function createResultItem(track, index, isCached = false) {
    const itemNode = getTemplate('template-search-result-item');
    const itemEl = itemNode.querySelector('.playlist-item');
    itemEl.dataset.index = index;
    itemEl.dataset.src = track.originalSrc;
    itemEl.querySelector('.playlist-icon').textContent = '🎵';
    itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
    itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';

    const placeholders = itemEl.querySelectorAll('.icon-placeholder');
    const iconMap = {
        DOWNLOAD: ICONS.ICON_DOWNLOAD,
        SPINNER: ICONS.ICON_SPINNER,
        CACHED: ICONS.ICON_CACHED,
        STOP: ICONS.ICON_STOP
    };
    placeholders.forEach(ph => {
        const iconName = ph.dataset.icon;
        if (iconMap[iconName]) ph.outerHTML = iconMap[iconName];
    });

    const downloadBtn = itemEl.querySelector('.playlist-download-btn');
    downloadBtn.classList.toggle('cached', isCached);

    if (activeCacheDownloads.has(track.id)) {
        downloadBtn.classList.add('downloading');
        downloadBtn.title = "取消下载";
    }

    return itemNode;
}

async function performSearch(query, page = 1) {
    if (!query) {
        ui.showToast('请输入歌曲名或歌手名！', 'error');
        return;
    }
    if (page === 1) ui.clearSearchResults(dom.searchResultsList);

    const searchBtn = dom.searchOnlineBtn;
    searchBtn.disabled = true;
    searchBtn.classList.add('loading');
    updateStatus(`正在搜索 "${query}" (第 ${page} 页)...`);

    const data = await mediaService.searchOnline(query, page);

    if (data) {
        const { results, total } = data;
        currentSearchResults = results.map(transformApiData);
        ui.renderSearchResults(dom.searchResultsList, currentSearchResults, createResultItem);
        currentSearchQuery = query;
        currentPage = page;
        totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
        ui.renderPaginationControls(dom.paginationControls, currentPage, totalPages);
        updateStatus(`搜索成功！显示 ${results.length} 首歌曲。`, 'success');
    } else {
        updateStatus('搜索失败，请检查网络或稍后重试。', 'error');
        ui.renderPaginationControls(dom.paginationControls, 0, 0);
    }

    searchBtn.disabled = false;
    searchBtn.classList.remove('loading');
}

async function handleLocalImportClick() {
    const importBtn = dom.importLocalBtn;
    [importBtn, dom.searchOnlineBtn, dom.startDownloadBtn].forEach(btn => btn.disabled = true);
    importBtn.classList.add('loading');
    updateStatus('等待选择资源目录...');
    try {
        const result = await window.electronAPI.selectImportDirectory();
        if (result.canceled) {
            updateStatus('已取消导入操作。');
        } else {
            updateStatus('已选择目录，开始导入...');
            const shouldCopy = dom.copyToLibraryCheckbox ? dom.copyToLibraryCheckbox.checked : true;
            await window.electronAPI.startLocalImport(result.filePaths[0], shouldCopy);
        }
    } catch (error) {
        ui.showToast(`导入出错: ${error.message}`, 'error');
    } finally {
        [importBtn, dom.searchOnlineBtn, dom.startDownloadBtn].forEach(btn => btn.disabled = false);
        importBtn.classList.remove('loading');
    }
}

async function handleMissingTool(toolName, featureName) {
    const toolDisplayName = toolName === 'ffmpeg' ? 'FFmpeg' : 'yt-dlp';
    try {
        await ui.showConfirmationModal(
            `${featureName}功能需要${toolDisplayName}组件。\n\n是否自动下载安装？`,
            { confirmText: "自动下载", cancelText: "手动说明" }
        );
        const result = await window.electronAPI.downloadCoreTool(toolName);
        if (result.success) ui.showToast(`${toolDisplayName}安装成功！请重试。`, 'success');
        else ui.showToast(`安装失败: ${result.error}`, 'error');
    } catch (rejectionType) {
        if (rejectionType === 'cancel') {
            ui.showConfirmationModal(`请将${toolDisplayName}放入应用数据目录。`, { confirmText: "打开目录" })
                .then(() => window.electronAPI.openToolsFolder()).catch(() => {});
        }
    }
}

export function setupDownloaderListeners() {
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);

    dom.searchOnlineBtn.addEventListener('click', () => performSearch(dom.urlOrSearchInput.value.trim(), 1));

    dom.startDownloadBtn.addEventListener('click', () => {
        const btn = dom.startDownloadBtn;

        if (btn.classList.contains('downloading')) {
            window.electronAPI.cancelDownload(null, 'url-download');
            return;
        }

        const url = extractUrlFromInput(dom.urlOrSearchInput.value);
        if (!url) {
            updateStatus('请输入有效的URL。', 'error');
            return;
        }

        try {
            // 直接发送下载请求，后端会自行选择策略
            window.electronAPI.startDownload(url);

            btn.classList.add('downloading', 'danger-mode');
            const btnText = btn.querySelector('.btn-text');
            if (btnText) btnText.textContent = '取消下载';

        } catch (e) {
            // 理论上不会到这里，因为不再有前端策略的 execute
        }
    });

    dom.importLocalBtn.addEventListener('click', handleLocalImportClick);

    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const track = currentSearchResults[parseInt(item.dataset.index, 10)];
        if (!track) return;

        const downloadBtn = e.target.closest('.playlist-download-btn');

        if (downloadBtn && !downloadBtn.classList.contains('cached')) {
            e.stopPropagation();
            if (downloadBtn.classList.contains('downloading')) {
                window.electronAPI.cancelDownload(track.id, 'cache-download');
                downloadBtn.classList.remove('downloading');
                downloadBtn.title = "下载到本地";
                activeCacheDownloads.delete(track.id);
            } else {
                activeCacheDownloads.add(track.id);
                ui.updateSearchResultItemStatus(item, 'downloading');
                downloadBtn.title = "取消下载";
                mediaService.cacheTrack(track);
            }
        } else if (!downloadBtn) {
            mediaService.playTemporaryTrack(track);
        }
    });

    dom.paginationControls.addEventListener('click', (e) => {
        const target = e.target.closest('button:not(:disabled)');
        if (!target) return;
        if (target.id === 'prev-page-btn') performSearch(currentSearchQuery, currentPage - 1);
        else if (target.id === 'next-page-btn') performSearch(currentSearchQuery, currentPage + 1);
    });

    window.electronAPI.onDownloadStatus((status) => {
        if (status.reason === 'tool_missing') {
            handleMissingTool(status.missing, "该下载");
        }
        updateStatus(status.message, status.type, status.progress);

        if (status.type === 'success' || status.type === 'error') {
            const dlBtn = dom.startDownloadBtn;
            dlBtn.disabled = false;
            dlBtn.classList.remove('loading', 'downloading', 'danger-mode');
            const btnText = dlBtn.querySelector('.btn-text');
            if (btnText) btnText.textContent = '开始下载';

            dom.importLocalBtn.disabled = false;
            dom.importLocalBtn.classList.remove('loading');

            if (status.type === 'error' && status.message.includes('取消')) {
                updateInputMode();
            }
        }
    });

    window.electronAPI.onImportStatus((status) => {
        updateStatus(status.message, status.type);
        if (status.type === 'success' && status.importedCount > 0) {
            window.location.reload();
        }
    });

    subscribe('playlistChanged', (newPlaylist) => {
        if (currentSearchResults.length === 0 || !dom.searchResultsList) return;
        const resultItems = dom.searchResultsList.querySelectorAll('.playlist-item');
        resultItems.forEach(item => {
            const index = parseInt(item.dataset.index, 10);
            if (isNaN(index) || !currentSearchResults[index]) return;
            const searchResultTrack = currentSearchResults[index];

            const isNowCached = newPlaylist.some(pTrack =>
                pTrack.id === searchResultTrack.id && pTrack.source === searchResultTrack.source
            );

            if (isNowCached) {
                ui.updateSearchResultItemStatus(item, 'cached');
                activeCacheDownloads.delete(searchResultTrack.id);
            }
        });
    });
}