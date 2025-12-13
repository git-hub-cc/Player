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

const PLAYER_STATE_KEY = 'player_state';
let initialTime = 0;

function savePlayerState() {
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

function makeTrackPlayable(track) {
    const playableTrack = { ...track };
    const encodeMediaUrl = (relativePath) => {
        if (!relativePath) return '';
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

async function handleSeparateVideoRequest(index) {
    const track = state.playlist[index];
    if (!track || track.type !== 'video') return;

    try {
        await showConfirmationModal(`确定要将 "${track.title}" 分离为独立的音视频文件吗？\n将在列表中添加一个仅视频版本和一个仅音频版本。`);
        showToast('正在处理，请稍候...', 'info');

        const result = await window.electronAPI.separateVideo(track);

        if (result.success) {
            const updatedPlaylist = result.data.map(t => ({
                ...makeTrackPlayable(t),
                pinyin: pinyin(t.title || '', { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(t.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
            }));

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
            if (result.reason === 'tool_missing') {
                showToast('该功能需要 FFmpeg 组件，请先在“添加资源”页面尝试下载视频以触发安装。', 'error');
            } else {
                showToast(`分离失败: ${result.error}`, 'error');
            }
        }
    } catch (err) {
        console.log("分离操作已取消。");
    }
}

async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);
        const wasPlaying = state.isPlaying;
        const isDeletingCurrent = state.currentTrackIndex === index;

        if (isDeletingCurrent) resetPlayerUI();

        const deleted = await requestTrackDeletion(track);
        if (!deleted) {
            if (isDeletingCurrent) loadTrack(index, { forcePlay: wasPlaying });
            return;
        }

        const oldIndex = index;
        state.removeTrack(index);
        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);

        if (state.playlist.length === 0) {
            toggleEmptyState(true);
            showToast(`"${track.title}" 已删除`);
            return;
        }

        if (isDeletingCurrent) {
            let nextIndexToPlay = oldIndex;
            if (nextIndexToPlay >= state.playlist.length) nextIndexToPlay = 0;
            state.setCurrentTrackIndex(nextIndexToPlay);
            loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
        }
        showToast(`"${track.title}" 已删除`);
    } catch (err) {
        console.log("删除操作已取消或失败。", err);
    }
}

function enterScreensaverMode() {
    if (state.isScreensaverMode || state.playlist.length === 0) return;
    state.setScreensaverMode(true);
    window.electronAPI.toggleFullscreen(true);
    backgroundGallery.startAutoScroll();
    dom.playerContainer.classList.add('screensaver-active');
    if (!state.isPlaying) {
        if (dom.mediaPlayer.src && dom.mediaPlayer.currentTime > 0) playTrack();
        else loadTrack(state.currentTrackIndex, { forcePlay: true });
    }
}

function exitScreensaverMode() {
    if (!state.isScreensaverMode) return;
    state.setScreensaverMode(false);
    window.electronAPI.toggleFullscreen(false);
    backgroundGallery.stopAutoScroll();
    dom.playerContainer.classList.remove('screensaver-active');
}

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
        if (status) {
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

function setupDragAndDropListeners() {
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

    let dragCounter = 0;

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
        e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        dragCounter = 0;
        dragOverlay.classList.remove('active');

        const files = e.dataTransfer.files;

        // --- 拖拽事件日志 ---
        console.group('🔍 [Renderer] Drag & Drop Log');
        console.log('1. Drop event triggered');
        console.log('2. Files count:', files ? files.length : 0);

        if (files && files.length > 0) {
            showToast('正在处理拖拽的文件...', 'info');

            try {
                // =========================================================================
                // 【核心修复】将 FileList 转换为标准数组 (Array)
                // 解决 FileList 在跨进程传输时丢失内容导致 Preload 接收到空数组的问题
                // =========================================================================
                const fileArray = Array.from(files);
                console.log('3. Converted to Array:', fileArray);
                console.log('4. Calling window.electronAPI.handleFileDrop...');

                const result = await window.electronAPI.handleFileDrop(fileArray);
                console.log('5. Received result from Main:', result);

                if (result.success) {
                    showToast(`成功添加 ${result.importedCount} 个文件！`, 'success');
                } else {
                    console.error('❌ Error from Main:', result.error);
                    showToast(result.error || '添加文件失败', 'error');
                }
            } catch (error) {
                console.error('❌ Exception in Renderer:', error);
                showToast('处理文件时发生错误', 'error');
            }
        } else {
            console.warn('⚠️ No files detected in e.dataTransfer.files');
        }
        console.groupEnd();
    });
}

function setupEventListeners() {
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });

    if (dom.openMediaFolderBtn) dom.openMediaFolderBtn.addEventListener('click', () => window.electronAPI.openMediaFolder());
    if (dom.emptyStateSearchBtn) dom.emptyStateSearchBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleDownloadPanel(); setTimeout(() => { if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus(); }, 500); });
    if (dom.emptyStateImportBtn) dom.emptyStateImportBtn.addEventListener('click', (e) => { e.stopPropagation(); if (dom.importLocalBtn) dom.importLocalBtn.click(); });
    if (dom.fullscreenBtn) dom.fullscreenBtn.addEventListener('click', () => { if (!document.fullscreenElement) dom.mediaPlayer.requestFullscreen().catch(err => console.error(`进入全屏失败: ${err.message}`)); else document.exitFullscreen(); });

    dom.mainView.addEventListener('dblclick', () => {
        if (document.fullscreenElement || state.isScreensaverMode) return;
        dom.mainView.classList.toggle('main-view-fullscreen');
    });

    document.addEventListener('fullscreenchange', () => { if (dom.fullscreenBtn) dom.fullscreenBtn.classList.toggle('fullscreen-active', !!document.fullscreenElement); });

    dom.mediaPlayer.addEventListener('loadedmetadata', () => { updateProgress(); const seekTime = consumePendingSeek(); if (seekTime > 0 && dom.mediaPlayer.duration > seekTime) dom.mediaPlayer.currentTime = seekTime; });
    dom.mediaPlayer.addEventListener('timeupdate', () => { if (dom.mediaPlayer.duration) updateProgress(); });
    dom.mediaPlayer.addEventListener('canplay', () => { hideSkeleton(); if (state.isPlaying) playTrack(); });
    dom.mediaPlayer.addEventListener('ended', () => { const currentMode = PLAY_MODES[state.currentModeIndex]; currentMode === 'single' ? (dom.mediaPlayer.currentTime = 0, playTrack()) : playNextTrack(); });
    dom.mediaPlayer.addEventListener('error', (e) => { if (!dom.mediaPlayer.getAttribute('src') && state.playlist.length === 0) return; console.error("媒体加载错误:", e); hideSkeleton(); const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex]; if (currentTrack) showToast(`播放失败: ${currentTrack.title}`, 'error'); });

    dom.progressBar.addEventListener('mousedown', () => state.setIsScrubbing(true));
    dom.progressBar.addEventListener('input', (e) => { dom.progressBar.style.setProperty('--value-percent', `${e.target.value}%`); if (!isNaN(dom.mediaPlayer.duration)) dom.currentTimeEl.textContent = formatTime((e.target.value / 100) * dom.mediaPlayer.duration); });
    dom.progressBar.addEventListener('change', (e) => { if (!isNaN(dom.mediaPlayer.duration)) dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration; state.setIsScrubbing(false); if (state.isPlaying) dom.mediaPlayer.play(); });

    dom.volumeBtn.addEventListener('click', () => { dom.mediaPlayer.muted = !dom.mediaPlayer.muted; updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted); savePlayerState(); });
    dom.volumeBar.addEventListener('input', (e) => { const newVolume = parseFloat(e.target.value); dom.mediaPlayer.volume = newVolume; dom.mediaPlayer.muted = newVolume === 0; updateVolumeBarVisual(newVolume, dom.mediaPlayer.muted); savePlayerState(); });

    [dom.lyricsBtn, dom.mobileLyricsBtn].forEach(btn => btn.addEventListener('click', toggleLyricsPanel));
    [dom.playlistBtn, dom.mobilePlaylistBtn].forEach(btn => btn.addEventListener('click', togglePlaylistPanel));
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);
    [dom.closePlaylistBtn, dom.closeInfoBtn, dom.closeShortcutBtn, dom.closeDownloadBtn].forEach(btn => btn.addEventListener('click', closeActivePanels));
    [...dom.allSidePanels, dom.lyricsContainer].forEach(panel => panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); }));
    dom.mainView.addEventListener('click', (e) => { if (!dom.mainView.classList.contains('main-view-fullscreen')) closeActivePanels(); });

    dom.playlistEl.addEventListener('click', (e) => { const item = e.target.closest('.playlist-item'); if (item) { const newIndex = parseInt(item.dataset.index, 10); if (state.currentTrackIndex !== newIndex) { loadTrack(newIndex, { forcePlay: true }); savePlayerState(); } } });
    dom.playlistSearchInput.addEventListener('input', filterPlaylist);

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

    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideContextMenu(); if (state.isScreensaverMode) exitScreensaverMode(); } if (e.key === 'F11') { e.preventDefault(); state.isScreensaverMode ? exitScreensaverMode() : enterScreensaverMode(); return; } if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return; if (state.playlist.length === 0) return; state.pressedShortcutKeys.add(normalizeKey(e.key)); for (const actionId in state.shortcutSettings) { const requiredKeys = new Set(state.shortcutSettings[actionId].keys); if (requiredKeys.size > 0 && requiredKeys.size === state.pressedShortcutKeys.size && [...requiredKeys].every(key => state.pressedShortcutKeys.has(key))) { e.preventDefault(); executeShortcut(actionId); break; } } });
    window.addEventListener('keyup', (e) => { if (!state.isRecordingShortcut) state.pressedShortcutKeys.delete(normalizeKey(e.key)); });

    window.addEventListener('beforeunload', savePlayerState);

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

    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    setupCoreComponentDownloader();
    setupDragAndDropListeners();
}

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