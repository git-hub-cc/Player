import * as dom from '../dom.js';
import { showToast, clearSearchResults, renderSearchResults, updateSearchResultItemStatus, renderPaginationControls } from '../ui.js';
import { playTemporaryTrack } from '../player.js';
import { pinyin } from 'pinyin-pro';

let currentSearchResults = [];
// --- [新增] 分页状态变量 ---
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 10; // API每页返回10个项目

/**
 * 将在线搜索 API 返回的数据转换为应用内部使用的标准格式。
 * @param {object} apiTrack - 从 API 获取的原始曲目数据。
 * @returns {object} - 转换后的曲目对象。
 */
function transformApiData(apiTrack) {
    const title = apiTrack.title || '未知标题';
    return {
        title: title,
        artist: apiTrack.author || '未知艺术家',
        src: apiTrack.url,
        albumArt: apiTrack.pic,
        lyrics: apiTrack.lrc,
        type: 'audio',
        source: apiTrack.source || 'netease',
        originalSrc: apiTrack.url,
        originalAlbumArt: apiTrack.pic,
        originalLyrics: apiTrack.lrc,
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };
}

/**
 * 根据输入框内容更新 UI 模式（URL 下载模式 vs. 关键词搜索模式）。
 */
function updateInputMode() {
    const inputText = dom.urlOrSearchInput.value.trim();
    const isUrlMode = inputText.toLowerCase().includes('http');

    const isUserUrl = isUrlMode && (inputText.includes('/user/') || inputText.includes('MS4wLjAB'));
    dom.downloadWorksBtn.style.display = isUserUrl ? 'flex' : 'none';
    dom.downloadLikesBtn.style.display = isUserUrl ? 'flex' : 'none';
    dom.startDownloadBtn.style.display = isUrlMode && !isUserUrl ? 'flex' : 'none';

    dom.searchNeteaseBtn.style.display = isUrlMode ? 'none' : 'flex';

    if (isUrlMode) {
        dom.panelDescription.textContent = '检测到链接，已切换至抖音下载模式。';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴抖音分享链接进行本地下载。';
    }
}

/**
 * 更新下载面板底部的状态信息。
 * @param {string} message - 要显示的消息。
 * @param {'default' | 'success' | 'error'} type - 消息类型。
 */
function updateStatus(message, type = 'default') {
    const statusEl = dom.downloadStatusEl;
    statusEl.textContent = message;
    statusEl.className = 'download-status';
    if (type === 'success') statusEl.classList.add('success');
    else if (type === 'error') statusEl.classList.add('error');
    statusEl.style.display = 'block';
}

/**
 * 向主进程请求删除一个已下载的曲目。
 * @param {object} track - 要删除的曲目对象。
 */
export async function requestTrackDeletion(track) {
    const relativeSrc = track.src.startsWith('media://')
        ? track.src.substring('media://'.length)
        : track.src;

    console.log(`[Deletion] 请求删除: ${relativeSrc}`);
    const result = await window.electronAPI.deleteTrack({ src: relativeSrc });
    if (result.success) {
        showToast(result.message, 'success');
    } else {
        showToast(result.error, 'error');
    }
    return result.success;
}

/**
 * 请求主进程解析一个曲目的可播放 URL，以解决 CORS 问题。
 * @param {object} track - 曲目信息对象。
 * @returns {Promise<string>} - 可播放的 URL。
 * @throws {Error} 如果无法获取 URL。
 */
export async function resolvePlayableUrl(track) {
    if (track.src && track.src.startsWith('media://')) {
        return track.src;
    }

    console.log(`[Resolver] 请求主进程解析URL: ${track.title}`);
    const result = await window.electronAPI.getMusicUrl(track);
    if (result.success && result.url) {
        console.log(`[Resolver] 成功获取可播放URL: ${result.url.substring(0, 100)}...`);
        return result.url;
    } else {
        console.error(`[Resolver] 主进程解析URL失败:`, result.error);
        throw new Error(result.error || '未能获取播放链接');
    }
}

/**
 * 请求主进程缓存（下载）一个在线曲目。
 * @param {object} trackData - 包含原始 URL 的曲目数据。
 */
function requestTrackCache(trackData) {
    console.log(`[Cache] 发送缓存请求: ${trackData.title}`);
    window.electronAPI.cacheTrack(trackData);
}


// =========================================================================
// 【修改】重构搜索函数以支持分页
// =========================================================================
/**
 * 执行在线搜索。
 * @param {string} query - 搜索关键词。
 * @param {number} page - 要搜索的页码。
 */
async function performSearch(query, page = 1) {
    if (!query) {
        showToast('请输入歌曲名或歌手名！', 'error');
        return;
    }

    // 如果是新搜索，清空结果；如果是翻页，不清空
    if (page === 1) {
        clearSearchResults();
    }

    const clickedButton = dom.searchNeteaseBtn;
    clickedButton.disabled = true;
    clickedButton.classList.add('loading');
    updateStatus(`正在搜索 "${query}" (第 ${page} 页)...`);

    const result = await window.electronAPI.searchOnline(query, page);

    clickedButton.disabled = false;
    clickedButton.classList.remove('loading');

    if (result.success) {
        const { results, total } = result.data;
        currentSearchResults = results.map(transformApiData);
        renderSearchResults(currentSearchResults);

        currentSearchQuery = query;
        currentPage = page;
        // API 返回的总数是歌曲数量，需要计算总页数
        totalPages = Math.ceil(total / ITEMS_PER_PAGE);

        renderPaginationControls(currentPage, totalPages);
        updateStatus(`搜索成功！显示第 ${page} / ${totalPages} 页，共约 ${total} 首歌曲。`, 'success');
    } else {
        updateStatus(`搜索失败: ${result.error}`, 'error');
        renderPaginationControls(0, 0); // 失败时隐藏分页
    }
}
// =========================================================================


/**
 * 向主进程发送抖音下载请求。
 * @param {HTMLElement} clickedButton - 被点击的按钮元素。
 * @param {'single' | 'works' | 'likes'} downloadType - 下载类型。
 */
function sendDouyinRequest(clickedButton, downloadType = 'single') {
    const urlText = dom.urlOrSearchInput.value;
    if (!urlText.trim()) {
        updateStatus('错误：请输入有效的分享文本。', 'error');
        return;
    }

    clearSearchResults();
    renderPaginationControls(0, 0); // 清空分页

    const allDownloadButtons = [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn];
    allDownloadButtons.forEach(btn => btn.disabled = true);
    clickedButton.classList.add('loading');
    updateStatus('已发送请求到主进程，请稍候...', 'default');

    const requestData = (downloadType === 'single') ? urlText : { url: urlText, downloadType };
    window.electronAPI.startDownload(requestData);
}

/**
 * 设置搜索结果列表的事件监听器。
 */
function setupSearchResultsListener() {
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;

        const downloadBtn = e.target.closest('.playlist-download-btn');
        const trackIndex = parseInt(item.dataset.index, 10);
        const clickedTrack = currentSearchResults[trackIndex];
        if (!clickedTrack) return;

        if (downloadBtn && !downloadBtn.classList.contains('cached')) {
            e.stopPropagation();
            updateSearchResultItemStatus(item, 'downloading');
            requestTrackCache(clickedTrack);
        } else {
            playTemporaryTrack(clickedTrack);
        }
    });
}

// =========================================================================
// 【新增】设置分页控件的事件监听器
// =========================================================================
function setupPaginationListener() {
    dom.paginationControls.addEventListener('click', (e) => {
        const target = e.target.closest('button');
        if (!target || target.disabled) return;

        if (target.id === 'prev-page-btn' && currentPage > 1) {
            performSearch(currentSearchQuery, currentPage - 1);
        } else if (target.id === 'next-page-btn' && currentPage < totalPages) {
            performSearch(currentSearchQuery, currentPage + 1);
        }
    });
}
// =========================================================================

/**
 * 初始化所有下载器相关的事件监听器。
 */
export function setupDownloaderListeners() {
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);

    dom.searchNeteaseBtn.addEventListener('click', () => {
        const query = dom.urlOrSearchInput.value.trim();
        performSearch(query, 1); // 按钮点击总是开始新的第一页搜索
    });

    dom.startDownloadBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'single'));
    dom.downloadWorksBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'works'));
    dom.downloadLikesBtn.addEventListener('click', (e) => sendDouyinRequest(e.currentTarget, 'likes'));

    setupSearchResultsListener();
    setupPaginationListener(); // 【新增】初始化分页监听

    window.electronAPI.onDownloadStatus((status) => {
        updateStatus(status.message, status.type);
        if (status.type === 'success' || status.type === 'error') {
            [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
        }
    });

    window.electronAPI.onNewTrack((newTrack) => {
        document.dispatchEvent(new CustomEvent('new-track-added', { detail: newTrack }));
        const itemInSearchResults = dom.searchResultsList.querySelector(`.playlist-item[data-src="${newTrack.originalSrc || newTrack.src}"]`);
        if (itemInSearchResults) {
            updateSearchResultItemStatus(itemInSearchResults, 'cached');
        }
    });
}