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
 */
function updateInputMode() {
    const originalText = dom.urlOrSearchInput.value;
    let processedText = originalText.trim();

    const urlMatch = processedText.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        processedText = urlMatch[0];
        if (dom.urlOrSearchInput.value.trim() !== processedText) {
            dom.urlOrSearchInput.value = processedText;
        }
    }

    const isUrlMode = processedText.toLowerCase().startsWith('http');
    const isBilibiliUrl = isUrlMode && processedText.includes('bilibili.com/video/');
    const isJableUrl = isUrlMode && processedText.includes('jable.tv/videos/');
    const isYoutubeUrl = isUrlMode && (processedText.includes('youtube.com/') || processedText.includes('youtu.be/'));
    const isDouyinUrl = isUrlMode && (processedText.includes('douyin.com') || processedText.includes('iesdouyin.com'));

    dom.startDownloadBtn.style.display = isUrlMode ? 'flex' : 'none';
    dom.searchNeteaseBtn.style.display = isUrlMode ? 'none' : 'flex';
    document.getElementById('import-local-btn').style.display = 'flex';

    if (isBilibiliUrl) {
        dom.panelDescription.textContent = '检测到B站链接，点击“开始下载”进行处理。';
    } else if (isJableUrl) {
        dom.panelDescription.textContent = '检测到Jable链接，点击“开始下载”进行处理。';
    } else if (isYoutubeUrl) {
        dom.panelDescription.textContent = '检测到YouTube链接，点击“开始下载”进行处理。';
    } else if (isDouyinUrl) {
        dom.panelDescription.textContent = '检测到抖音链接，点击“开始下载”进行处理。';
    } else if (isUrlMode) {
        dom.panelDescription.textContent = '检测到未知链接，将尝试作为抖音视频处理...';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴视频分享链接进行本地下载。';
    }
}

/**
 * 更新下载面板底部的状态信息。
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
 */
export async function resolvePlayableUrl(track) {
    if (track.src && track.src.startsWith('media://')) {
        return { playableSrc: track.src, albumArtUrl: track.albumArt };
    }

    console.log(`[Resolver] 请求主进程解析URL: ${track.title} (ID: ${track.id})`);

    const result = await window.electronAPI.getMusicUrl(track);

    if (result.success && result.url) {
        console.log(`[Resolver] 成功获取可播放URL: ${result.url.substring(0, 50)}...`);
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
 */
function requestTrackCache(trackData) {
    console.log(`[Cache] 发送缓存请求: ${trackData.title}`);
    window.electronAPI.cacheTrack(trackData);
}

/**
 * 执行在线搜索。
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
 * =========================================================================
 * 【核心修复】删除了 'require('electron')'，改用 DOM 操作和 IPC API
 * =========================================================================
 * @param {string} toolName - 缺失的工具名称 ('ffmpeg' 或 'yt-dlp')
 * @param {string} featureName - 触发该错误的功能描述
 */
async function handleMissingTool(toolName, featureName) {
    const toolDisplayName = toolName === 'ffmpeg' ? 'FFmpeg' : 'yt-dlp';
    const message = `${featureName} 功能需要 ${toolDisplayName} 组件才能运行。\n\n您可以选择自动下载并安装（约 20-150MB），或者查看如何手动下载。`;

    const modal = document.getElementById('confirmation-modal-overlay');
    const msgEl = document.getElementById('confirmation-message');
    const cancelBtn = document.getElementById('cancel-btn');
    const confirmBtn = document.getElementById('confirm-btn');

    // 临时修改按钮文本和行为
    const originalCancelText = cancelBtn.textContent;
    const originalConfirmText = confirmBtn.textContent;

    cancelBtn.textContent = "手动下载说明";
    confirmBtn.textContent = "自动下载";

    // 创建一个额外的“取消”按钮用于关闭
    let closeBtn = document.getElementById('temp-close-btn');
    if (!closeBtn) {
        closeBtn = document.createElement('button');
        closeBtn.id = 'temp-close-btn';
        closeBtn.className = 'action-btn secondary-btn';
        closeBtn.style.marginRight = '12px';
        const actionsContainer = modal.querySelector('.confirmation-actions');
        actionsContainer.insertBefore(closeBtn, cancelBtn);
    }
    closeBtn.textContent = '取消';
    closeBtn.style.display = 'block';

    msgEl.innerText = message;
    modal.classList.add('visible');

    const cleanup = () => {
        modal.classList.remove('visible');
        cancelBtn.textContent = originalCancelText;
        confirmBtn.textContent = originalConfirmText;
        if (closeBtn) closeBtn.style.display = 'none'; // 隐藏而不是移除，以便复用或防止报错

        // 移除所有临时监听器，通过克隆节点的方式是最快的方法
        // 注意：这会移除原始的事件监听器，所以在 renderer.js 中调用 showConfirmationModal 时
        // 必须确保它每次都重新绑定事件（目前的 ui.js 实现是支持的）
        const newCloseBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
        closeBtn = newCloseBtn;

        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    };

    return new Promise((resolve) => {
        // 自动下载
        confirmBtn.onclick = async () => {
            cleanup();
            // 触发下载模态框
            const progressModal = document.getElementById('download-progress-modal');
            progressModal.classList.add('visible');
            try {
                // 调用 IPC 接口
                const result = await window.electronAPI.downloadCoreTool(toolName);
                if (result.success) {
                    showToast(`${toolDisplayName} 安装成功！请重试刚才的操作。`, 'success');
                } else {
                    showToast(`安装失败: ${result.error}`, 'error');
                }
            } catch (err) {
                showToast(`安装出错: ${err.message}`, 'error');
            } finally {
                progressModal.classList.remove('visible');
            }
            resolve(true);
        };

        // 手动说明
        cancelBtn.onclick = async () => {
            cleanup();
            // 这里调用通用的弹窗，但需要确保它是异步的，不会立即被覆盖
            setTimeout(async () => {
                await showConfirmationModal(
                    `手动下载步骤：\n\n1. 访问 GitHub Releases 页面下载 ${toolDisplayName}。\n2. 将下载的 .exe 文件放入应用的数据目录中。\n\n点击“确认”将自动打开该目录。`
                ).then(async () => {
                    await window.electronAPI.openToolsFolder();
                }).catch(() => {});
            }, 100);
            resolve(false);
        };

        // 取消
        closeBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
    });
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
        if (status.type === 'error' && status.reason === 'tool_missing') {
            const toolName = status.missing; // 'ffmpeg' or 'yt-dlp'
            let featureName = "该";
            if (toolName === 'ffmpeg') featureName = "视频转换";
            if (toolName === 'yt-dlp') featureName = "视频下载";

            handleMissingTool(toolName, featureName);
            updateStatus(`需要安装 ${toolName} 才能继续。`, 'default');
        } else {
            updateStatus(status.message, status.type);
        }

        if (status.type === 'success' || status.type === 'error') {
            [dom.startDownloadBtn, importLocalBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
        }
    });

    window.electronAPI.onNewTrack((newTrack) => {
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