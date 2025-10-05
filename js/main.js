// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, desktopTourSteps, mobileTourSteps } from './config.js';
import { loadTemplates, normalizeKey, formatTime } from './utils.js';
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode, playTrack, resetBackgroundBeatTimer } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, setupParticleCanvas, closeActivePanels, toggleDownloadPanel, showToast, togglePluginPanel } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
import { FeatureTour } from './features/tour.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners, uploadPlugin } from './features/downloader.js';

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

function setupEventListeners() {
    // ... 其他事件监听器 ...
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });
    window.addEventListener('popstate', (event) => {
        if (event.state && typeof event.state.trackIndex !== 'undefined') {
            if (state.currentTrackIndex !== event.state.trackIndex) {
                loadTrack(event.state.trackIndex, { fromHistory: true });
                savePlayerState();
            }
        }
    });
    dom.mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        if (currentMode === 'single') { dom.mediaPlayer.currentTime = 0; playTrack(); }
        else { playNextTrack(); savePlayerState(); }
    });
    dom.mediaPlayer.addEventListener('loadedmetadata', () => {
        updateProgress();
        if (initialTime > 0) { dom.mediaPlayer.currentTime = initialTime; initialTime = 0; }
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
        if (!isNaN(dom.mediaPlayer.duration)) { dom.mediaPlayer.currentTime = (e.target.value / 100) * dom.mediaPlayer.duration; }
        resetBackgroundBeatTimer();
        state.setIsScrubbing(false);
        if (!state.isPlaying) { playTrack(); }
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
    dom.pluginPanelBtn.addEventListener('click', togglePluginPanel); // [新增]
    dom.closePlaylistBtn.addEventListener('click', closeActivePanels);
    dom.closeInfoBtn.addEventListener('click', closeActivePanels);
    dom.closeShortcutBtn.addEventListener('click', closeActivePanels);
    dom.closeDownloadBtn.addEventListener('click', closeActivePanels);
    dom.closePluginBtn.addEventListener('click', closeActivePanels); // [新增]
    [dom.infoPanel, dom.playlistPanel, dom.shortcutPanel, dom.lyricsContainer, dom.downloadPanel, dom.pluginPanel].forEach(panel => {
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
        e.preventDefault(); hideContextMenu();
        const { clientX: mouseX, clientY: mouseY } = e;
        const { normalizedX, normalizedY } = normalizePosition(mouseX, mouseY);
        dom.contextMenu.style.top = `${normalizedY}px`; dom.contextMenu.style.left = `${normalizedX}px`;
        dom.contextMenu.style.display = 'block';
    });
    document.addEventListener('click', (e) => {
        if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(e.target)) { hideContextMenu(); }
    });
    dom.contextMenu.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName === 'LI' && target.dataset.action) { executeShortcut(target.dataset.action); hideContextMenu(); }
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();
        if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) return;
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

    // --- [核心修改] 接收并处理来自代理的数据 ---
    const AGENT_BASE_URL = 'http://localhost:9528';

    // 将代理返回的相对路径转换为可播放的完整URL
    function makeAgentTrackPlayable(track) {
        const playableTrack = { ...track };
        if (playableTrack.src && !playableTrack.src.startsWith('http')) {
            playableTrack.src = `${AGENT_BASE_URL}/${playableTrack.src}`;
        }
        if (playableTrack.albumArt && !playableTrack.albumArt.startsWith('http')) {
            playableTrack.albumArt = `${AGENT_BASE_URL}/${playableTrack.albumArt}`;
        }
        if (playableTrack.lyrics && !playableTrack.lyrics.startsWith('http') && !playableTrack.lyrics.startsWith('data:')) {
            playableTrack.lyrics = `${AGENT_BASE_URL}/${playableTrack.lyrics}`;
        }
        return playableTrack;
    }

    // 监听：当代理连接成功后，加载其保存的播放列表
    document.addEventListener('local-playlist-loaded', (event) => {
        const localPlaylist = event.detail.map(makeAgentTrackPlayable);
        console.log('接收到本地播放列表:', localPlaylist);

        const existingSrcs = new Set(state.playlist.map(t => t.src));
        const uniqueLocalTracks = localPlaylist.filter(track => !existingSrcs.has(track.src));

        if (uniqueLocalTracks.length > 0) {
            // [修正] 将新内容添加到播放列表最前面
            state.setPlaylist([...uniqueLocalTracks, ...state.playlist]);
            // 更新当前播放索引，以确保当前歌曲不会改变
            state.setCurrentTrackIndex(state.currentTrackIndex + uniqueLocalTracks.length);
            renderPlaylist();
            updatePlaylistUI();
            backgroundGallery.updatePlaylistData(state.playlist);
            showToast(`已加载 ${uniqueLocalTracks.length} 个本地作品！`);
        }
    });

    // 监听：当有新内容下载完成时
    document.addEventListener('new-track-added', (event) => {
        const newTrackFromAgent = event.detail;
        const trackForPlaylist = makeAgentTrackPlayable(newTrackFromAgent);

        const existingTrackIndex = state.playlist.findIndex(track => track.src === trackForPlaylist.src);

        if (existingTrackIndex !== -1) {
            // 如果已存在（不太可能，但作为保险），则更新信息
            Object.assign(state.playlist[existingTrackIndex], trackForPlaylist);
            console.log(`曲目 "${trackForPlaylist.title}" 已存在，更新其信息。`);
        } else {
            // [修正] 将新内容添加到播放列表最前面
            state.setPlaylist([trackForPlaylist, ...state.playlist]);
            // 更新当前播放索引以保持当前歌曲不变
            // 如果当前没有播放或播放的是第一首，索引变为1，否则加1
            state.setCurrentTrackIndex(state.currentTrackIndex + 1);
            showToast(`已添加 "${trackForPlaylist.title}" 到播放列表！`);
        }

        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);
    });


    document.addEventListener('play-search-result', (event) => {
        const trackToPlay = event.detail;
        // 搜索结果总是需要通过代理播放，所以直接转换
        const playableTrack = makeAgentTrackPlayable(trackToPlay);

        let trackIndex = state.playlist.findIndex(track => track.src === playableTrack.src);

        if (trackIndex === -1) {
            // [修正] 将新内容添加到播放列表最前面
            state.setPlaylist([playableTrack, ...state.playlist]);
            trackIndex = 0; // 新添加的项总是在索引0
            // 其他项的索引自动向后移动，所以当前播放索引需要+1
            state.setCurrentTrackIndex(state.currentTrackIndex + 1);
        }

        loadTrack(trackIndex, { forcePlay: true });
        // 因为播放的是新列表的第0项，所以更新当前索引
        state.setCurrentTrackIndex(trackIndex);
        renderPlaylist();
        updatePlaylistUI();
    });

    // [新增] 插件管理相关事件
    dom.addPluginBtn.addEventListener('click', () => dom.pluginFileInput.click());
    dom.pluginFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            uploadPlugin(file);
            // 重置 input 以便可以再次选择相同的文件
            event.target.value = '';
        }
    });


    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    window.addEventListener('beforeunload', savePlayerState);
}


async function init() {
    // ... init 函数保持不变 ...
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
            const newUrl = `#track=${state.currentTrackIndex + 1}`;
            history.replaceState({ trackIndex: state.currentTrackIndex }, initialTrack.title || '', newUrl);
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