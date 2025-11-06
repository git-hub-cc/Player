// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, desktopTourSteps, mobileTourSteps } from './config.js';
import { normalizeKey, formatTime } from './utils.js';
import { pinyin } from 'pinyin-pro';
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode, resetBackgroundBeatTimer, resetPlayerUI } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, setupParticleCanvas, closeActivePanels, toggleDownloadPanel, showToast, showConfirmationModal } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
import { FeatureTour } from './features/tour.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners, requestTrackDeletion, resolvePlayableUrl } from './features/downloader.js';

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

/**
 * 处理从播放列表删除曲目的请求流程
 * @param {number} index - 要删除的曲目在播放列表中的索引
 */
async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        // 1. 向主进程发送删除请求
        const deleted = await requestTrackDeletion(track);
        if (!deleted) return; // 如果主进程删除失败，则中止

        const oldTrackIndex = state.currentTrackIndex;
        const isDeletingCurrent = oldTrackIndex === index;
        const wasPlaying = state.isPlaying;

        // 2. 更新前端状态
        state.removeTrack(index);

        // 3. 重新渲染UI
        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);

        // 4. 处理播放器状态
        if (isDeletingCurrent) {
            if (state.playlist.length === 0) {
                resetPlayerUI();
            } else {
                // 如果删除的是当前曲目，加载新的当前曲目（索引可能已改变）
                loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
            }
        }
        showToast(`"${track.title}" 已删除`);
    } catch (err) {
        // 用户点击了取消
        console.log("删除操作已由用户取消。");
    }
}


/**
 * 将主进程返回的、相对于 userData/media 的路径，转换为可播放的 `media://` 协议 URL
 * @param {object} track - 从主进程获取的曲目对象
 * @returns {object} - 包含可播放 URL 的新曲目对象
 */
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


function setupEventListeners() {
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.prevBtn.addEventListener('click', () => { playPrevTrack(); savePlayerState(); });
    dom.nextBtn.addEventListener('click', () => { playNextTrack(); savePlayerState(); });
    dom.modeBtn.addEventListener('click', () => { cyclePlayMode(); savePlayerState(); });

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
            executeShortcut(action);
        }
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

    document.addEventListener('new-track-added', (event) => {
        const newTrackFromMain = event.detail;
        const trackForPlaylist = makeTrackPlayable(newTrackFromMain);

        const oldPlaylistLength = state.playlist.length;
        state.setPlaylist([trackForPlaylist, ...state.playlist]);
        if (oldPlaylistLength > 0) {
            state.setCurrentTrackIndex(state.currentTrackIndex + 1);
        } else {
            state.setCurrentTrackIndex(0);
            loadTrack(0, { forcePlay: true });
        }

        showToast(`已添加 "${trackForPlaylist.title}" 到下载列表！`);

        renderPlaylist();
        updatePlaylistUI();
        backgroundGallery.updatePlaylistData(state.playlist);
    });

    setupDownloaderListeners();
    setupShortcutListeners();
    setupLyricsDragHandler();
    window.addEventListener('beforeunload', savePlayerState);
}


async function init() {
    showSkeleton();
    loadPlayerState();
    setupParticleCanvas();

    // 1. 加载本地 JSON 播放列表 (作为初始/默认内容)
    try {
        const response = await fetch('playlist.json');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const fetchedPlaylist = await response.json();

        // =========================================================================
        // 【核心修复】预加载默认播放列表中的相对路径歌词，并将其转换为 data URI。
        // 这样，player.js 中的歌词加载逻辑无需修改即可处理它们。
        // =========================================================================
        const playlistWithEmbeddedLyrics = await Promise.all(
            fetchedPlaylist.map(async track => {
                // 仅处理非 http、非 data URI 的歌词路径（即相对路径）
                if (track.lyrics && !track.lyrics.startsWith('http') && !track.lyrics.startsWith('data:')) {
                    try {
                        const lrcResponse = await fetch(track.lyrics);
                        if (lrcResponse.ok) {
                            const lrcText = await lrcResponse.text();
                            // 将获取到的歌词文本编码为 data URI，并替换原有路径
                            return { ...track, lyrics: `data:text/plain,${encodeURIComponent(lrcText)}` };
                        } else {
                            console.warn(`获取歌词失败: ${track.lyrics}, status: ${lrcResponse.status}`);
                            // 获取失败则清空歌词字段，避免后续加载出错
                            return { ...track, lyrics: '' };
                        }
                    } catch (e) {
                        console.error(`预加载歌词 '${track.lyrics}' 时出错:`, e);
                        return { ...track, lyrics: '' };
                    }
                }
                // 如果歌词路径已经是 data URI, http, 或者为空，则直接返回原轨道
                return track;
            })
        );

        // 【修改】使用已处理歌词的播放列表进行后续操作
        const processedPlaylist = playlistWithEmbeddedLyrics.map(track => ({
            ...track,
            pinyin: pinyin(track.title || '', { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(track.title || '', { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        }));

        // 此处设置的是应用的初始播放列表，它们的媒体文件路径是相对于 index.html 的，
        // 将由浏览器正常解析。歌词已被转换为 data URI。
        state.setPlaylist(processedPlaylist);

    } catch (error) {
        console.error("无法加载默认播放列表:", error);
    }

    // 2. 请求并合并用户数据目录中的播放列表
    const localResult = await window.electronAPI.getLocalPlaylist();
    if (localResult.success && localResult.data.length > 0) {
        // 这些是从 userData 目录加载的，需要转换为 media:// 协议
        const localPlaylist = localResult.data.map(makeTrackPlayable);
        const existingSrcs = new Set(state.playlist.map(t => t.src));
        const uniqueLocalTracks = localPlaylist.filter(track => !existingSrcs.has(track.src));
        if (uniqueLocalTracks.length > 0) {
            const previouslyPlayingSrc = state.playlist[state.currentTrackIndex]?.src;
            state.setPlaylist([...uniqueLocalTracks, ...state.playlist]);
            // 恢复之前播放的曲目索引
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
        renderPlaylist();
        updatePlaylistUI();
        await loadTrack(state.currentTrackIndex, { initialTime });
    } else {
        resetPlayerUI();
        hideSkeleton();
    }

    updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
    updateModeButton();
    loadShortcuts();
    renderContextMenu({ type: 'global' });
    setupEventListeners();

    if (!localStorage.getItem('player_tour_completed')) {
        setTimeout(() => {
            const isMobile = window.innerWidth <= 900;
            const playerTour = new FeatureTour(isMobile ? mobileTourSteps : desktopTourSteps);
            playerTour.start();
        }, 500);
    }
}

document.addEventListener('DOMContentLoaded', init);