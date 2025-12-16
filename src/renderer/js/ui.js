// src/renderer/js/ui.js

/**
 * @file UI 协调器 (UI Orchestrator)
 * @description
 * 负责导入并初始化所有独立的UI子模块。
 * 这是UI层的总入口，确保所有部分按预期启动。
 */

import * as playerView from './ui/playerView.js';
import * as panelManager from './ui/panelManager.js';
import * as lyrics from './ui/lyrics.js';
import * as visuals from './ui/visuals.js';
import * as modals from './ui/modals.js';
import * as contextMenu from './ui/contextMenu.js';
import { getters } from './state.js';
import { PLAY_MODES } from './config.js';

// Re-export functions that are widely used across the application
// for easier import management in other modules.
export {
    showToast,
    showConfirmationModal,
    showSeekFeedback,
    showSpeedFeedback,
    toggleEmptyState
} from './ui/modals.js';

export {
    closeActivePanels,
    toggleMoreOptionsMenu,
    toggleLyricsPanel,
    togglePlaylistPanel,
    toggleInfoPanel,
    toggleShortcutPanel,
    toggleDownloadPanel,
    filterPlaylist
} from './ui/panelManager.js';

export {
    renderContextMenu,
    hideContextMenu
} from './ui/contextMenu.js';


/**
 * 清空搜索结果列表。
 * (保留在这里，因为它与downloader功能紧密相关，但属于UI操作)
 * @param {HTMLElement} listElement - 要清空的目标列表元素。
 */
export function clearSearchResults(listElement) {
    if (listElement) {
        listElement.innerHTML = '';
    }
}

/**
 * 渲染在线搜索结果。
 * (保留在这里，作为downloader和UI之间的桥梁)
 * @param {HTMLElement} listElement - 目标列表元素。
 * @param {Array<object>} tracks - 搜索结果轨道数组。
 * @param {Function} createResultItemFunc - 创建单个结果项的函数。
 */
export function renderSearchResults(listElement, tracks, createResultItemFunc) {
    clearSearchResults(listElement);
    if (!listElement || !tracks) return;

    const fragment = document.createDocumentFragment();
    const localPlaylist = getters.playlist();

    tracks.forEach((track, index) => {
        const isAlreadyInPlaylist = localPlaylist.some(pTrack =>
            pTrack.id === track.id && pTrack.source === track.source && !pTrack.src.startsWith('http')
        );
        fragment.appendChild(createResultItemFunc(track, index, isAlreadyInPlaylist));
    });
    listElement.appendChild(fragment);
}

/**
 * 更新单个搜索结果项的下载状态。
 * @param {HTMLElement} itemElement - 列表项元素。
 * @param {'downloading'|'cached'|'default'} status - 新的状态。
 */
export function updateSearchResultItemStatus(itemElement, status) {
    const downloadBtn = itemElement?.querySelector('.playlist-download-btn');
    if (!downloadBtn) return;
    downloadBtn.classList.remove('downloading', 'cached');
    if (status === 'downloading') {
        downloadBtn.classList.add('downloading');
    } else if (status === 'cached') {
        downloadBtn.classList.add('cached');
    }
}

/**
 * 渲染分页控制按钮。
 * @param {HTMLElement} container - 分页控件的容器元素。
 * @param {number} currentPage - 当前页码。
 * @param {number} totalPages - 总页数。
 */
export function renderPaginationControls(container, currentPage, totalPages) {
    if (!container) return;
    container.innerHTML = '';
    if (totalPages <= 1) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = `
        <button id="prev-page-btn" class="pagination-btn" title="上一页" ${currentPage <= 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path></svg>
        </button>
        <span class="page-info">${currentPage} / ${totalPages}</span>
        <button id="next-page-btn" class="pagination-btn" title="下一页" ${currentPage >= totalPages ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>
        </button>
    `;
}

/**
 * 主初始化函数，按顺序启动所有UI子模块。
 */
export function init() {
    // 基础视图和面板管理优先初始化
    playerView.init();
    panelManager.init();

    // 交互和视觉效果模块
    lyrics.init();
    visuals.init();

    // 监听来自其他模块派发的自定义UI事件
    window.addEventListener('showToast', (e) => {
        if (e.detail && e.detail.message) {
            modals.showToast(e.detail.message, e.detail.type);
        }
    });

    console.log("All UI modules initialized.");
}