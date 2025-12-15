// src/renderer/js/features/downloader.js

/**
 * @file 资源处理器UI层 (Resource Handler UI Layer)
 * @description
 * 负责处理“添加资源”面板的所有UI交互。
 * 它将用户的操作（如搜索、点击下载）转换为对 `mediaService` 的调用，
 * 并通过订阅 `state` 或监听 `electronAPI` 事件来更新UI。
 */

import * as dom from '../dom.js';
import * as ui from '../ui.js';
import * as mediaService from '../services/mediaService.js';
import { pinyin } from 'pinyin-pro';
import { getTemplate } from '../utils.js';
import * as ICONS from '../icons.js';

// --- 模块私有状态 ---
let currentSearchResults = [];
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 20;

// =========================================================================
// --- 策略模式实现 (UI部分) ---
// =========================================================================

/** 策略基类 */
class DownloadStrategy {
    isApplicable(url) { throw new Error("策略必须实现 isApplicable 方法。"); }
    getDescription() { throw new Error("策略必须实现 getDescription 方法。"); }
    execute(url) { window.electronAPI.startDownload(url); } // 所有策略最终都委托给主进程
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

// 策略注册表
const downloadStrategies = [new BilibiliStrategy(), new JableStrategy(), new YoutubeStrategy(), new DouyinStrategy()];

/**
 * 根据URL查找匹配的下载策略。
 * @param {string} url - 用户输入的URL。
 * @returns {DownloadStrategy|null} - 匹配的策略实例或 null。
 */
function findStrategyFor(url) {
    return downloadStrategies.find(s => s.isApplicable(url)) || null;
}

// =========================================================================
// --- 核心逻辑 ---
// =========================================================================

/**
 * 将从API获取的原始轨道数据转换为应用内部使用的标准格式。
 * @param {object} apiTrack - API返回的轨道数据。
 * @returns {object} - 转换后的轨道对象。
 */
function transformApiData(apiTrack) {
    const title = apiTrack.title || '未知标题';
    return {
        title,
        artist: apiTrack.artist || '未知艺术家',
        albumArt: apiTrack.albumArt || apiTrack.pic || '',
        type: 'audio',
        id: apiTrack.id,
        source: apiTrack.source || 'netease', // 默认来源
        lyricId: apiTrack.lyricId,
        pic_id: apiTrack.pic_id,
        originalSrc: apiTrack.url, // 存储原始URL，用于临时播放时重新解析
        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
    };
}

/**
 * 根据输入框内容更新UI模式（搜索模式 vs 下载模式）。
 */
function updateInputMode() {
    const text = dom.urlOrSearchInput.value.trim();
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : '';
    const strategy = findStrategyFor(url);

    // 动态显示/隐藏“搜索”和“下载”按钮
    dom.startDownloadBtn.style.display = strategy || url ? 'flex' : 'none';
    dom.searchNeteaseBtn.style.display = strategy || url ? 'none' : 'flex';

    // 更新面板顶部的描述文本
    if (strategy) {
        dom.panelDescription.textContent = strategy.getDescription();
    } else if (url) {
        dom.panelDescription.textContent = '检测到未知链接，将尝试作为抖音视频处理...';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴 抖音/B站/Jable/YouTube 链接进行本地下载。';
    }
}

/**
 * 更新下载面板底部的状态信息。
 * @param {string} message - 要显示的消息。
 * @param {'default'|'success'|'error'|'progress'} [type='default'] - 消息类型。
 * @param {number} [progress] - 进度值 (0-1)，仅在 type 为 'progress' 时有效。
 */
function updateStatus(message, type = 'default', progress) {
    const statusEl = dom.downloadStatusEl;
    const progressContainer = document.querySelector('.download-progress-container');
    const progressBar = document.querySelector('.download-progress-bar');

    statusEl.textContent = message;
    statusEl.className = 'download-status'; // 重置类名
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

/**
 * 创建单个搜索结果项的 DOM 元素。
 * @param {object} track - 轨道数据。
 * @param {number} index - 轨道索引。
 * @param {boolean} [isCached=false] - 是否已在本地缓存。
 * @returns {DocumentFragment} - 包含列表项的文档片段。
 */
function createResultItem(track, index, isCached = false) {
    const itemNode = getTemplate('template-search-result-item');
    const itemEl = itemNode.querySelector('.playlist-item');
    itemEl.dataset.index = index;
    itemEl.dataset.src = track.originalSrc || track.src; // 存储原始src用于临时播放匹配
    itemEl.querySelector('.playlist-icon').textContent = '🎵';
    itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
    itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';

    // 动态替换模板中的SVG图标占位符
    const placeholders = itemEl.querySelectorAll('.icon-placeholder');
    const iconMap = { DOWNLOAD: ICONS.ICON_DOWNLOAD, SPINNER: ICONS.ICON_SPINNER, CACHED: ICONS.ICON_CACHED };
    placeholders.forEach(ph => {
        const iconName = ph.dataset.icon;
        if (iconMap[iconName]) ph.outerHTML = iconMap[iconName];
    });

    const downloadBtn = itemEl.querySelector('.playlist-download-btn');
    downloadBtn.classList.toggle('cached', isCached);
    return itemNode;
}


/**
 * 执行在线搜索并渲染结果。
 * @param {string} query - 搜索关键词。
 * @param {number} [page=1] - 页码。
 */
async function performSearch(query, page = 1) {
    if (!query) {
        ui.showToast('请输入歌曲名或歌手名！', 'error');
        return;
    }
    if (page === 1) ui.clearSearchResults(dom.searchResultsList);

    const searchBtn = dom.searchNeteaseBtn;
    searchBtn.disabled = true;
    searchBtn.classList.add('loading');
    updateStatus(`正在搜索 "${query}" (第 ${page} 页)...`);

    // 调用 mediaService，它内部处理了缓存和请求锁定
    const data = await mediaService.searchOnline(query, page);

    // 只有在 mediaService 成功返回数据时才更新UI
    if (data) {
        const { results, total } = data;
        currentSearchResults = results.map(transformApiData);
        ui.renderSearchResults(dom.searchResultsList, currentSearchResults, createResultItem);
        currentSearchQuery = query;
        currentPage = page;
        totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
        ui.renderPaginationControls(dom.paginationControls, currentPage, totalPages);
        updateStatus(`搜索成功！显示 ${results.length} 首歌曲。`, 'success');
    } else if (!inFlightRequests.has(`${query}_${page}`)) {
        // 如果 data 为 null 且不是因为请求被锁定，说明是API错误
        updateStatus('搜索失败，请检查网络或稍后重试。', 'error');
        ui.renderPaginationControls(dom.paginationControls, 0, 0);
    }
    // 如果是请求被锁定，mediaService 已经显示了提示，此处无需额外操作

    searchBtn.disabled = false;
    searchBtn.classList.remove('loading');
}


/**
 * 处理“导入本地资源”按钮的点击事件。
 */
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

/**
 * 处理下载功能缺少核心工具（如FFmpeg）的情况。
 * @param {string} toolName - 缺失的工具名 ('ffmpeg' 或 'yt-dlp')。
 * @param {string} featureName - 需要此工具的功能名称。
 */
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
        // 用户选择了“手动说明”
        if (rejectionType === 'cancel') {
            ui.showConfirmationModal(`请将${toolDisplayName}放入应用数据目录。`, { confirmText: "打开目录" })
                .then(() => window.electronAPI.openToolsFolder()).catch(() => {});
        }
    }
}

/**
 * 初始化所有下载器相关的事件监听器。
 */
export function setupDownloaderListeners() {
    // UI交互事件
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);
    dom.searchNeteaseBtn.addEventListener('click', () => performSearch(dom.urlOrSearchInput.value.trim(), 1));
    dom.startDownloadBtn.addEventListener('click', () => {
        const url = dom.urlOrSearchInput.value.trim().match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) {
            updateStatus('请输入有效的URL。', 'error');
            return;
        }
        // 使用策略模式找到处理器，如果没有匹配则使用抖音作为后备
        const strategy = findStrategyFor(url) || new DouyinStrategy();
        strategy.execute(url);
        dom.startDownloadBtn.disabled = true;
        dom.startDownloadBtn.classList.add('loading');
    });
    dom.importLocalBtn.addEventListener('click', handleLocalImportClick);

    // --- 使用事件委托处理搜索结果列表的交互 ---
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const track = currentSearchResults[parseInt(item.dataset.index, 10)];
        if (!track) return;

        // 如果点击的是下载按钮（且未被缓存）
        if (e.target.closest('.playlist-download-btn:not(.cached)')) {
            e.stopPropagation(); // 防止触发播放
            ui.updateSearchResultItemStatus(item, 'downloading');
            mediaService.cacheTrack(track);
        } else {
            // 点击列表项的其他部分，则临时播放在线歌曲
            mediaService.playTemporaryTrack(track);
        }
    });

    // --- 分页控制的事件委托 ---
    dom.paginationControls.addEventListener('click', (e) => {
        const target = e.target.closest('button:not(:disabled)');
        if (!target) return;
        if (target.id === 'prev-page-btn') performSearch(currentSearchQuery, currentPage - 1);
        else if (target.id === 'next-page-btn') performSearch(currentSearchQuery, currentPage + 1);
    });

    // --- 监听来自主进程的IPC事件 ---
    window.electronAPI.onDownloadStatus((status) => {
        if (status.reason === 'tool_missing') {
            handleMissingTool(status.missing, "该下载");
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
                await ui.showConfirmationModal(`成功导入${status.importedCount}个文件！\n是否立即刷新以加载新内容？`, { confirmText: "立即刷新" });
                window.location.reload();
            } catch (e) { /* 用户取消刷新 */ }
        }
    });
}