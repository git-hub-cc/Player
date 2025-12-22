// src/renderer/js/ui/panelManager.js

/**
 * @file 面板管理器模块
 * @description 管理所有侧滑面板的显示/隐藏逻辑，并处理媒体库的搜索过滤。
 */

import * as dom from '../dom.js';
import { getters, mutations, subscribe } from '../state.js';
import { getTemplate } from '../utils.js';
import { FILTER_MODES } from '../config.js';

/**
 * 关闭所有活动的侧边面板和“更多选项”菜单。
 */
export function closeActivePanels() {
    dom.allSidePanels.forEach(panel => panel?.classList.remove('active'));
    dom.moreOptionsMenu?.classList.remove('visible');
}

/**
 * 管理侧边面板的显示与隐藏，确保同一时间只有一个面板打开。
 * @param {HTMLElement} panelToToggle - 要切换的面板元素。
 */
function manageSidePanel(panelToToggle) {
    if (!panelToToggle) return;
    const isActive = panelToToggle.classList.contains('active');
    closeActivePanels();
    if (!isActive) {
        panelToToggle.classList.add('active');
    }
}

/** 切换“更多选项”菜单的可见性 */
export function toggleMoreOptionsMenu() {
    if (dom.allSidePanels.some(p => p.classList.contains('active'))) {
        closeActivePanels();
    }
    dom.moreOptionsMenu?.classList.toggle('visible');
}

// --- 面板切换函数 ---
export function toggleLyricsPanel() { dom.lyricsContainer?.classList.toggle('active'); }
export function togglePlaylistPanel() { manageSidePanel(dom.playlistPanel); }
export function toggleInfoPanel() { manageSidePanel(dom.infoPanel); }
export function toggleShortcutPanel() { manageSidePanel(dom.shortcutPanel); }
export function toggleDownloadPanel() { manageSidePanel(dom.downloadPanel); }
export function toggleSettingsPanel() { manageSidePanel(dom.settingsPanel); }

/**
 * 渲染整个播放列表。
 * @param {Array<object>} playlist - 播放列表数组。
 */
function renderPlaylist(playlist) {
    if (!dom.playlistEl) return;
    dom.playlistEl.innerHTML = '';
    const fragment = document.createDocumentFragment();

    playlist.forEach((track, index) => {
        const itemNode = getTemplate('template-playlist-item');
        const itemEl = itemNode.querySelector('.playlist-item');
        if (!itemEl) return;
        itemEl.dataset.index = index;
        itemEl.querySelector('.playlist-icon').textContent = track.type === 'video' ? '🎬' : '🎵';
        itemEl.querySelector('.playlist-title').textContent = track.title;
        itemEl.querySelector('.playlist-artist').textContent = track.artist;

        // =========================================================================
        // 【核心修改】为视频项添加类名并设置进度条宽度
        // =========================================================================
        if (track.type === 'video') {
            itemEl.classList.add('is-video');
            const progressBarInner = itemEl.querySelector('.video-progress-bar-inner');
            if (progressBarInner && track.totalDuration > 0) {
                const progress = (track.lastPosition / track.totalDuration) * 100;
                progressBarInner.style.width = `${Math.min(100, progress)}%`;
            }
        }
        // =========================================================================

        fragment.appendChild(itemEl);
    });

    // 追加“无结果”的模板项，用于搜索过滤
    fragment.appendChild(getTemplate('template-playlist-no-results'));
    dom.playlistEl.appendChild(fragment);

    // 渲染完成后立即执行一次过滤，确保符合当前模式
    filterPlaylist();
}

/**
 * 根据搜索关键词和过滤模式过滤播放列表的显示。
 */
export function filterPlaylist() {
    const query = dom.playlistSearchInput?.value.toLowerCase().replace(/\s/g, '') || '';
    const currentFilterMode = getters.mediaFilterMode();
    let hasVisibleItems = false;
    const playlist = getters.playlist();

    dom.getAllPlaylistItems().forEach((item, itemIndex) => {
        const index = parseInt(item.dataset.index, 10);
        // 确保索引有效
        if (isNaN(index) || index < 0 || index >= playlist.length) {
            item.classList.add('hidden'); // 隐藏无效项
            return;
        }
        const track = playlist[index];

        // 1. 类型过滤逻辑
        let typeMatch = true;
        if (currentFilterMode === FILTER_MODES.AUDIO) {
            typeMatch = track.type !== 'video';
        } else if (currentFilterMode === FILTER_MODES.VIDEO) {
            typeMatch = track.type === 'video';
        }

        // 2. 搜索匹配逻辑：标题、歌手、全拼、首字母
        const searchMatch = !query ||
            (track.title || '').toLowerCase().includes(query) ||
            (track.artist || '').toLowerCase().includes(query) ||
            track.pinyin.includes(query) ||
            track.initials.includes(query);

        // 综合判断
        const isVisible = typeMatch && searchMatch;

        item.classList.toggle('hidden', !isVisible);
        if (isVisible) hasVisibleItems = true;
    });

    const noResultsEl = document.getElementById('playlist-no-results');
    if (noResultsEl) {
        noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
    }
}

/**
 * 更新过滤模式按钮的 UI 状态。
 */
function updateFilterModeUI(mode) {
    dom.filterModeBtns.forEach(btn => {
        if (btn.dataset.mode === mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// =========================================================================
// 【核心新增】实时更新播放列表中单个视频项的进度条
// =========================================================================
/**
 * 当视频播放进度更新时，同步更新播放列表中的对应项UI。
 * @param {{index: number, track: object}} payload - 包含轨道索引和更新后轨道数据的对象。
 */
function updatePlaylistItemProgress({ index, track }) {
    if (track.type !== 'video') return;

    // 查找DOM中对应的列表项
    const itemEl = dom.playlistEl.querySelector(`.playlist-item[data-index="${index}"]`);
    if (!itemEl) return;

    const progressBarInner = itemEl.querySelector('.video-progress-bar-inner');
    if (progressBarInner && track.totalDuration > 0) {
        const progress = (track.lastPosition / track.totalDuration) * 100;
        progressBarInner.style.width = `${Math.min(100, progress)}%`;
    }
}
// =========================================================================

/**
 * 初始化面板管理器模块。
 */
export function init() {
    subscribe('playlistChanged', renderPlaylist);

    // =========================================================================
    // 【核心新增】订阅进度更新事件
    // =========================================================================
    subscribe('trackProgressChanged', updatePlaylistItemProgress);
    // =========================================================================

    // 订阅过滤模式变更，更新UI并重新过滤列表
    subscribe('filterModeChanged', (mode) => {
        updateFilterModeUI(mode);
        filterPlaylist();
    });

    // 绑定过滤按钮点击事件
    dom.filterModeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            mutations.setMediaFilterMode(mode);
        });
    });

    // 初始化时渲染一次播放列表和模式状态
    renderPlaylist(getters.playlist());
    updateFilterModeUI(getters.mediaFilterMode());

    console.log("Panel Manager UI module initialized.");
}