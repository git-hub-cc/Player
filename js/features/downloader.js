// js/features/downloader.js

import * as dom from '../dom.js';
import { showToast, clearSearchResults, renderSearchResults, updateSearchResultItemStatus, renderPaginationControls, showConfirmationModal } from '../ui.js';
import { playTemporaryTrack } from '../player.js';
import { pinyin } from 'pinyin-pro';

let currentSearchResults = [];
// --- [新增] 分页状态变量 ---
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 10; // 注意：如果新API每页返回20条，这里仅用于计算页码

/**
 * 将后端返回的统一数据转换为前端播放器使用的曲目对象。
 * 兼容新旧两种 API 的数据结构。
 * @param {object} apiTrack - 后端返回的标准化曲目数据。
 * @returns {object} - 转换后的曲目对象。
 */
function transformApiData(apiTrack) {
    const title = apiTrack.title || '未知标题';

    // 构造基础对象
    const track = {
        title: title,
        artist: apiTrack.artist || '未知艺术家',
        albumArt: apiTrack.albumArt || apiTrack.pic || '', // 兼容新旧字段
        type: 'audio',

        // 关键：保存元数据，用于后续获取真实链接
        id: apiTrack.id,
        source: apiTrack.source || 'joox',
        lyricId: apiTrack.lyricId,

        // 兼容旧版字段，用于下载
        originalSrc: apiTrack.url, // 旧版有直接 URL
        originalAlbumArt: apiTrack.pic, // 旧版封面
        originalLyrics: apiTrack.lrc, // 旧版歌词文本

        // 拼音辅助
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };

    // 处理播放源 src
    if (apiTrack.url) {
        // 旧版 API 直接返回了可用的 URL
        track.src = apiTrack.url;
        // 旧版歌词通常是直接文本
        track.lyrics = apiTrack.lrc;
    } else {
        // 新版 API：没有直接 URL，设置为 null 或特殊标识
        // 播放器核心 player.js 会检测到空 src，然后调用 resolvePlayableUrl
        track.src = '';
        track.lyrics = ''; // 歌词也是懒加载
    }

    return track;
}


/**
 * =========================================================================
 * 【修改】 updateInputMode 函数
 * 增强了此函数，使其能够识别B站链接。
 * 当检测到不同类型的链接时，会显示/隐藏相应的下载按钮。
 * =========================================================================
 * @param {string} message - 要显示的消息。
 */
function updateInputMode() {
    const inputText = dom.urlOrSearchInput.value.trim();
    const isUrlMode = inputText.toLowerCase().includes('http');

    // B站链接特定逻辑
    const isBilibiliUrl = isUrlMode && inputText.includes('bilibili.com/video/');

    // 抖音用户主页链接特定逻辑
    const isDouyinUserUrl = isUrlMode && (inputText.includes('/user/') || inputText.includes('MS4wLjAB'));

    // 按钮显隐控制
    dom.downloadWorksBtn.style.display = isDouyinUserUrl ? 'flex' : 'none';
    dom.downloadLikesBtn.style.display = isDouyinUserUrl ? 'flex' : 'none';
    // “开始下载”按钮适用于所有非用户主页的单视频链接（抖音和B站）
    dom.startDownloadBtn.style.display = (isUrlMode && !isDouyinUserUrl) ? 'flex' : 'none';

    // 搜索按钮只在非URL模式下显示
    dom.searchNeteaseBtn.style.display = isUrlMode ? 'none' : 'flex';

    // 本地导入按钮始终可见
    document.getElementById('import-local-btn').style.display = 'flex';

    // 更新面板描述文本
    if (isBilibiliUrl) {
        dom.panelDescription.textContent = '检测到B站链接，点击“开始下载”进行处理。';
    } else if (isUrlMode) {
        dom.panelDescription.textContent = '检测到抖音链接，已切换至下载模式。';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴视频分享链接进行本地下载。';
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
 * 请求主进程解析一个曲目的可播放 URL，以解决 CORS 问题或懒加载。
 * 兼容新 API 的 ID 解析机制。
 * @param {object} track - 曲目信息对象。
 * @returns {Promise<string>} - 可播放的 URL。
 * @throws {Error} 如果无法获取 URL。
 */
export async function resolvePlayableUrl(track) {
    if (track.src && track.src.startsWith('media://')) {
        return track.src;
    }

    // 如果 track.src 已经是有效 http 链接（旧版缓存或直接解析），后端可能会直接做 HEAD 检查
    // 如果 track.src 为空（新版），后端会利用 track.id 和 track.source 去请求真实链接

    console.log(`[Resolver] 请求主进程解析URL: ${track.title} (ID: ${track.id})`);

    // 传递完整的 track 对象，包含 id, source 等关键信息
    const result = await window.electronAPI.getMusicUrl(track);

    if (result.success && result.url) {
        console.log(`[Resolver] 成功获取可播放URL: ${result.url.substring(0, 50)}...`);
        // 缓存该 URL 到当前会话的 track 对象中，避免重复请求（可选）
        track.src = result.url;
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
    // 将完整对象发送给后端，后端会根据 provider 模式决定如何下载
    window.electronAPI.cacheTrack(trackData);
}


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
        // 使用新的转换逻辑
        currentSearchResults = results.map(transformApiData);
        renderSearchResults(currentSearchResults);

        currentSearchQuery = query;
        currentPage = page;
        // 估算总页数 (如果后端返回的 total 是准确的)
        const pageSize = results.length > 0 ? results.length : ITEMS_PER_PAGE;
        totalPages = Math.ceil(total / pageSize) || 1;

        renderPaginationControls(currentPage, totalPages);
        updateStatus(`搜索成功！当前显示 ${results.length} 首歌曲。`, 'success');
    } else {
        updateStatus(`搜索失败: ${result.error}`, 'error');
        renderPaginationControls(0, 0); // 失败时隐藏分页
    }
}


/**
 * 向主进程发送下载请求（通用）。
 * @param {HTMLElement} clickedButton - 被点击的按钮元素。
 * @param {'single' | 'works' | 'likes'} downloadType - 下载类型。
 */
function sendDownloadRequest(clickedButton, downloadType = 'single') {
    const urlText = dom.urlOrSearchInput.value;
    if (!urlText.trim()) {
        updateStatus('错误：请输入有效的分享文本或URL。', 'error');
        return;
    }

    clearSearchResults();
    renderPaginationControls(0, 0); // 清空分页

    const allDownloadButtons = [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn];
    allDownloadButtons.forEach(btn => btn.disabled = true);
    clickedButton.classList.add('loading');
    updateStatus('已发送请求到主进程，请稍候...', 'default');

    const requestData = (downloadType === 'single') ? urlText : { url: urlText, downloadType };
    // 使用统一的 'download-douyin' 通道名，后端会进行分发
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
            // 播放临时曲目
            // player.js 中的 playTemporaryTrack 会调用 resolvePlayableUrl 来解析真实链接
            playTemporaryTrack(clickedTrack);
        }
    });
}

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

// 本地导入按钮的事件处理器
async function handleLocalImportClick(event) {
    const importBtn = event.currentTarget;
    const allButtons = [importBtn, dom.searchNeteaseBtn, dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn];

    allButtons.forEach(btn => btn.disabled = true);
    importBtn.classList.add('loading');
    updateStatus('等待选择目录...');

    try {
        const result = await window.electronAPI.selectImportDirectory();

        if (!result.canceled && result.filePaths.length > 0) {
            const dirPath = result.filePaths[0];
            updateStatus(`已选择目录，开始导入...`);

            const importResult = await window.electronAPI.startLocalImport(dirPath);

            if (importResult.success) {
                try {
                    await showConfirmationModal(`成功导入 ${importResult.importedCount} 首歌曲！\n是否立即刷新播放器以加载新歌曲？`);
                    window.location.reload();
                } catch (e) {
                    // 用户点击了取消
                    updateStatus('导入完成。请手动刷新以查看新内容。', 'success');
                }
            } else {
                showToast(`导入失败: ${importResult.error}`, 'error');
                updateStatus(`导入失败: ${importResult.error}`, 'error');
            }
        } else {
            updateStatus('已取消导入操作。');
        }
    } catch (error) {
        console.error("本地导入流程出错:", error);
        showToast(`发生错误: ${error.message}`, 'error');
        updateStatus(`发生错误: ${error.message}`, 'error');
    } finally {
        allButtons.forEach(btn => btn.disabled = false);
        importBtn.classList.remove('loading');
    }
}

/**
 * 初始化所有下载器相关的事件监听器。
 */
export function setupDownloaderListeners() {
    const importLocalBtn = document.getElementById('import-local-btn');

    dom.urlOrSearchInput.addEventListener('input', updateInputMode);

    dom.searchNeteaseBtn.addEventListener('click', () => {
        const query = dom.urlOrSearchInput.value.trim();
        performSearch(query, 1);
    });

    dom.startDownloadBtn.addEventListener('click', (e) => sendDownloadRequest(e.currentTarget, 'single'));
    dom.downloadWorksBtn.addEventListener('click', (e) => sendDownloadRequest(e.currentTarget, 'works'));
    dom.downloadLikesBtn.addEventListener('click', (e) => sendDownloadRequest(e.currentTarget, 'likes'));

    importLocalBtn.addEventListener('click', handleLocalImportClick);

    setupSearchResultsListener();
    setupPaginationListener();

    window.electronAPI.onDownloadStatus((status) => {
        updateStatus(status.message, status.type);
        if (status.type === 'success' || status.type === 'error') {
            [dom.startDownloadBtn, dom.downloadWorksBtn, dom.downloadLikesBtn, importLocalBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
        }
    });

    window.electronAPI.onNewTrack((newTrack) => {
        document.dispatchEvent(new CustomEvent('new-track-added', { detail: newTrack }));
        // 尝试在当前搜索结果中找到对应项并标记为已下载
        // 兼容新旧两种 ID 匹配方式
        if (dom.searchResultsList) {
            const items = dom.searchResultsList.querySelectorAll('.playlist-item');
            items.forEach(item => {
                const trackIndex = parseInt(item.dataset.index, 10);
                const track = currentSearchResults[trackIndex];
                if (track) {
                    // 如果 ID 相同，或者 URL 相同
                    if ((newTrack.id && newTrack.id === track.id) ||
                        (newTrack.originalSrc && newTrack.originalSrc === track.originalSrc)) {
                        updateSearchResultItemStatus(item, 'cached');
                    }
                }
            });
        }
    });

    window.electronAPI.onImportStatus((status) => {
        updateStatus(status.message, status.type);
    });
}