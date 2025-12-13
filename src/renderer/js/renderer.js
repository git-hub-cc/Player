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

// --- 全局变量 ---
const PLAYER_STATE_KEY = 'player_state'; // 用于 localStorage 的键名
let initialTime = 0; // 应用启动时要加载的初始播放时间

/**
 * 保存当前播放器状态到 localStorage。
 * 包括当前曲目索引、播放时间、音量和播放模式。
 */
function savePlayerState() {
    // 如果播放列表为空，则移除状态，不保存
    if (state.playlist.length === 0) {
        localStorage.removeItem(PLAYER_STATE_KEY);
        return;
    }

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
            localStorage.removeItem(PLAYER_STATE_KEY); // 解析失败则清除无效数据
        }
    }
}

/**
 * 将后端返回的曲目对象转换为前端可直接播放的格式。
 * 主要处理本地文件路径，将其转换为自定义的 'media://' 协议。
 * @param {object} track - 后端返回的原始曲目对象。
 * @returns {object} - 转换后的曲目对象。
 */
function makeTrackPlayable(track) {
    const playableTrack = { ...track };

    const encodeMediaUrl = (relativePath) => {
        if (!relativePath) return '';
        // 对路径的每一部分进行编码，防止特殊字符（如#）导致路径解析错误
        const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        return `media://${encodedPath}`;
    };

    // 转换 src, albumArt, lyrics 字段
    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
            playableTrack[key] = encodeMediaUrl(value);
        }
    });
    return playableTrack;
}

/**
 * 处理分离视频音轨的请求。
 * @param {number} index - 目标视频在播放列表中的索引。
 */
async function handleSeparateVideoRequest(index) {
    const track = state.playlist[index];
    if (!track || track.type !== 'video') return;

    try {
        // 弹出确认对话框
        await showConfirmationModal(`确定要将 "${track.title}" 分离为独立的音视频文件吗？\n将在列表中添加一个仅视频版本和一个仅音频版本。`);
        showToast('正在处理，请稍候...', 'info');

        const result = await window.electronAPI.separateVideo(track);

        if (result.success) {
            // 重新处理整个播放列表，确保路径和拼音信息正确
            const updatedPlaylist = result.data.map(t => ({
                ...makeTrackPlayable(t),
                pinyin: pinyin(t.title || '', { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(t.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
            }));

            // 如果正在分离的是当前播放的曲目，先重置播放器
            if (state.currentTrackIndex === index) {
                resetPlayerUI();
            }

            state.setPlaylist(updatedPlaylist);
            const currentSrc = state.playlist[state.currentTrackIndex]?.src;
            const newIndex = updatedPlaylist.findIndex(t => t.src === currentSrc);
            state.setCurrentTrackIndex(newIndex > -1 ? newIndex : 0);

            renderPlaylist();
            updatePlaylistUI();
            backgroundGallery.updatePlaylistData(updatedPlaylist);

            showToast(result.message || '视频分离成功！', 'success');
        } else {
            // 如果失败是因为缺少工具，给出特定提示
            if (result.reason === 'tool_missing') {
                showToast('该功能需要 FFmpeg 组件，请先在“添加资源”页面尝试下载视频以触发安装。', 'error');
            } else {
                showToast(`分离失败: ${result.error}`, 'error');
            }
        }
    } catch (err) {
        // 用户取消操作
        console.log("分离操作已取消。");
    }
}

/**
 * 处理删除曲目的请求。
 * @param {number} index - 目标曲目在播放列表中的索引。
 */
async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);
        const wasPlaying = state.isPlaying;
        const isDeletingCurrent = state.currentTrackIndex === index;

        // 如果正在删除当前播放的曲目，先重置UI
        if (isDeletingCurrent) resetPlayerUI();

        const deleted = await requestTrackDeletion(track);
        if (!deleted) {
            // 如果删除失败，且删除的是当前曲目，则尝试恢复播放
            if (isDeletingCurrent) loadTrack(index, { forcePlay: wasPlaying });
            return;
        }

        const oldIndex = index;
        state.removeTrack(index); // 从状态中移除
        renderPlaylist(); // 重新渲染播放列表
        updatePlaylistUI(); // 更新高亮
        backgroundGallery.updatePlaylistData(state.playlist); // 更新背景画廊

        if (state.playlist.length === 0) {
            toggleEmptyState(true); // 如果列表空了，显示空状态
            showToast(`"${track.title}" 已删除`);
            return;
        }

        // 如果删除的是当前曲目，则决定下一个播放的曲目
        if (isDeletingCurrent) {
            let nextIndexToPlay = oldIndex;
            if (nextIndexToPlay >= state.playlist.length) nextIndexToPlay = 0; // 如果是最后一首，播第一首
            state.setCurrentTrackIndex(nextIndexToPlay);
            loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
        }
        showToast(`"${track.title}" 已删除`);
    } catch (err) {
        console.log("删除操作已取消或失败。", err);
    }
}

/**
 * 进入屏保/演示模式。
 */
function enterScreensaverMode() {
    if (state.isScreensaverMode || state.playlist.length === 0) return;
    state.setScreensaverMode(true);
    window.electronAPI.toggleFullscreen(true); // 进入全屏
    backgroundGallery.startAutoScroll(); // 开始背景自动滚动
    dom.playerContainer.classList.add('screensaver-active'); // 隐藏主播放器
    if (!state.isPlaying) {
        // 如果当前是暂停状态，则开始播放
        if (dom.mediaPlayer.src && dom.mediaPlayer.currentTime > 0) playTrack();
        else loadTrack(state.currentTrackIndex, { forcePlay: true });
    }
}

/**
 * 退出屏保/演示模式。
 */
function exitScreensaverMode() {
    if (!state.isScreensaverMode) return;
    state.setScreensaverMode(false);
    window.electronAPI.toggleFullscreen(false); // 退出全屏
    backgroundGallery.stopAutoScroll(); // 停止背景滚动
    dom.playerContainer.classList.remove('screensaver-active'); // 显示主播放器
}

/**
 * 设置核心组件（如 FFmpeg）下载进度模态框的事件监听。
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
        if (status) { // -1 进度，表示解压等不确定进度的状态
            barEl.style.width = '100%';
            percentEl.textContent = status;
        } else {
            barEl.style.width = `${progress}%`;
            percentEl.textContent = `${progress}%`;
        }
    });

    window.electronAPI.onDownloadFinished(({ success, error, tool }) => {
        if (success) {
            titleEl.textContent = '准备完成！';
            fileEl.textContent = `${tool || '组件'} 已就绪。`;
            setTimeout(() => modal.classList.remove('visible'), 1500);
        } else {
            titleEl.textContent = '下载失败！';
            fileEl.textContent = `错误: ${error || '未知错误'}`;
        }
    });
}

/**
 * 设置文件拖拽上传的事件监听。
 */
function setupDragAndDropListeners() {
    // 动态创建拖拽覆盖层（如果不存在）
    let dragOverlay = document.querySelector('.drag-overlay');
    if (!dragOverlay) {
        dragOverlay = document.createElement('div');
        dragOverlay.className = 'drag-overlay';
        dragOverlay.innerHTML = `
            <svg class="drag-overlay-icon" viewBox="0 0 24 24">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
            </svg>
            <div class="drag-overlay-text">拖拽文件到此处添加</div>
            <div class="drag-overlay-subtext">支持音频和视频文件</div>
        `;
        dom.playerContainer.appendChild(dragOverlay);
    }

    let dragCounter = 0; // 用于解决 dragenter 和 dragleave 在子元素间触发的问题

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
            dragOverlay.classList.add('active');
        }
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
            dragOverlay.classList.remove('active');
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy'; // 显示复制光标
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounter = 0;
        dragOverlay.classList.remove('active');

        const files = e.dataTransfer.files;

        if (files && files.length > 0) {
            showToast('正在处理拖拽的文件...', 'info');
            try {
                // 核心修复：将 FileList 转换为标准数组，以确保能通过 IPC 传递
                const fileArray = Array.from(files);
                const result = await window.electronAPI.handleFileDrop(fileArray);

                if (result.success) {
                    showToast(`成功添加 ${result.importedCount} 个文件！`, 'success');
                } else {
                    showToast(result.error || '添加文件失败', 'error');
                }
            } catch (error) {
                console.error('处理文件拖拽时发生错误:', error);
                showToast('处理文件时发生错误', 'error');
            }
        }
    });
}

/**
 * 设置所有核心UI元素的事件监听器。
 */
function setupEventListeners() {
    // --- 播放控制 ---
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });

    // --- 其他按钮 ---
    if (dom.openMediaFolderBtn) dom.openMediaFolderBtn.addEventListener('click', () => window.electronAPI.openMediaFolder());
    if (dom.emptyStateSearchBtn) dom.emptyStateSearchBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDownloadPanel(); setTimeout(() => { if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus(); }, 500); });
    if (dom.emptyStateImportBtn) dom.emptyStateImportBtn.addEventListener('click', (e) => { e.stopPropagation(); if (dom.importLocalBtn) dom.importLocalBtn.click(); });
    if (dom.fullscreenBtn) dom.fullscreenBtn.addEventListener('click', () => { if (!document.fullscreenElement) dom.mediaPlayer.requestFullscreen().catch(err => console.error(`进入全屏失败: ${err.message}`)); else document.exitFullscreen(); });

    // --- 双击进入沉浸模式 ---
    dom.mainView.addEventListener('dblclick', () => {
        if (document.fullscreenElement || state.isScreensaverMode) return;
        dom.mainView.classList.toggle('main-view-fullscreen');

        // 【核心修复】移除当前元素的焦点，以确保全局快捷键（如空格）在沉浸模式下依然有效。
        // 当 .main-view 获得焦点时，可能会阻止键盘事件冒泡到 window。
        if (document.activeElement) document.activeElement.blur();
    });
    document.addEventListener('fullscreenchange', () => { if (dom.fullscreenBtn) dom.fullscreenBtn.classList.toggle('fullscreen-active', !!document.fullscreenElement); });

    // --- 媒体元素事件 ---
    dom.mediaPlayer.addEventListener('loadedmetadata', () => { updateProgress(); const seekTime = consumePendingSeek(); if (seekTime > 0 && dom.mediaPlayer.duration > seekTime) dom.mediaPlayer.currentTime = seekTime; });
    dom.mediaPlayer.addEventListener('timeupdate', () => { if (dom.mediaPlayer.duration) updateProgress(); });
    dom.mediaPlayer.addEventListener('canplay', () => { hideSkeleton(); if (state.isPlaying) playTrack(); });
    dom.mediaPlayer.addEventListener('ended', () => { const currentMode = PLAY_MODES[state.currentModeIndex]; currentMode === 'single' ? (dom.mediaPlayer.currentTime = 0, playTrack()) : playNextTrack(); });
    dom.mediaPlayer.addEventListener('error', (e) => { if (!dom.mediaPlayer.getAttribute('src') && state.playlist.length === 0) return; console.error("媒体加载错误:", e); hideSkeleton(); const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex]; if (currentTrack) showToast(`播放失败: ${currentTrack.title}`, 'error'); });

    // --- 进度条控制 ---
    dom.progressBar.addEventListener('mousedown', () => state.setIsScrubbing(true));
    dom.progressBar.addEventListener('input', (e) => { dom.progressBar.style.setProperty('--value-percent', `${e.target.value}%`); if (!isNaN(dom.mediaPlayer.duration)) dom.currentTimeEl.textContent = formatTime((e.target.value / 100) * dom.mediaPlayer.duration); });
    dom.progressBar.addEventListener('change', (e) => { if (!isNaN(dom.mediaPlayer.duration)) dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration; state.setIsScrubbing(false); if (state.isPlaying) dom.mediaPlayer.play(); });

    // --- 音量控制 ---
    dom.volumeBtn.addEventListener('click', () => { dom.mediaPlayer.muted = !dom.mediaPlayer.muted; updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted); savePlayerState(); });
    dom.volumeBar.addEventListener('input', (e) => { const newVolume = parseFloat(e.target.value); dom.mediaPlayer.volume = newVolume; dom.mediaPlayer.muted = newVolume === 0; updateVolumeBarVisual(newVolume, dom.mediaPlayer.muted); savePlayerState(); });

    // --- 面板开关 ---
    [dom.lyricsBtn, dom.mobileLyricsBtn].forEach(btn => btn.addEventListener('click', toggleLyricsPanel));
    [dom.playlistBtn, dom.mobilePlaylistBtn].forEach(btn => btn.addEventListener('click', togglePlaylistPanel));
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);
    [dom.closePlaylistBtn, dom.closeInfoBtn, dom.closeShortcutBtn, dom.closeDownloadBtn].forEach(btn => btn.addEventListener('click', closeActivePanels));
    [...dom.allSidePanels, dom.lyricsContainer].forEach(panel => panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); }));
    dom.mainView.addEventListener('click', (e) => { if (!dom.mainView.classList.contains('main-view-fullscreen')) closeActivePanels(); });

    // --- 播放列表交互 ---
    dom.playlistEl.addEventListener('click', (e) => { const item = e.target.closest('.playlist-item'); if (item) { const newIndex = parseInt(item.dataset.index, 10); if (state.currentTrackIndex !== newIndex) { loadTrack(newIndex, { forcePlay: true }); savePlayerState(); } } });
    dom.playlistSearchInput.addEventListener('input', filterPlaylist);

    // --- 右键菜单 ---
    document.addEventListener('contextmenu', (e) => { if (state.playlist.length === 0) return; hideContextMenu(); const playlistItem = e.target.closest('#playlist .playlist-item'); const context = playlistItem ? { type: 'playlist-item', index: parseInt(playlistItem.dataset.index, 10) } : { type: 'global' }; if (context.type === 'playlist-item') e.preventDefault(); const { normalizedX, normalizedY } = normalizePosition(e.clientX, e.clientY); dom.contextMenu.style.top = `${normalizedY}px`; dom.contextMenu.style.left = `${normalizedX}px`; renderContextMenu(context); dom.contextMenu.style.display = 'block'; });
    document.addEventListener('click', (e) => { if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) hideContextMenu(); });
    dom.contextMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName !== 'LI' || !target.dataset.action) return;
        hideContextMenu();
        const action = target.dataset.action;
        const index = parseInt(target.dataset.index, 10);
        if (action === 'separate-video' && !isNaN(index)) {
            handleSeparateVideoRequest(index);
        } else if (action === 'delete-track' && !isNaN(index)) {
            handleDeleteTrackRequest(index);
        } else {
            executeShortcut(action);
        }
    });

    // --- 全局按键事件 ---
    window.addEventListener('keydown', (e) => {
        // F11 切换屏保模式
        if (e.key === 'F11') {
            e.preventDefault();
            state.isScreensaverMode ? exitScreensaverMode() : enterScreensaverMode();
            return;
        }
        // ESC 退出屏保模式或关闭右键菜单
        if (e.key === 'Escape') {
            hideContextMenu();
            if (state.isScreensaverMode) exitScreensaverMode();
        }
    });

    // --- 应用关闭前保存状态 ---
    window.addEventListener('beforeunload', savePlayerState);

    // --- IPC 事件监听 ---
    window.electronAPI.onNewTrack((newTrack) => { document.dispatchEvent(new CustomEvent('new-track-added', { detail: newTrack })); });
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

    window.electronAPI.onFullscreenChange((isFullscreen) => { if (!isFullscreen && state.isScreensaverMode) exitScreensaverMode(); });

    // --- 初始化功能模块 ---
    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    setupCoreComponentDownloader();
    setupDragAndDropListeners();
}

/**
 * 应用初始化函数。
 */
async function init() {
    showSkeleton();
    loadPlayerState();

    const localResult = await window.electronAPI.getLocalPlaylist();
    if (localResult.success && Array.isArray(localResult.data) && localResult.data.length > 0) {
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