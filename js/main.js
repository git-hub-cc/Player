// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, desktopTourSteps, mobileTourSteps } from './config.js';
import { loadTemplates, normalizeKey, formatTime } from './utils.js';
// 【修改】导入新的重置函数
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode, playTrack, resetBackgroundBeatTimer } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, setupParticleCanvas, closeActivePanels, toggleDownloadPanel, showToast } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
import { FeatureTour } from './features/tour.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners } from './features/downloader.js';

// --- 持久化 ---
const PLAYER_STATE_KEY = 'player_state';
let initialTime = 0;

// ... (savePlayerState 和 loadPlayerState 函数保持不变) ...

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

function setupEventListeners() {
    // Player controls
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => {
        playPrevTrack();
        savePlayerState();
    });
    dom.nextBtn.addEventListener('click', () => {
        playNextTrack();
        savePlayerState();
    });
    dom.modeBtn.addEventListener('click', () => {
        cyclePlayMode();
        savePlayerState();
    });

    // 浏览器历史事件
    window.addEventListener('popstate', (event) => {
        if (event.state && typeof event.state.trackIndex !== 'undefined') {
            if (state.currentTrackIndex !== event.state.trackIndex) {
                loadTrack(event.state.trackIndex, { fromHistory: true });
                savePlayerState();
            }
        }
    });

    // Media element events
    dom.mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        if (currentMode === 'single') {
            dom.mediaPlayer.currentTime = 0;
            playTrack();
        } else {
            playNextTrack();
            savePlayerState();
        }
    });
    dom.mediaPlayer.addEventListener('loadedmetadata', () => {
        updateProgress();
        if (initialTime > 0) {
            dom.mediaPlayer.currentTime = initialTime;
            initialTime = 0;
        }
    });

    // 进度条的事件监听逻辑
    dom.progressBar.addEventListener('mousedown', () => {
        state.setIsScrubbing(true);
    });

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

        // 【修改】在用户拖动进度条后重置背景节拍计时器
        resetBackgroundBeatTimer();

        state.setIsScrubbing(false);

        if (!state.isPlaying) {
            playTrack();
        }
    });

    // ... (其余的 setupEventListeners 函数内容保持不变) ...
    // Volume controls
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

    // Panel toggles
    dom.lyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.mobileLyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.playlistBtn.addEventListener('click', togglePlaylistPanel);
    dom.mobilePlaylistBtn.addEventListener('click', togglePlaylistPanel);
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);
    dom.downloadPanelBtn.addEventListener('click', toggleDownloadPanel);

    // 统一所有面板的关闭按钮逻辑
    dom.closePlaylistBtn.addEventListener('click', closeActivePanels);
    dom.closeInfoBtn.addEventListener('click', closeActivePanels);
    dom.closeShortcutBtn.addEventListener('click', closeActivePanels);
    dom.closeDownloadBtn.addEventListener('click', closeActivePanels);

    // 点击外部区域关闭面板
    [dom.infoPanel, dom.playlistPanel, dom.shortcutPanel, dom.lyricsContainer, dom.downloadPanel].forEach(panel => {
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); });
    });
    dom.mainView.addEventListener('click', closeActivePanels);

    // Playlist
    dom.playlistEl.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            loadTrack(newIndex, { forcePlay: true });
            savePlayerState();
        }
    });
    dom.playlistSearchInput.addEventListener('input', filterPlaylist);

    // Context Menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        hideContextMenu();
        const { clientX: mouseX, clientY: mouseY } = e;
        const { normalizedX, normalizedY } = normalizePosition(mouseX, mouseY);
        dom.contextMenu.style.top = `${normalizedY}px`;
        dom.contextMenu.style.left = `${normalizedX}px`;
        dom.contextMenu.style.display = 'block';
    });
    document.addEventListener('click', (e) => {
        if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });
    dom.contextMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName === 'LI' && target.dataset.action) {
            executeShortcut(target.dataset.action);
            hideContextMenu();
        }
    });

    // Global keyboard listener
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();
        if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return;
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
        if (state.isRecordingShortcut) return;
        state.pressedShortcutKeys.delete(normalizeKey(e.key));
    });

    // 【新增】监听并处理本地播放列表
    document.addEventListener('local-playlist-loaded', (event) => {
        const localPlaylist = event.detail;
        console.log('接收到本地播放列表:', localPlaylist);

        const existingSrcs = new Set(state.playlist.map(t => t.src));
        const uniqueLocalTracks = localPlaylist.filter(track => !existingSrcs.has(track.src));

        if (uniqueLocalTracks.length > 0) {
            state.setPlaylist([...uniqueLocalTracks, ...state.playlist]);
            // 更新当前播放索引，以保持当前曲目不变
            state.setCurrentTrackIndex(state.currentTrackIndex + uniqueLocalTracks.length);
            renderPlaylist();
            updatePlaylistUI();
            // 【修复】当本地播放列表加载后，同步更新画廊数据
            backgroundGallery.updatePlaylistData(state.playlist);
            showToast(`已加载 ${uniqueLocalTracks.length} 个本地作品！`);
        }
    });

    // 【修改】监听来自下载代理的新曲目事件
    document.addEventListener('new-track-added', (event) => {
        const newTrack = event.detail;
        console.log('接收到新曲目:', newTrack);

        const isDuplicate = state.playlist.some(track => track.src === newTrack.src);
        if (isDuplicate) {
            console.log(`曲目 ${newTrack.title} 已存在，跳过添加。`);
            showToast(`"${newTrack.title}" 已在播放列表中。`);
            return;
        }

        // 1. 将新曲目添加到播放列表的最前面
        state.setPlaylist([newTrack, ...state.playlist]);

        // 2. 更新当前播放索引，使其指向原来的曲目
        state.setCurrentTrackIndex(state.currentTrackIndex + 1);

        // 3. 完全重绘播放列表UI以反映新的顺序和索引
        renderPlaylist();
        updatePlaylistUI();
        // 【修复】当新曲目被添加后，同步更新画廊数据
        backgroundGallery.updatePlaylistData(state.playlist);

        // 4. 通知用户
        showToast(`已添加 "${newTrack.title}" 到播放列表！`);
    });

    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    window.addEventListener('beforeunload', savePlayerState);
}


async function init() {
    // ... (init 函数的其他部分保持不变) ...
    showSkeleton();
    await loadTemplates();
    loadPlayerState();
    setupParticleCanvas();

    try {
        const response = await fetch('playlist.json');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        let fetchedPlaylist = await response.json();
        const { pinyin } = window.pinyinPro;
        const processedPlaylist = fetchedPlaylist.map(track => {
            const title = track.title || '';
            return {
                ...track,
                pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
            };
        });
        state.setPlaylist(processedPlaylist);

        if (state.currentTrackIndex >= state.playlist.length || state.currentTrackIndex < 0) {
            console.warn(`Saved trackIndex ${state.currentTrackIndex} is out of bounds for the current playlist (length: ${state.playlist.length}). Resetting to 0.`);
            state.setCurrentTrackIndex(0);
        }

        backgroundGallery.init(processedPlaylist);
    } catch (error) {
        console.error("无法加载或处理播放列表:", error);
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法加载播放列表";
        hideSkeleton();
        return;
    }

    if (state.playlist.length > 0) {
        renderPlaylist();
        updatePlaylistUI();
        await loadTrack(state.currentTrackIndex);

        if (state.playlist.length > 0) {
            const initialTrack = state.playlist[state.currentTrackIndex];
            const initialUrl = `#track=${state.currentTrackIndex + 1}`;
            history.replaceState({ trackIndex: state.currentTrackIndex }, initialTrack.title || '', initialUrl);
        }
    } else {
        dom.trackTitleEl.textContent = "播放列表为空";
        hideSkeleton();
    }

    updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
    updateModeButton();
    updateProgress();
    loadShortcuts();
    renderContextMenu();
    setupEventListeners();

    if (!localStorage.getItem('player_tour_completed')) {
        setTimeout(() => {
            const isMobile = window.innerWidth <= 900;
            const tourStepsToRun = isMobile ? mobileTourSteps : desktopTourSteps;
            const playerTour = new FeatureTour(tourStepsToRun);
            playerTour.start();
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', init);