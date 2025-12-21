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
import { subscribe } from '../state.js';
import { getTemplate } from '../utils.js';
import * as ICONS from '../icons.js';

// --- 模块私有状态 ---
let currentSearchResults = [];
let currentSearchQuery = '';
let currentPage = 1;
let totalPages = 1;
const ITEMS_PER_PAGE = 20;

// =========================================================================
// --- 策略模式实现 (UI部分，用于视频链接下载) ---
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

// =========================================================================
// 【核心新增】IYF 策略类
// =========================================================================
class IyfStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('iyf.lv') || url.includes('iyf.tv'); }
    getDescription() { return '检测到爱壹帆(IYF)链接，点击“开始下载”进行处理。'; }
}

// 策略注册表
const downloadStrategies = [
    new BilibiliStrategy(),
    new JableStrategy(),
    new YoutubeStrategy(),
    new DouyinStrategy(),
    // =========================================================================
    // 【核心新增】注册 IyfStrategy
    // =========================================================================
    new IyfStrategy()
];

/**
 * 根据URL查找匹配的下载策略。
 * @param {string} url - 用户输入的URL。
 * @returns {DownloadStrategy|null} - 匹配的策略实例或 null。
 */
function findStrategyFor(url) {
    if (!url) return null;
    return downloadStrategies.find(s => s.isApplicable(url)) || null;
}

// =========================================================================
// --- 核心逻辑 ---
// =========================================================================

/**
 * 将从 Meting API 获取的原始轨道数据转换为应用内部使用的标准格式。
 * @param {object} apiTrack - API返回的轨道数据。
 * @returns {object} - 转换后的轨道对象。
 */
function transformApiData(apiTrack) {
    return {
        // Meting 标准化格式的字段
        id: apiTrack.id,
        title: apiTrack.name,
        artist: Array.isArray(apiTrack.artist) ? apiTrack.artist.join(' / ') : apiTrack.artist,
        album: apiTrack.album,
        pic_id: apiTrack.pic_id,
        lyric_id: apiTrack.lyric_id,
        url_id: apiTrack.url_id,
        source: apiTrack.source,

        // 应用内部需要的附加字段
        type: 'audio',
        albumArt: '', // 封面图将在获取URL时解析
        originalSrc: `meting://${apiTrack.source}/${apiTrack.id}` // 创建一个唯一的内部标识
    };
}


/**
 * 智能 URL 提取与补全工具
 * @param {string} input - 用户输入的原始文本
 * @returns {string} - 标准化后的 URL 或空字符串
 */
function extractUrlFromInput(input) {
    const text = input.trim();
    if (!text) return '';
    const protocolMatch = text.match(/https?:\/\/[^\s]+/);
    if (protocolMatch) return protocolMatch[0];
    const domainRules = [
        { domain: 'bilibili.com', prefix: 'https://www.' },
        { domain: 'douyin.com', prefix: 'https://www.' },
        { domain: 'iesdouyin.com', prefix: 'https://www.' },
        { domain: 'jable.tv', prefix: 'https://www.' },
        { domain: 'youtube.com', prefix: 'https://www.' },
        { domain: 'youtu.be', prefix: 'https://' },
        // =========================================================================
        // 【核心新增】IYF 域名补全规则
        // =========================================================================
        { domain: 'iyf.lv', prefix: 'https://www.' },
        { domain: 'iyf.tv', prefix: 'https://www.' }
    ];
    for (const rule of domainRules) {
        const regex = new RegExp(`.*?(${rule.domain.replace('.', '\\.')}[^\\s]*)`, 'i');
        const match = text.match(regex);
        if (match) {
            let capturedUrl = match[1];
            if (capturedUrl.toLowerCase().startsWith('www.')) {
                return 'https://' + capturedUrl;
            }
            return rule.prefix + capturedUrl;
        }
    }
    return '';
}

/**
 * 根据输入框内容更新UI模式（搜索模式 vs 下载模式）。
 */
function updateInputMode() {
    const text = dom.urlOrSearchInput.value;
    const url = extractUrlFromInput(text);
    const strategy = findStrategyFor(url);

    const isUrlMode = !!strategy || !!url;
    dom.startDownloadBtn.style.display = isUrlMode ? 'flex' : 'none';
    dom.searchOnlineBtn.style.display = isUrlMode ? 'none' : 'flex';

    if (strategy) {
        dom.panelDescription.textContent = strategy.getDescription();
    } else if (url) {
        dom.panelDescription.textContent = '检测到未知链接，将尝试作为抖音视频处理...';
    } else {
        dom.panelDescription.textContent = '输入歌曲名进行在线搜索，或粘贴视频链接进行本地下载。';
    }
}


/**
 * 更新下载面板底部的状态信息。
 */
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

/**
 * 创建单个搜索结果项的 DOM 元素。
 */
function createResultItem(track, index, isCached = false) {
    const itemNode = getTemplate('template-search-result-item');
    const itemEl = itemNode.querySelector('.playlist-item');
    itemEl.dataset.index = index;
    itemEl.dataset.src = track.originalSrc;
    itemEl.querySelector('.playlist-icon').textContent = '🎵';
    itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
    itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';

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
 */
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


/**
 * 处理“导入本地资源”按钮的点击事件。
 */
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
            await window.electronAPI.startLocalImport(result.filePaths[0]);
        }
    } catch (error) {
        ui.showToast(`导入出错: ${error.message}`, 'error');
    } finally {
        [importBtn, dom.searchOnlineBtn, dom.startDownloadBtn].forEach(btn => btn.disabled = false);
        importBtn.classList.remove('loading');
    }
}

/**
 * 处理下载功能缺少核心工具（如FFmpeg）的情况。
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
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);
    dom.searchOnlineBtn.addEventListener('click', () => performSearch(dom.urlOrSearchInput.value.trim(), 1));

    dom.startDownloadBtn.addEventListener('click', () => {
        const url = extractUrlFromInput(dom.urlOrSearchInput.value);
        if (!url) {
            updateStatus('请输入有效的URL。', 'error');
            return;
        }
        const strategy = findStrategyFor(url) || new DouyinStrategy();
        strategy.execute(url);
        dom.startDownloadBtn.disabled = true;
        dom.startDownloadBtn.classList.add('loading');
    });

    dom.importLocalBtn.addEventListener('click', handleLocalImportClick);

    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const track = currentSearchResults[parseInt(item.dataset.index, 10)];
        if (!track) return;
        if (e.target.closest('.playlist-download-btn:not(.cached)')) {
            e.stopPropagation();
            ui.updateSearchResultItemStatus(item, 'downloading');
            mediaService.cacheTrack(track);
        } else {
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
            [dom.startDownloadBtn, dom.importLocalBtn].forEach(btn => {
                btn.disabled = false;
                btn.classList.remove('loading');
            });
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
            }
        });
    });
}