// src/renderer/js/ui/panelManager.js

/**
 * @file 面板管理器模块
 * @description 管理所有侧滑面板的显示/隐藏逻辑，并处理媒体库的搜索过滤。
 */

import * as dom from '../dom.js';
import { getters, subscribe } from '../state.js';
import { getTemplate } from '../utils.js';

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
        fragment.appendChild(itemEl);
    });

    // 追加“无结果”的模板项，用于搜索过滤
    fragment.appendChild(getTemplate('template-playlist-no-results'));
    dom.playlistEl.appendChild(fragment);
}

/**
 * 根据搜索关键词过滤播放列表的显示。
 */
export function filterPlaylist() {
    const query = dom.playlistSearchInput?.value.toLowerCase().replace(/\s/g, '') || '';
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

        // 匹配逻辑：标题、歌手、全拼、首字母
        const isMatch = !query ||
            (track.title || '').toLowerCase().includes(query) ||
            (track.artist || '').toLowerCase().includes(query) ||
            track.pinyin.includes(query) ||
            track.initials.includes(query);

        item.classList.toggle('hidden', !isMatch);
        if (isMatch) hasVisibleItems = true;
    });

    const noResultsEl = document.getElementById('playlist-no-results');
    if (noResultsEl) {
        noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
    }
}

/**
 * 初始化面板管理器模块。
 */
export function init() {
    subscribe('playlistChanged', renderPlaylist);

    // 初始化时渲染一次播放列表
    renderPlaylist(getters.playlist());

    console.log("Panel Manager UI module initialized.");
}