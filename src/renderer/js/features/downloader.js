// src/renderer/js/features/downloader.js

/**
 * @file 资源处理器UI层 (Resource Handler UI Layer)
 * @description
 * 负责处理“添加资源”面板的所有UI交互。
 * 它将用户的操作（如搜索、点击下载）转换为对 `mediaService` 的调用，
 * 并通过订阅 `state` 或监听 `electronAPI` 事件来更新UI。
 *
 * 特点:
 * - 纯UI层：不包含任何业务逻辑或直接的IPC调用。
 * - 职责单一：只关心下载面板的渲染和用户输入处理。
 */

import * as dom from '../dom.js';
import * as ui from '../ui.js';
import * as mediaService from '../services/mediaService.js';
import { pinyin } from 'pinyin-pro';

// --- 模块私有状态 ---
let currentSearchResults = [];
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
// =========================================================================
// 【修复】将每页项目数与 gdstudio.js 中的 count 参数默认值 (20) 保持一致
// =========================================================================
const ITEMS_PER_PAGE = 20;

// =========================================================================
// --- 策略模式实现 (UI部分) ---
// =========================================================================

/** 策略基类 */
class DownloadStrategy {
    isApplicable(url) { throw new Error("Strategy must implement isApplicable."); }
    getDescription() { throw new Error("Strategy must implement getDescription."); }
    execute(url) { window.electronAPI.startDownload(url); } // 委托给主进程
}

class BilibiliStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('bilibili.com/video/'); }
    getDescription() { return '检测到B站链接，点击“开始下载”进行处理。'; }
}

class JableStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('jable.tv/videos/'); }
    getDescription() { return '检测到Jable链接，点击“开始下载”进行处理。'; }
}

class YoutubeStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('youtube.com/') || url.includes('youtu.be/'); }
    getDescription() { return '检测到YouTube链接，点击“开始下载”进行处理。'; }
}

class DouyinStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('douyin.com') || url.includes('iesdouyin.com'); }
    getDescription() { return '检测到抖音链接，点击“开始下载”进行处理。'; }
}

const downloadStrategies = [new BilibiliStrategy(), new JableStrategy(), new YoutubeStrategy(), new DouyinStrategy()];

function findStrategyFor(url) {
    return downloadStrategies.find(s => s.isApplicable(url)) || null;
}

// =========================================================================
// --- 核心逻辑 ---
// =========================================================================

function transformApiData(apiTrack) {
    const title = apiTrack.title || '未知标题';
    return {
        title,
        artist: apiTrack.artist || '未知艺术家',
        albumArt: apiTrack.albumArt || apiTrack.pic || '',
        type: 'audio',
        id: apiTrack.id,
        source: apiTrack.source || 'joox',
        lyricId: apiTrack.lyricId,
        pic_id: apiTrack.pic_id,
        // originalSrc 用于在临时播放时重新解析
        originalSrc: apiTrack.url,
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };
}

function updateInputMode() {
    const text = dom.urlOrSearchInput.value.trim();
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : '';
    const strategy = findStrategyFor(url);

    dom.startDownloadBtn.style.display = strategy || url ? 'flex' : 'none';
    dom.searchNeteaseBtn.style.display = strategy || url ? 'none' : 'flex';

    if (strategy) {
        dom.panelDescription.textContent = strategy.getDescription();
    } else if (url) {
        dom.panelDescription.textContent = '检测到未知链接，将尝试作为抖音视频处理...';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴视频分享链接进行本地下载。';
    }
}

function updateStatus(message, type = 'default', progress) {
    // ... 此函数与之前相同，纯粹的UI操作
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

async function performSearch(query, page = 1) {
    if (!query) {
        ui.showToast('请输入歌曲名或歌手名！', 'error');
        return;
    }
    if (page === 1) ui.clearSearchResults();

    const searchBtn = dom.searchNeteaseBtn;
    searchBtn.disabled = true;
    searchBtn.classList.add('loading');
    updateStatus(`正在搜索 "${query}" (第 ${page} 页)...`);

    const data = await mediaService.searchOnline(query, page);

    if (data) {
        const { results, total } = data;
        currentSearchResults = results.map(transformApiData);
        ui.renderSearchResults(currentSearchResults);
        currentSearchQuery = query;
        currentPage = page;
        totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
        ui.renderPaginationControls(currentPage, totalPages);
        updateStatus(`搜索成功！显示 ${results.length} 首歌曲。`, 'success');
    } else {
        updateStatus('搜索失败，请检查网络或稍后重试。', 'error');
        ui.renderPaginationControls(0, 0);
    }
    searchBtn.disabled = false;
    searchBtn.classList.remove('loading');
}

async function handleLocalImportClick() {
    const importBtn = dom.importLocalBtn;
    [importBtn, dom.searchNeteaseBtn, dom.startDownloadBtn].forEach(btn => btn.disabled = true);
    importBtn.classList.add('loading');
    updateStatus('等待选择资源目录...');
    try {
        const result = await window.electronAPI.selectImportDirectory();
        if (result.canceled) {
            updateStatus('已取消导入操作。');
        } else {
            updateStatus('已选择目录，开始导入...');
            await window.electronAPI.startLocalImport(result.filePaths[0]);
        }
    } catch (error) {
        ui.showToast(`导入出错: ${error.message}`, 'error');
    } finally {
        [importBtn, dom.searchNeteaseBtn, dom.startDownloadBtn].forEach(btn => btn.disabled = false);
        importBtn.classList.remove('loading');
    }
}

async function handleMissingTool(toolName, featureName) {
    // ... 此函数与之前相同
    const toolDisplayName = toolName === 'ffmpeg' ? 'FFmpeg' : 'yt-dlp';
    try {
        await ui.showConfirmationModal(
            `${featureName}功能需要${toolDisplayName}组件。\n\n是否自动下载安装？`,
            { confirmText: "自动下载", cancelText: "手动说明", showCloseButton: true }
        );
        const result = await window.electronAPI.downloadCoreTool(toolName);
        if (result.success) ui.showToast(`${toolDisplayName}安装成功！请重试。`, 'success');
        else ui.showToast(`安装失败: ${result.error}`, 'error');
    } catch (rejectionType) {
        if (rejectionType === 'cancel') {
            await ui.showConfirmationModal(`请将${toolDisplayName}放入应用数据目录。`, { confirmText: "打开目录" })
                .then(() => window.electronAPI.openToolsFolder()).catch(() => {});
        }
    }
}

/**
 * 初始化所有下载器相关的事件监听器。
 */
export function setupDownloaderListeners() {
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);
    dom.searchNeteaseBtn.addEventListener('click', () => performSearch(dom.urlOrSearchInput.value.trim(), 1));
    dom.startDownloadBtn.addEventListener('click', () => {
        const url = dom.urlOrSearchInput.value.trim().match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) {
            updateStatus('请输入有效的URL。', 'error');
            return;
        }
        const strategy = findStrategyFor(url) || new DouyinStrategy(); // 后备策略
        strategy.execute(url);
        dom.startDownloadBtn.disabled = true;
        dom.startDownloadBtn.classList.add('loading');
    });
    dom.importLocalBtn.addEventListener('click', handleLocalImportClick);

    // --- 事件委托 ---
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const track = currentSearchResults[parseInt(item.dataset.index, 10)];
        if (!track) return;

        if (e.target.closest('.playlist-download-btn:not(.cached)')) {
            e.stopPropagation();
            ui.updateSearchResultItemStatus(item, 'downloading');
            mediaService.cacheTrack(track); // 委托给服务
        } else {
            mediaService.playTemporaryTrack(track); // 委托给服务
        }
    });

    dom.paginationControls.addEventListener('click', (e) => {
        const target = e.target.closest('button:not(:disabled)');
        if (!target) return;
        if (target.id === 'prev-page-btn') performSearch(currentSearchQuery, currentPage - 1);
        else if (target.id === 'next-page-btn') performSearch(currentSearchQuery, currentPage + 1);
    });

    // --- IPC & State 监听 ---
    window.electronAPI.onDownloadStatus((status) => {
        if (status.reason === 'tool_missing') {
            handleMissingTool(status.missing, "该");
        }
        updateStatus(status.message, status.type, status.progress);
        if (status.type === 'success' || status.type === 'error') {
            [dom.startDownloadBtn, dom.importLocalBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
        }
    });

    window.electronAPI.onImportStatus(async (status) => {
        updateStatus(status.message, status.type);
        if (status.type === 'success') {
            try {
                await ui.showConfirmationModal(`成功导入${status.importedCount}个文件！\n是否立即刷新？`);
                window.location.reload();
            } catch (e) { /* 用户取消 */ }
        }
    });
}