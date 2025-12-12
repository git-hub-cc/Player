// src/renderer/js/features/downloader.js

import * as dom from '../dom.js';
import { showToast, clearSearchResults, renderSearchResults, updateSearchResultItemStatus, renderPaginationControls, showConfirmationModal } from '../ui.js';
import { playTemporaryTrack } from '../player.js';
import { pinyin } from 'pinyin-pro';

let currentSearchResults = [];
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 10;

/**
 * 将后端返回的统一数据转换为前端播放器使用的曲目对象。
 * 兼容新旧两种 API 的数据结构，并缓存 pic_id 和 source 以便按需获取封面。
 * @param {object} apiTrack - 后端返回的标准化曲目数据。
 * @returns {object} - 转换后的曲目对象。
 */
function transformApiData(apiTrack) {
    const title = apiTrack.title || '未知标题';

    const track = {
        title: title,
        artist: apiTrack.artist || '未知艺术家',
        albumArt: apiTrack.albumArt || apiTrack.pic || '',
        type: 'audio',
        id: apiTrack.id,
        source: apiTrack.source || 'joox',
        lyricId: apiTrack.lyricId,
        // 缓存 pic_id 以便在播放或下载时按需获取封面
        pic_id: apiTrack.pic_id,
        originalSrc: apiTrack.url,
        originalAlbumArt: apiTrack.pic,
        originalLyrics: apiTrack.lrc,
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };

    if (apiTrack.url) {
        track.src = apiTrack.url;
        track.lyrics = apiTrack.lrc;
    } else {
        track.src = '';
        track.lyrics = '';
    }

    return track;
}


/**
 * 根据输入内容更新下载面板的模式（URL下载或关键词搜索）。
 * 此函数会自动从粘贴的文本中提取第一个有效的 URL。
 */
function updateInputMode() {
    const originalText = dom.urlOrSearchInput.value;
    let processedText = originalText.trim();

    // 使用正则表达式从输入文本中提取第一个有效的 URL
    // 这允许用户粘贴包含额外文字的分享内容，系统会自动处理。
    const urlMatch = processedText.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        processedText = urlMatch[0]; // 仅使用匹配到的 URL 部分
        // 如果提取出的 URL 与输入框内容不一致，则更新输入框，为用户提供清晰的反馈
        if (dom.urlOrSearchInput.value.trim() !== processedText) {
            dom.urlOrSearchInput.value = processedText;
        }
    }

    const isUrlMode = processedText.toLowerCase().startsWith('http');

    // 为所有支持的链接类型创建明确的布尔标志
    const isBilibiliUrl = isUrlMode && processedText.includes('bilibili.com/video/');
    const isJableUrl = isUrlMode && processedText.includes('jable.tv/videos/');
    const isYoutubeUrl = isUrlMode && (processedText.includes('youtube.com/') || processedText.includes('youtu.be/'));
    const isDouyinUrl = isUrlMode && (processedText.includes('douyin.com') || processedText.includes('iesdouyin.com'));

    // 根据是否是URL，统一控制下载/搜索按钮的显隐
    dom.startDownloadBtn.style.display = isUrlMode ? 'flex' : 'none';
    dom.searchNeteaseBtn.style.display = isUrlMode ? 'none' : 'flex';
    document.getElementById('import-local-btn').style.display = 'flex';

    // 使用更严谨的 if-else 链来设置提示文本
    if (isBilibiliUrl) {
        dom.panelDescription.textContent = '检测到B站链接，点击“开始下载”进行处理。';
    } else if (isJableUrl) {
        dom.panelDescription.textContent = '检测到Jable链接，点击“开始下载”进行处理。';
    } else if (isYoutubeUrl) {
        dom.panelDescription.textContent = '检测到YouTube链接，点击“开始下载”进行处理。';
    } else if (isDouyinUrl) {
        dom.panelDescription.textContent = '检测到抖音链接，点击“开始下载”进行处理。';
    } else if (isUrlMode) {
        // 为无法识别的URL提供通用提示
        dom.panelDescription.textContent = '检测到未知链接，将尝试作为抖音视频处理...';
    } else {
        // 默认的搜索模式提示
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
    const encodedSrc = track.src;

    const encodedRelativeSrc = encodedSrc.startsWith('media://')
        ? encodedSrc.substring('media://'.length)
        : encodedSrc;

    const decodedRelativeSrc = decodeURIComponent(encodedRelativeSrc);

    console.log(`[Deletion] 请求删除 (解码后路径): ${decodedRelativeSrc}`);
    const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });

    if (result.success) {
        // 成功消息由 main.js 统一处理
    } else {
        showToast(result.error, 'error');
    }
    return result.success;
}

/**
 * 请求主进程解析一个曲目的可播放 URL 和封面 URL。
 * @param {object} track - 曲目信息对象。
 * @returns {Promise<object>} - 包含可播放 URL 和封面 URL 的对象。
 * @throws {Error} 如果无法获取 URL。
 */
export async function resolvePlayableUrl(track) {
    // 如果是本地媒体，直接返回
    if (track.src && track.src.startsWith('media://')) {
        return { playableSrc: track.src, albumArtUrl: track.albumArt };
    }

    console.log(`[Resolver] 请求主进程解析URL: ${track.title} (ID: ${track.id})`);

    const result = await window.electronAPI.getMusicUrl(track);

    if (result.success && result.url) {
        console.log(`[Resolver] 成功获取可播放URL: ${result.url.substring(0, 50)}...`);
        // 更新传入的 track 对象的属性，以便后续操作（如下载）可以利用这些已获取的数据
        track.src = result.url;
        if (result.albumArtUrl) {
            track.albumArt = result.albumArtUrl;
        }
        return { playableSrc: result.url, albumArtUrl: result.albumArtUrl || track.albumArt };
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
        currentSearchResults = results.map(transformApiData);
        renderSearchResults(currentSearchResults);

        currentSearchQuery = query;
        currentPage = page;
        const pageSize = results.length > 0 ? results.length : ITEMS_PER_PAGE;
        totalPages = Math.ceil(total / pageSize) || 1;

        renderPaginationControls(currentPage, totalPages);
        updateStatus(`搜索成功！当前显示 ${results.length} 首歌曲。`, 'success');
    } else {
        updateStatus(`搜索失败: ${result.error}`, 'error');
        renderPaginationControls(0, 0);
    }
}


/**
 * 向主进程发送下载请求（通用）。
 * @param {HTMLElement} clickedButton - 被点击的按钮元素。
 */
function sendDownloadRequest(clickedButton) {
    const urlText = dom.urlOrSearchInput.value;
    if (!urlText.trim()) {
        updateStatus('错误：请输入有效的分享文本或URL。', 'error');
        return;
    }

    clearSearchResults();
    renderPaginationControls(0, 0);

    const allDownloadButtons = [dom.startDownloadBtn];
    allDownloadButtons.forEach(btn => btn.disabled = true);
    clickedButton.classList.add('loading');
    updateStatus('已发送请求到主进程，请稍候...', 'default');

    window.electronAPI.startDownload(urlText);
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

/**
 * 处理“导入本地资源”按钮点击事件。
 * @param {Event} event
 */
async function handleLocalImportClick(event) {
    const importBtn = event.currentTarget;
    const allButtons = [importBtn, dom.searchNeteaseBtn, dom.startDownloadBtn];

    allButtons.forEach(btn => btn.disabled = true);
    importBtn.classList.add('loading');
    updateStatus('等待选择资源目录...');

    try {
        const result = await window.electronAPI.selectImportDirectory();

        if (!result.canceled && result.filePaths.length > 0) {
            const dirPath = result.filePaths[0];
            updateStatus(`已选择目录，开始导入媒体文件...`);

            const importResult = await window.electronAPI.startLocalImport(dirPath);

            if (importResult.success) {
                try {
                    await showConfirmationModal(`成功导入 ${importResult.importedCount} 个媒体文件！\n是否立即刷新播放器以加载新内容？`);
                    window.location.reload();
                } catch (e) {
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

    dom.startDownloadBtn.addEventListener('click', (e) => sendDownloadRequest(e.currentTarget));

    importLocalBtn.addEventListener('click', handleLocalImportClick);

    setupSearchResultsListener();
    setupPaginationListener();

    window.electronAPI.onDownloadStatus((status) => {
        updateStatus(status.message, status.type);
        if (status.type === 'success' || status.type === 'error') {
            [dom.startDownloadBtn, importLocalBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
        }
    });

    window.electronAPI.onNewTrack((newTrack) => {
        // =========================================================================
        // 【核心修复】移除重复的事件分发。
        // 添加新曲目到播放列表的逻辑由 renderer.js 中的主监听器统一处理。
        // 此处仅负责更新本模块（下载面板）内的UI状态。
        // =========================================================================
        // document.dispatchEvent(new CustomEvent('new-track-added', { detail: newTrack }));

        // 此监听器的唯一职责是更新搜索结果列表中的UI状态
        if (dom.searchResultsList) {
            const items = dom.searchResultsList.querySelectorAll('.playlist-item');
            items.forEach(item => {
                const trackIndex = parseInt(item.dataset.index, 10);
                const track = currentSearchResults[trackIndex];
                if (track) {
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