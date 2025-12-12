// src/renderer/js/renderer.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { normalizeKey, formatTime } from './utils.js';
import { pinyin } from 'pinyin-pro';
import {
    loadTrack,
    togglePlayPause,
    playNextTrack,
    playPrevTrack,
    updateProgress,
    cyclePlayMode,
    resetBackgroundBeatTimer,
    resetPlayerUI,
    consumePendingSeek,
    playTrack
} from './player.js';
import {
    renderPlaylist,
    filterPlaylist,
    toggleLyricsPanel,
    togglePlaylistPanel,
    toggleInfoPanel,
    toggleShortcutPanel,
    updateVolumeBarVisual,
    showSkeleton,
    hideSkeleton,
    hideContextMenu,
    renderContextMenu,
    normalizePosition,
    updateModeButton,
    updatePlaylistUI,
    setupLyricsDragHandler,
    closeActivePanels,
    toggleDownloadPanel,
    showToast,
    showConfirmationModal,
    toggleEmptyState
} from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners, requestTrackDeletion } from './features/downloader.js';

// --- 持久化 ---
const PLAYER_STATE_KEY = 'player_state';
let initialTime = 0;

/**
 * 保存播放器状态到 localStorage。
 */
function savePlayerState() {
    const stateToSave = {
        trackIndex: state.currentTrackIndex,
        currentTime: dom.mediaPlayer.currentTime,
        volume: dom.mediaPlayer.volume,
        muted: dom.mediaPlayer.muted,
        modeIndex: state.currentModeIndex
    };
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(stateToSave));
}

/**
 * 从 localStorage 加载播放器状态。
 */
function loadPlayerState() {
    const savedState = localStorage.getItem(PLAYER_STATE_KEY);
    if (savedState) {
        try {
            const parsedState = JSON.parse(savedState);
            state.setCurrentTrackIndex(parsedState.trackIndex || 0);
            state.setCurrentModeIndex(parsedState.modeIndex || 0);
            dom.mediaPlayer.volume = parsedState.volume ?? 1;
            dom.mediaPlayer.muted = parsedState.muted ?? false;
            initialTime = parsedState.currentTime || 0;
        } catch (error) {
            console.error("解析播放器状态失败:", error);
            localStorage.removeItem(PLAYER_STATE_KEY);
        }
    }
}

/**
 * 处理删除曲目的完整流程。
 * @param {number} index - 要删除的曲目索引。
 */
async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        // 弹出确认对话框
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        const wasPlaying = state.isPlaying;
        const isDeletingCurrent = state.currentTrackIndex === index;

        // 如果删除的是当前曲目，先重置播放器UI
        if (isDeletingCurrent) {
            resetPlayerUI();
        }

        const deleted = await requestTrackDeletion(track);
        if (!deleted) {
            // 如果后端删除失败，恢复播放状态
            if (isDeletingCurrent) {
                loadTrack(index, { forcePlay: wasPlaying });
            }
            return;
        }

        const oldIndex = index;
        state.removeTrack(index); // 从前端状态中移除

        // 更新所有相关的UI
        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);

        // =========================================================================
        // 【核心修复】检查播放列表是否在删除后变空
        // =========================================================================
        if (state.playlist.length === 0) {
            // 如果列表为空，强制进入空状态界面
            toggleEmptyState(true);
            showToast(`"${track.title}" 已删除`);
            return; // 终止后续操作
        }
        // =========================================================================

        // 如果列表不为空，且删除的是当前曲目，则播放下一首
        if (isDeletingCurrent) {
            let nextIndexToPlay = oldIndex;
            if (nextIndexToPlay >= state.playlist.length) {
                nextIndexToPlay = 0; // 如果是最后一个，则从头开始
            }
            state.setCurrentTrackIndex(nextIndexToPlay);
            loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
        }

        showToast(`"${track.title}" 已删除`);

    } catch (err) {
        // 用户取消了删除操作
        console.log("删除操作已取消或失败。", err);
    }
}

/**
 * 将后端返回的相对路径转换为可播放的 `media://` 协议 URL。
 * @param {object} track - 曲目对象。
 * @returns {object} - 处理后的曲目对象。
 */
function makeTrackPlayable(track) {
    const playableTrack = { ...track };
    const encodeMediaUrl = (relativePath) => {
        if (!relativePath) return '';
        // 对路径的每一部分进行编码，防止特殊字符（如#）导致路径解析错误
        const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        return `media://${encodedPath}`;
    };
    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
            playableTrack[key] = encodeMediaUrl(value);
        }
    });
    return playableTrack;
}

/**
 * 进入屏保/演示模式。
 */
function enterScreensaverMode() {
    if (state.isScreensaverMode || state.playlist.length === 0) return;
    console.log('进入屏保模式...');
    state.setScreensaverMode(true);
    window.electronAPI.toggleFullscreen(true);
    backgroundGallery.startAutoScroll();
    dom.playerContainer.classList.add('screensaver-active');
    if (!state.isPlaying) {
        if (dom.mediaPlayer.src && dom.mediaPlayer.currentTime > 0) {
            playTrack();
        } else {
            loadTrack(state.currentTrackIndex, { forcePlay: true });
        }
    }
}

/**
 * 退出屏保/演示模式。
 */
function exitScreensaverMode() {
    if (!state.isScreensaverMode) return;
    console.log('退出屏保模式...');
    state.setScreensaverMode(false);
    window.electronAPI.toggleFullscreen(false);
    backgroundGallery.stopAutoScroll();
    dom.playerContainer.classList.remove('screensaver-active');
}


/**
 * 设置监听器以处理核心组件（ffmpeg, yt-dlp）的下载进度UI。
 */
function setupCoreComponentDownloader() {
    const modal = document.getElementById('download-progress-modal');
    const titleEl = document.getElementById('download-progress-title');
    const fileEl = document.getElementById('download-progress-file');
    const barEl = document.getElementById('download-progress-bar');
    const percentEl = document.getElementById('download-progress-percent');

    window.electronAPI.onDownloadStarted(({ file }) => {
        titleEl.textContent = '正在下载核心组件...';
        fileEl.textContent = `文件: ${file}`;
        barEl.style.width = '0%';
        percentEl.textContent = '0%';
        modal.classList.add('visible');
    });

    window.electronAPI.onDownloadProgress(({ file, progress, status }) => {
        fileEl.textContent = `文件: ${file}`;
        if (status) { // 处理解压等不确定进度的状态
            barEl.style.width = '100%';
            percentEl.textContent = status;
        } else {
            barEl.style.width = `${progress}%`;
            percentEl.textContent = `${progress}%`;
        }
    });

    window.electronAPI.onDownloadFinished(({ success, error }) => {
        if (success) {
            titleEl.textContent = '准备完成！';
            fileEl.textContent = '所有组件已就绪。';
            setTimeout(() => {
                modal.classList.remove('visible');
            }, 1500);
        } else {
            titleEl.textContent = '下载失败！';
            fileEl.textContent = `错误: ${error || '未知错误'}`;
            // 失败时保持模态框可见，让用户看到错误信息
        }
    });
}


/**
 * 初始化所有事件监听器。
 */
function setupEventListeners() {
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });

    if (dom.openMediaFolderBtn) dom.openMediaFolderBtn.addEventListener('click', () => window.electronAPI.openMediaFolder());
    if (dom.emptyStateSearchBtn) dom.emptyStateSearchBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDownloadPanel(); setTimeout(() => { if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus(); }, 500); });
    if (dom.emptyStateImportBtn) dom.emptyStateImportBtn.addEventListener('click', (e) => { e.stopPropagation(); if (dom.importLocalBtn) dom.importLocalBtn.click(); });
    if (dom.fullscreenBtn) dom.fullscreenBtn.addEventListener('click', () => { if (!document.fullscreenElement) dom.mediaPlayer.requestFullscreen().catch(err => console.error(`进入全屏失败: ${err.message}`)); else document.exitFullscreen(); });

    // =========================================================================
    // 【新增】为 main-view 添加双击事件，实现沉浸式全屏
    // =========================================================================
    dom.mainView.addEventListener('dblclick', () => {
        // 鲁棒性检查：如果已处于原生全屏或屏保模式，则不执行操作，避免状态冲突
        if (document.fullscreenElement || state.isScreensaverMode) {
            return;
        }
        // 切换CSS类以激活或取消全屏样式
        dom.mainView.classList.toggle('main-view-fullscreen');
    });
    // =========================================================================

    document.addEventListener('fullscreenchange', () => { if (dom.fullscreenBtn) dom.fullscreenBtn.classList.toggle('fullscreen-active', !!document.fullscreenElement); });

    dom.mediaPlayer.addEventListener('loadedmetadata', () => { updateProgress(); const seekTime = consumePendingSeek(); if (seekTime > 0 && dom.mediaPlayer.duration > seekTime) dom.mediaPlayer.currentTime = seekTime; });
    dom.mediaPlayer.addEventListener('canplay', () => { hideSkeleton(); if (state.isPlaying) playTrack(); });
    dom.mediaPlayer.addEventListener('ended', () => { const currentMode = PLAY_MODES[state.currentModeIndex]; currentMode === 'single' ? (dom.mediaPlayer.currentTime = 0, playTrack()) : playNextTrack(); });
    dom.mediaPlayer.addEventListener('error', (e) => { if (!dom.mediaPlayer.getAttribute('src') && state.playlist.length === 0) return; console.error("媒体加载错误:", e); hideSkeleton(); const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex]; if (currentTrack) showToast(`播放失败: ${currentTrack.title}`, 'error'); });

    dom.progressBar.addEventListener('mousedown', () => state.setIsScrubbing(true));
    dom.progressBar.addEventListener('input', (e) => { dom.progressBar.style.setProperty('--value-percent', `${e.target.value}%`); if (!isNaN(dom.mediaPlayer.duration)) dom.currentTimeEl.textContent = formatTime((e.target.value / 100) * dom.mediaPlayer.duration); });
    dom.progressBar.addEventListener('change', (e) => { if (!isNaN(dom.mediaPlayer.duration)) dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration; resetBackgroundBeatTimer(); state.setIsScrubbing(false); if (state.isPlaying) dom.mediaPlayer.play(); });

    dom.volumeBtn.addEventListener('click', () => { dom.mediaPlayer.muted = !dom.mediaPlayer.muted; updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted); savePlayerState(); });
    dom.volumeBar.addEventListener('input', (e) => { const newVolume = parseFloat(e.target.value); dom.mediaPlayer.volume = newVolume; dom.mediaPlayer.muted = newVolume === 0; updateVolumeBarVisual(newVolume, dom.mediaPlayer.muted); savePlayerState(); });

    [dom.lyricsBtn, dom.mobileLyricsBtn].forEach(btn => btn.addEventListener('click', toggleLyricsPanel));
    [dom.playlistBtn, dom.mobilePlaylistBtn].forEach(btn => btn.addEventListener('click', togglePlaylistPanel));
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);
    [dom.closePlaylistBtn, dom.closeInfoBtn, dom.closeShortcutBtn, dom.closeDownloadBtn].forEach(btn => btn.addEventListener('click', closeActivePanels));
    [...dom.allSidePanels, dom.lyricsContainer].forEach(panel => panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); }));
    dom.mainView.addEventListener('click', (e) => {
        // 【修改】仅在非全屏模式下，点击 main-view 才关闭面板
        if (!dom.mainView.classList.contains('main-view-fullscreen')) {
            closeActivePanels();
        }
    });

    dom.playlistEl.addEventListener('click', (e) => { const item = e.target.closest('.playlist-item'); if (item) { const newIndex = parseInt(item.dataset.index, 10); if (state.currentTrackIndex !== newIndex) { loadTrack(newIndex, { forcePlay: true }); savePlayerState(); } } });
    dom.playlistSearchInput.addEventListener('input', filterPlaylist);

    document.addEventListener('contextmenu', (e) => { if (state.playlist.length === 0) return; hideContextMenu(); const playlistItem = e.target.closest('#playlist .playlist-item'); const context = playlistItem ? { type: 'playlist-item', index: parseInt(playlistItem.dataset.index, 10) } : { type: 'global' }; if (context.type === 'playlist-item') e.preventDefault(); const { normalizedX, normalizedY } = normalizePosition(e.clientX, e.clientY); dom.contextMenu.style.top = `${normalizedY}px`; dom.contextMenu.style.left = `${normalizedX}px`; renderContextMenu(context); dom.contextMenu.style.display = 'block'; });
    document.addEventListener('click', (e) => { if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) hideContextMenu(); });

    dom.contextMenu.addEventListener('click', (e) => { const target = e.target; if (target.tagName !== 'LI' || !target.dataset.action) return; hideContextMenu(); const action = target.dataset.action; const index = parseInt(target.dataset.index, 10); action === 'delete-track' && !isNaN(index) ? handleDeleteTrackRequest(index) : executeShortcut(action); });

    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideContextMenu(); if (state.isScreensaverMode) exitScreensaverMode(); } if (e.key === 'F11') { e.preventDefault(); state.isScreensaverMode ? exitScreensaverMode() : enterScreensaverMode(); return; } if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return; if (state.playlist.length === 0) return; state.pressedShortcutKeys.add(normalizeKey(e.key)); for (const actionId in state.shortcutSettings) { const requiredKeys = new Set(state.shortcutSettings[actionId].keys); if (requiredKeys.size > 0 && requiredKeys.size === state.pressedShortcutKeys.size && [...requiredKeys].every(key => state.pressedShortcutKeys.has(key))) { e.preventDefault(); executeShortcut(actionId); break; } } });
    window.addEventListener('keyup', (e) => { if (!state.isRecordingShortcut) state.pressedShortcutKeys.delete(normalizeKey(e.key)); });

    window.addEventListener('beforeunload', savePlayerState);

    // --- 主进程通信 ---
    window.electronAPI.onNewTrack((newTrack) => {
        document.dispatchEvent(new CustomEvent('new-track-added', { detail: newTrack }));
    });

    document.addEventListener('new-track-added', (event) => {
        const trackForPlaylist = makeTrackPlayable(event.detail);
        const oldPlaylistLength = state.playlist.length;
        state.setPlaylist([trackForPlaylist, ...state.playlist]);
        if (oldPlaylistLength === 0) {
            toggleEmptyState(false);
            state.setCurrentTrackIndex(0);
            backgroundGallery.init(state.playlist);
            loadTrack(0, { forcePlay: true });
        } else {
            state.setCurrentTrackIndex(state.currentTrackIndex + 1);
        }
        showToast(`已添加 "${trackForPlaylist.title}" 到下载列表！`);
        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);
    });

    window.electronAPI.onFullscreenChange((isFullscreen) => {
        if (!isFullscreen && state.isScreensaverMode) exitScreensaverMode();
    });

    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    setupCoreComponentDownloader();
}

/**
 * 应用初始化函数。
 */
async function init() {
    showSkeleton();
    loadPlayerState();

    const localResult = await window.electronAPI.getLocalPlaylist();
    if (localResult.success && localResult.data.length > 0) {
        const localPlaylist = localResult.data.map(track => ({
            ...makeTrackPlayable(track),
            pinyin: pinyin(track.title || '', { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(track.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        }));
        state.setPlaylist(localPlaylist);
    }

    if (state.currentTrackIndex >= state.playlist.length || state.currentTrackIndex < 0) {
        state.setCurrentTrackIndex(0);
    }

    backgroundGallery.init(state.playlist);

    if (state.playlist.length > 0) {
        toggleEmptyState(false);
        renderPlaylist();
        updatePlaylistUI();
        await loadTrack(state.currentTrackIndex, { initialTime });
    } else {
        resetPlayerUI();
        hideSkeleton();
        toggleEmptyState(true);
        setTimeout(() => toggleDownloadPanel(), 600);
    }

    updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
    updateModeButton();
    loadShortcuts();
    renderContextMenu({ type: 'global' });
    setupEventListeners();
}

document.addEventListener('DOMContentLoaded', init);