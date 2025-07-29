// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, desktopTourSteps, mobileTourSteps } from './config.js';
import { loadTemplates, normalizeKey } from './utils.js';
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, setupParticleCanvas } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
import { FeatureTour } from './features/tour.js';
import * as backgroundGallery from './features/gallery.js';

// --- 持久化 ---
const PLAYER_STATE_KEY = 'player_state';
let initialTime = 0; // 用于恢复上次播放时间

// 保存播放器状态到 localStorage
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

// 从 localStorage 加载播放器状态
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

    // 监听浏览器的前进/后退事件
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
            dom.mediaPlayer.play();
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

    // Progress and Volume bars
    dom.progressBar.addEventListener('input', (e) => {
        const value = e.target.value;
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.mediaPlayer.currentTime = (value / 100) * dom.mediaPlayer.duration;
        }
        dom.progressBar.style.setProperty('--value-percent', `${value}%`);
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

    // Panel toggles
    dom.lyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.mobileLyricsBtn.addEventListener('click', toggleLyricsPanel);
    dom.playlistBtn.addEventListener('click', togglePlaylistPanel);
    dom.mobilePlaylistBtn.addEventListener('click', togglePlaylistPanel);
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.shortcutBtn.addEventListener('click', toggleShortcutPanel);

    // Panel closing
    [dom.closeInfoBtn, dom.closePlaylistBtn, dom.closeShortcutBtn].forEach(btn => {
        if (btn) {
            btn.addEventListener('click', () => btn.closest('aside').classList.remove('active'));
        }
    });
    [dom.infoPanel, dom.playlistPanel, dom.shortcutPanel, dom.lyricsContainer].forEach(panel => {
        panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('active'); });
    });

    // Playlist
    dom.playlistEl.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            loadTrack(newIndex);
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

    // Global keyboard listener for shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideContextMenu();
        }
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

    setupShortcutListeners();
    // 【新增】初始化歌词拖拽监听
    setupLyricsDragHandler();

    window.addEventListener('beforeunload', savePlayerState);
}

async function init() {
    showSkeleton();
    await loadTemplates();
    loadPlayerState();

    // 【新增】初始化粒子效果的Canvas
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