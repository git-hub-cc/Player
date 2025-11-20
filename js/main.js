// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js'; // [修改] 移除了 desktopTourSteps, mobileTourSteps 引用
import { normalizeKey, formatTime } from './utils.js';
import { pinyin } from 'pinyin-pro';
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode, resetBackgroundBeatTimer, resetPlayerUI, consumePendingSeek, playTrack, toggleInstrumentalMode } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, closeActivePanels, toggleDownloadPanel, showToast, showConfirmationModal, toggleEmptyState } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
// [修改] 移除了 FeatureTour 引用
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners, requestTrackDeletion } from './features/downloader.js';

// --- 持久化 ---
const PLAYER_STATE_KEY = 'player_state';
let initialTime = 0;

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

async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;
    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);
        const deleted = await requestTrackDeletion(track);
        if (!deleted) return;
        const oldTrackIndex = state.currentTrackIndex;
        const isDeletingCurrent = oldTrackIndex === index;
        const wasPlaying = state.isPlaying;
        state.removeTrack(index);
        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);
        if (isDeletingCurrent) {
            if (state.playlist.length === 0) {
                resetPlayerUI();
                toggleEmptyState(true);
            } else {
                loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
            }
        } else if (state.playlist.length === 0) {
            toggleEmptyState(true);
        }
        showToast(`"${track.title}" 已删除`);
    } catch (err) {
        console.log("删除操作已由用户取消。", err);
    }
}

function makeTrackPlayable(track) {
    const playableTrack = { ...track };
    if (playableTrack.src && !playableTrack.src.startsWith('http')) {
        playableTrack.src = `media://${playableTrack.src}`;
    }
    if (playableTrack.albumArt && !playableTrack.albumArt.startsWith('http')) {
        playableTrack.albumArt = `media://${playableTrack.albumArt}`;
    }
    if (playableTrack.lyrics && !playableTrack.lyrics.startsWith('http') && !playableTrack.lyrics.startsWith('data:')) {
        playableTrack.lyrics = `media://${playableTrack.lyrics}`;
    }
    return playableTrack;
}

function enterScreensaverMode() {
    if (state.isScreensaverMode) return;
    if (state.playlist.length === 0) return;

    console.log('Entering screensaver mode...');
    state.setScreensaverMode(true);
    window.electronAPI.toggleFullscreen(true);
    backgroundGallery.startAutoScroll();
    dom.playerContainer.classList.add('screensaver-active');

    if (!state.isPlaying) {
        if (state.playlist.length > 0) {
            if (dom.mediaPlayer.src && dom.mediaPlayer.currentTime > 0) {
                playTrack();
            } else {
                loadTrack(state.currentTrackIndex, { forcePlay: true });
            }
        }
    }
}

function exitScreensaverMode() {
    if (!state.isScreensaverMode) return;
    console.log('Exiting screensaver mode...');
    state.setScreensaverMode(false);
    window.electronAPI.toggleFullscreen(false);
    backgroundGallery.stopAutoScroll();
    dom.playerContainer.classList.remove('screensaver-active');
}

function setupEventListeners() {
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });
    dom.instrumentalBtn.addEventListener('click', toggleInstrumentalMode);

    if (dom.openMediaFolderBtn && window.electronAPI?.openMediaFolder) {
        dom.openMediaFolderBtn.addEventListener('click', () => {
            window.electronAPI.openMediaFolder();
        });
    }

    // =========================================================================
    // 【修复】阻止事件冒泡，防止触发 mainView 的 click 事件（该事件会关闭所有面板）
    // =========================================================================
    if (dom.emptyStateSearchBtn) {
        dom.emptyStateSearchBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // <--- 关键修复：阻止冒泡
            toggleDownloadPanel();
            setTimeout(() => {
                if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus();
            }, 500);
        });
    }

    if (dom.emptyStateImportBtn) {
        dom.emptyStateImportBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // <--- 关键修复：阻止冒泡
            if (dom.importLocalBtn) dom.importLocalBtn.click();
        });
    }
    // =========================================================================

    dom.mediaPlayer.addEventListener('loadedmetadata', () => {
        updateProgress();
        const seekTime = consumePendingSeek();
        if (seekTime > 0 && dom.mediaPlayer.duration > seekTime) {
            dom.mediaPlayer.currentTime = seekTime;
        }
    });

    dom.mediaPlayer.addEventListener('canplay', () => {
        hideSkeleton();
        if (state.isPlaying) {
            playTrack();
        }
    });

    dom.mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        if (currentMode === 'single') {
            dom.mediaPlayer.currentTime = 0;
            playTrack();
        } else {
            playNextTrack();
        }
    });

    dom.mediaPlayer.addEventListener('error', (e) => {
        // =========================================================================
        // 【修复】更严格的空状态检查，防止空 src 报错干扰
        // =========================================================================
        const src = dom.mediaPlayer.getAttribute('src');
        if ((!src || src === '' || src === 'null') && state.playlist.length === 0) {
            return; // 忽略空状态下的加载错误
        }
        // =========================================================================

        console.error("媒体加载错误:", e);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放此媒体";
        dom.mainView.style.background = '';
        const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex];
        if (currentTrack) {
            showToast(`播放失败: ${currentTrack.title}`, 'error');
        }
    });

    dom.progressBar.addEventListener('mousedown', () => state.setIsScrubbing(true));
    dom.progressBar.addEventListener('input', (e) => {
        const value = e.target.value;
        dom.progressBar.style.setProperty('--value-percent', `${value}%`);
        if (!isNaN(dom.mediaPlayer.duration)) {
            const newTime = (value / 100) * dom.mediaPlayer.duration;
            dom.currentTimeEl.textContent = formatTime(newTime);
        }
    });
    dom.progressBar.addEventListener('change', (e) => {
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration;
        }
        resetBackgroundBeatTimer();
        state.setIsScrubbing(false);
        if (state.isPlaying) {
            dom.mediaPlayer.play();
        }
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

    dom.lyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.mobileLyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.playlistBtn.addEventListener('click', togglePlaylistPanel);
    dom.mobilePlaylistBtn.addEventListener('click', togglePlaylistPanel);
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);
    dom.closePlaylistBtn.addEventListener('click', closeActivePanels);
    dom.closeInfoBtn.addEventListener('click', closeActivePanels);
    dom.closeShortcutBtn.addEventListener('click', closeActivePanels);
    dom.closeDownloadBtn.addEventListener('click', closeActivePanels);
    [dom.infoPanel, dom.playlistPanel, dom.shortcutPanel, dom.lyricsContainer, dom.downloadPanel].forEach(panel => {
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); });
    });
    dom.mainView.addEventListener('click', closeActivePanels);

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

    document.addEventListener('contextmenu', (e) => {
        if (state.playlist.length === 0) return;

        hideContextMenu();
        const playlistItem = e.target.closest('#playlist .playlist-item');
        let context = {};
        if (playlistItem) {
            e.preventDefault();
            context = { type: 'playlist-item', index: parseInt(playlistItem.dataset.index, 10) };
        } else {
            context = { type: 'global' };
        }
        const { clientX: mouseX, clientY: mouseY } = e;
        const { normalizedX, normalizedY } = normalizePosition(mouseX, mouseY);
        dom.contextMenu.style.top = `${normalizedY}px`;
        dom.contextMenu.style.left = `${normalizedX}px`;
        renderContextMenu(context);
        dom.contextMenu.style.display = 'block';
    });

    document.addEventListener('click', (e) => {
        if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    dom.contextMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName !== 'LI' || !target.dataset.action) return;
        const action = target.dataset.action;
        hideContextMenu();
        if (action === 'delete-track') {
            const index = parseInt(target.dataset.index, 10);
            if (!isNaN(index)) handleDeleteTrackRequest(index);
        } else {
            executeShortcut(actionId);
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();

        if (e.key === 'F11') {
            e.preventDefault();
            if (state.isScreensaverMode) {
                exitScreensaverMode();
            } else {
                enterScreensaverMode();
            }
            return;
        }

        if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return;

        if (state.playlist.length === 0) return;

        state.pressedShortcutKeys.add(normalizeKey(e.key));
        for (const actionId in state.shortcutSettings) {
            const requiredKeys = new Set(state.shortcutSettings[actionId].keys);
            if (requiredKeys.size > 0 && requiredKeys.size === state.pressedShortcutKeys.size && [...requiredKeys].every(key => state.pressedShortcutKeys.has(key))) { e.preventDefault(); executeShortcut(actionId); break; }
        }
    });

    window.addEventListener('keyup', (e) => {
        if (state.isRecordingShortcut) return;
        state.pressedShortcutKeys.delete(normalizeKey(e.key));
    });

    document.addEventListener('new-track-added', (event) => {
        const newTrackFromMain = event.detail;
        const trackForPlaylist = makeTrackPlayable(newTrackFromMain);

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

    if (window.electronAPI && window.electronAPI.onFullscreenChange) {
        window.electronAPI.onFullscreenChange((isFullscreen) => {
            console.log(`Received fullscreen change from main: ${isFullscreen}`);
            if (!isFullscreen && state.isScreensaverMode) {
                exitScreensaverMode();
            }
        });
    }

    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    window.addEventListener('beforeunload', savePlayerState);
}

async function init() {
    showSkeleton();
    loadPlayerState();
    try {
        const response = await fetch('playlist.json');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const fetchedPlaylist = await response.json();
        const playlistWithEmbeddedLyrics = await Promise.all(
            fetchedPlaylist.map(async track => {
                if (track.lyrics && !track.lyrics.startsWith('http') && !track.lyrics.startsWith('data:')) {
                    try {
                        const lrcResponse = await fetch(track.lyrics);
                        if (lrcResponse.ok) {
                            const lrcText = await lrcResponse.text();
                            return { ...track, lyrics: `data:text/plain,${encodeURIComponent(lrcText)}` };
                        } else {
                            console.warn(`获取歌词失败: ${track.lyrics}, status: ${lrcResponse.status}`);
                            return { ...track, lyrics: '' };
                        }
                    } catch (e) {
                        console.error(`预加载歌词 '${track.lyrics}' 时出错:`, e);
                        return { ...track, lyrics: '' };
                    }
                }
                return track;
            })
        );
        const processedPlaylist = playlistWithEmbeddedLyrics.map(track => ({
            ...track,
            pinyin: pinyin(track.title || '', { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(track.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        }));
        state.setPlaylist(processedPlaylist);
    } catch (error) {
        console.error("无法加载默认播放列表:", error);
    }

    const localResult = await window.electronAPI.getLocalPlaylist();
    if (localResult.success && localResult.data.length > 0) {
        const localPlaylist = localResult.data.map(makeTrackPlayable);
        const existingSrcs = new Set(state.playlist.map(t => t.src));
        const uniqueLocalTracks = localPlaylist.filter(track => !existingSrcs.has(track.src));
        if (uniqueLocalTracks.length > 0) {
            const previouslyPlayingSrc = state.playlist[state.currentTrackIndex]?.src;
            state.setPlaylist([...uniqueLocalTracks, ...state.playlist]);
            if (previouslyPlayingSrc) {
                const newIndex = state.playlist.findIndex(t => t.src === previouslyPlayingSrc);
                if (newIndex !== -1) {
                    state.setCurrentTrackIndex(newIndex);
                }
            }
        }
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
        setTimeout(() => {
            toggleDownloadPanel();
        }, 600);
    }

    updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
    updateModeButton();
    loadShortcuts();
    renderContextMenu({ type: 'global' });
    setupEventListeners();

    // [修改] 移除了引导页自动启动的代码
}

document.addEventListener('DOMContentLoaded', init);