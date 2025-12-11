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
let initialTime = 0; // 用于存储从本地状态恢复的播放时间点

/**
 * 将播放器的当前状态保存到 localStorage。
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
 * 从 localStorage 加载并应用播放器状态。
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
            localStorage.removeItem(PLAYER_STATE_KEY); // 解析失败则清除无效数据
        }
    }
}

/**
 * 处理删除曲目的请求流程，包括用户确认和UI更新。
 * @param {number} index - 要删除的曲目在播放列表中的索引。
 */
async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        // 弹出确认对话框
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        const wasPlaying = state.isPlaying;
        const isDeletingCurrent = state.currentTrackIndex === index;

        // 如果删除的是当前播放曲目，先重置播放器UI
        if (isDeletingCurrent) {
            resetPlayerUI();
        }

        // 调用主进程执行实际的文件删除操作
        const deleted = await requestTrackDeletion(track);

        // 如果删除失败，则恢复UI状态
        if (!deleted) {
            if (isDeletingCurrent) {
                loadTrack(index, { forcePlay: wasPlaying });
            }
            return;
        }

        // --- 删除成功后的状态更新 ---
        const oldIndex = index;
        state.removeTrack(index); // 从state中移除曲目

        renderPlaylist(); // 重新渲染播放列表
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist); // 更新背景画廊数据

        if (state.playlist.length === 0) {
            toggleEmptyState(true); // 如果列表为空，显示空状态
        } else if (isDeletingCurrent) {
            // 如果删除的是当前曲目，决定下一首要播放的曲目
            let nextIndexToPlay = oldIndex;
            if (nextIndexToPlay >= state.playlist.length) {
                nextIndexToPlay = 0; // 如果是最后一首，则从头开始
            }
            state.setCurrentTrackIndex(nextIndexToPlay);
            loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
        }
        showToast(`"${track.title}" 已删除`);

    } catch (err) {
        // 用户取消删除或删除过程中发生其他错误
        console.log("删除操作已取消或失败。", err);
    }
}

/**
 * 将从主进程获取的曲目对象转换为前端可直接使用的格式。
 * 主要处理本地文件路径，为其添加 `media://` 协议头。
 * @param {object} track - 原始曲目对象
 * @returns {object} - 处理后可供播放的曲目对象
 */
function makeTrackPlayable(track) {
    const playableTrack = { ...track };

    // 辅助函数，对路径的每个部分进行编码
    const encodeMediaUrl = (relativePath) => {
        if (!relativePath) return '';
        const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        return `media://${encodedPath}`;
    };

    // 检查并转换 src, albumArt, lyrics 字段
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
    window.electronAPI.toggleFullscreen(true); // 请求主进程进入全屏
    backgroundGallery.startAutoScroll();
    dom.playerContainer.classList.add('screensaver-active');

    // 如果当前未播放，则开始播放
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
    window.electronAPI.toggleFullscreen(false); // 请求主进程退出全屏
    backgroundGallery.stopAutoScroll();
    dom.playerContainer.classList.remove('screensaver-active');
}

/**
 * 集中设置所有DOM元素的事件监听器。
 */
function setupEventListeners() {
    // 播放控制
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });

    // 媒体文件夹与空状态按钮
    if (dom.openMediaFolderBtn) {
        dom.openMediaFolderBtn.addEventListener('click', () => window.electronAPI.openMediaFolder());
    }
    if (dom.emptyStateSearchBtn) {
        dom.emptyStateSearchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDownloadPanel();
            setTimeout(() => { if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus(); }, 500);
        });
    }
    if (dom.emptyStateImportBtn) {
        dom.emptyStateImportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dom.importLocalBtn) dom.importLocalBtn.click();
        });
    }

    // 视频全屏功能
    if (dom.fullscreenBtn) {
        dom.fullscreenBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                dom.mediaPlayer.requestFullscreen().catch(err => console.error(`进入全屏失败: ${err.message}`));
            } else {
                document.exitFullscreen();
            }
        });
    }
    document.addEventListener('fullscreenchange', () => {
        const isFullscreen = !!document.fullscreenElement;
        if (dom.fullscreenBtn) dom.fullscreenBtn.classList.toggle('fullscreen-active', isFullscreen);
    });

    // 媒体播放器核心事件
    dom.mediaPlayer.addEventListener('loadedmetadata', () => {
        updateProgress();
        const seekTime = consumePendingSeek();
        if (seekTime > 0 && dom.mediaPlayer.duration > seekTime) {
            dom.mediaPlayer.currentTime = seekTime;
        }
    });
    dom.mediaPlayer.addEventListener('canplay', () => {
        hideSkeleton();
        if (state.isPlaying) playTrack();
    });
    dom.mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        currentMode === 'single' ? (dom.mediaPlayer.currentTime = 0, playTrack()) : playNextTrack();
    });
    dom.mediaPlayer.addEventListener('error', (e) => {
        if (!dom.mediaPlayer.getAttribute('src') && state.playlist.length === 0) return;
        console.error("媒体加载错误:", e);
        hideSkeleton();
        const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex];
        if (currentTrack) showToast(`播放失败: ${currentTrack.title}`, 'error');
    });

    // 进度条与音量条
    dom.progressBar.addEventListener('mousedown', () => state.setIsScrubbing(true));
    dom.progressBar.addEventListener('input', (e) => {
        dom.progressBar.style.setProperty('--value-percent', `${e.target.value}%`);
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.currentTimeEl.textContent = formatTime((e.target.value / 100) * dom.mediaPlayer.duration);
        }
    });
    dom.progressBar.addEventListener('change', (e) => {
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration;
        }
        resetBackgroundBeatTimer();
        state.setIsScrubbing(false);
        if (state.isPlaying) dom.mediaPlayer.play();
    });
    dom.volumeBtn.addEventListener('click', () => {
        dom.mediaPlayer.muted = !dom.mediaPlayer.muted;
        updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
        savePlayerState();
    });
    dom.volumeBar.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        dom.mediaPlayer.volume = newVolume;
        dom.mediaPlayer.muted = newVolume === 0;
        updateVolumeBarVisual(newVolume, dom.mediaPlayer.muted);
        savePlayerState();
    });

    // 面板切换
    [dom.lyricsBtn, dom.mobileLyricsBtn].forEach(btn => btn.addEventListener('click', toggleLyricsPanel));
    [dom.playlistBtn, dom.mobilePlaylistBtn].forEach(btn => btn.addEventListener('click', togglePlaylistPanel));
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);

    // 面板关闭逻辑
    [dom.closePlaylistBtn, dom.closeInfoBtn, dom.closeShortcutBtn, dom.closeDownloadBtn].forEach(btn => btn.addEventListener('click', closeActivePanels));
    [...dom.allSidePanels, dom.lyricsContainer].forEach(panel => {
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); });
    });
    dom.mainView.addEventListener('click', closeActivePanels);

    // 播放列表交互
    dom.playlistEl.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            if (state.currentTrackIndex !== newIndex) {
                loadTrack(newIndex, { forcePlay: true });
                savePlayerState();
            }
        }
    });
    dom.playlistSearchInput.addEventListener('input', filterPlaylist);

    // 右键菜单
    document.addEventListener('contextmenu', (e) => {
        if (state.playlist.length === 0) return;
        hideContextMenu();
        const playlistItem = e.target.closest('#playlist .playlist-item');
        const context = playlistItem ? { type: 'playlist-item', index: parseInt(playlistItem.dataset.index, 10) } : { type: 'global' };
        if (context.type === 'playlist-item') e.preventDefault();
        const { normalizedX, normalizedY } = normalizePosition(e.clientX, e.clientY);
        dom.contextMenu.style.top = `${normalizedY}px`;
        dom.contextMenu.style.left = `${normalizedX}px`;
        renderContextMenu(context);
        dom.contextMenu.style.display = 'block';
    });
    document.addEventListener('click', (e) => {
        if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) hideContextMenu();
    });
    dom.contextMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName !== 'LI' || !target.dataset.action) return;
        hideContextMenu();
        const action = target.dataset.action;
        const index = parseInt(target.dataset.index, 10);
        action === 'delete-track' && !isNaN(index) ? handleDeleteTrackRequest(index) : executeShortcut(action);
    });

    // 全局快捷键
    window.addEventListener('keydown', (e) => {
        // =========================================================================
        // 【核心修改】当按下 Esc 键时，除了隐藏右键菜单，也检查并退出屏保模式。
        // =========================================================================
        if (e.key === 'Escape') {
            hideContextMenu();
            if (state.isScreensaverMode) {
                exitScreensaverMode();
            }
        }
        // =========================================================================

        if (e.key === 'F11') {
            e.preventDefault();
            state.isScreensaverMode ? exitScreensaverMode() : enterScreensaverMode();
            return;
        }
        if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return;
        if (state.playlist.length === 0) return;
        state.pressedShortcutKeys.add(normalizeKey(e.key));
        for (const actionId in state.shortcutSettings) {
            const requiredKeys = new Set(state.shortcutSettings[actionId].keys);
            if (requiredKeys.size > 0 && requiredKeys.size === state.pressedShortcutKeys.size && [...requiredKeys].every(key => state.pressedShortcutKeys.has(key))) {
                e.preventDefault();
                executeShortcut(actionId);
                break;
            }
        }
    });
    window.addEventListener('keyup', (e) => {
        if (!state.isRecordingShortcut) state.pressedShortcutKeys.delete(normalizeKey(e.key));
    });

    // 主进程通信
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

    // 初始化各个功能模块
    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    window.addEventListener('beforeunload', savePlayerState);
}

/**
 * 应用程序初始化函数。
 */
async function init() {
    showSkeleton();
    loadPlayerState();

    // 从主进程获取持久化的播放列表
    const localResult = await window.electronAPI.getLocalPlaylist();
    if (localResult.success && localResult.data.length > 0) {
        const localPlaylist = localResult.data.map(track => ({
            ...makeTrackPlayable(track),
            pinyin: pinyin(track.title || '', { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(track.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        }));
        state.setPlaylist(localPlaylist);
    }

    // 确保当前曲目索引有效
    if (state.currentTrackIndex >= state.playlist.length || state.currentTrackIndex < 0) {
        state.setCurrentTrackIndex(0);
    }

    // 初始化背景画廊
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

    // 更新UI初始状态
    updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
    updateModeButton();
    loadShortcuts();
    renderContextMenu({ type: 'global' });
    setupEventListeners();
}

// 页面加载完成后开始初始化
document.addEventListener('DOMContentLoaded', init);