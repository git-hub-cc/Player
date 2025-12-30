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

// 【核心新增】记录当前正在缓存（下载）的曲目ID集合
// Set<trackId>
const activeCacheDownloads = new Set();

// --- 策略模式 ---
class DownloadStrategy {
    isApplicable(url) { throw new Error("策略必须实现 isApplicable 方法。"); }
    getDescription() { throw new Error("策略必须实现 getDescription 方法。"); }
    execute(url) { window.electronAPI.startDownload(url); }
}

class BilibiliStrategy extends DownloadStrategy {
    isApplicable(url) { return url.includes('bilibili.com/video/') || url.includes('b23.tv'); }
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

const downloadStrategies = [
    new BilibiliStrategy(),
    new JableStrategy(),
    new YoutubeStrategy(),
    new DouyinStrategy(),
    new IyfStrategy()
];

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
    const domainRules = [
        { domain: 'bilibili.com', prefix: 'https://www.' },
        { domain: 'douyin.com', prefix: 'https://www.' },
        { domain: 'iesdouyin.com', prefix: 'https://www.' },
        { domain: 'jable.tv', prefix: 'https://www.' },
        { domain: 'youtube.com', prefix: 'https://www.' },
        { domain: 'youtu.be', prefix: 'https://' },
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

function updateInputMode() {
    // 只有在非下载状态下才更新UI，避免覆盖“取消下载”按钮
    if (dom.startDownloadBtn.classList.contains('downloading')) return;

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

    // 注入图标
    const placeholders = itemEl.querySelectorAll('.icon-placeholder');
    const iconMap = {
        DOWNLOAD: ICONS.ICON_DOWNLOAD,
        SPINNER: ICONS.ICON_SPINNER,
        CACHED: ICONS.ICON_CACHED,
        // 【核心新增】停止/取消图标
        STOP: ICONS.ICON_STOP
    };
    placeholders.forEach(ph => {
        const iconName = ph.dataset.icon;
        if (iconMap[iconName]) ph.outerHTML = iconMap[iconName];
    });

    const downloadBtn = itemEl.querySelector('.playlist-download-btn');
    downloadBtn.classList.toggle('cached', isCached);

    // 如果该曲目正在下载中，设置下载状态
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
            await window.electronAPI.startLocalImport(result.filePaths[0]);
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

// =========================================================================
// 【核心修改】事件监听器绑定逻辑
// =========================================================================
export function setupDownloaderListeners() {
    dom.urlOrSearchInput.addEventListener('input', updateInputMode);

    // 搜索按钮
    dom.searchOnlineBtn.addEventListener('click', () => performSearch(dom.urlOrSearchInput.value.trim(), 1));

    // 下载/取消按钮
    dom.startDownloadBtn.addEventListener('click', () => {
        const btn = dom.startDownloadBtn;

        // 如果正在下载，点击则为取消
        if (btn.classList.contains('downloading')) {
            window.electronAPI.cancelDownload(null, 'url-download');
            // UI更新会由 download-status 事件触发（类型为 error）
            return;
        }

        const url = extractUrlFromInput(dom.urlOrSearchInput.value);
        if (!url) {
            updateStatus('请输入有效的URL。', 'error');
            return;
        }

        const strategy = findStrategyFor(url) || new DouyinStrategy();

        try {
            strategy.execute(url);

            // 切换按钮状态为“取消下载”
            btn.classList.add('downloading');
            const btnText = btn.querySelector('.btn-text');
            const btnLoader = btn.querySelector('.btn-loader');
            if (btnText) btnText.textContent = '取消下载';
            // 添加一个醒目的样式类，比如变红
            btn.classList.add('danger-mode');

        } catch (e) {
            // execute 内部的校验错误，无需处理
        }
    });

    dom.importLocalBtn.addEventListener('click', handleLocalImportClick);

    // 搜索结果列表点击（下载/取消缓存）
    dom.searchResultsList.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (!item) return;
        const track = currentSearchResults[parseInt(item.dataset.index, 10)];
        if (!track) return;

        const downloadBtn = e.target.closest('.playlist-download-btn');

        if (downloadBtn && !downloadBtn.classList.contains('cached')) {
            e.stopPropagation();

            // 如果正在下载，则取消
            if (downloadBtn.classList.contains('downloading')) {
                window.electronAPI.cancelDownload(track.id, 'cache-download');
                // 乐观更新UI：立即移除下载状态
                downloadBtn.classList.remove('downloading');
                downloadBtn.title = "下载到本地";
                activeCacheDownloads.delete(track.id);
            } else {
                // 开始下载
                activeCacheDownloads.add(track.id);
                ui.updateSearchResultItemStatus(item, 'downloading');
                downloadBtn.title = "取消下载";
                mediaService.cacheTrack(track);
            }
        } else if (!downloadBtn) {
            // 点击条目本身播放
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

        // 只有当任务结束（成功或失败/取消）时，才重置按钮状态
        if (status.type === 'success' || status.type === 'error') {
            // 重置“开始下载”按钮
            const dlBtn = dom.startDownloadBtn;
            dlBtn.disabled = false;
            dlBtn.classList.remove('loading', 'downloading', 'danger-mode');
            const btnText = dlBtn.querySelector('.btn-text');
            if (btnText) btnText.textContent = '开始下载';

            // 导入按钮也重置
            dom.importLocalBtn.disabled = false;
            dom.importLocalBtn.classList.remove('loading');

            // 如果是在线缓存的任务结束
            // 注意：这里无法直接得知是哪个具体的 trackID 结束了，
            // 实际上应该在 status 消息中带回 id。
            // 但目前的架构是靠 message 文本匹配。为了简化，这里仅重置全局下载按钮。
            // 列表项的状态重置目前依赖乐观UI更新或播放列表变更事件。

            // 如果是取消操作，强制刷新输入框状态
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