// js/main.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { normalizeKey, formatTime } from './utils.js';
import { pinyin } from 'pinyin-pro';
import { loadTrack, togglePlayPause, playNextTrack, playPrevTrack, updateProgress, cyclePlayMode, resetBackgroundBeatTimer, resetPlayerUI, consumePendingSeek, playTrack } from './player.js';
import { renderPlaylist, filterPlaylist, toggleLyricsPanel, togglePlaylistPanel, toggleInfoPanel, toggleShortcutPanel, updateVolumeBarVisual, showSkeleton, hideSkeleton, hideContextMenu, renderContextMenu, normalizePosition, updateModeButton, updatePlaylistUI, setupLyricsDragHandler, closeActivePanels, toggleDownloadPanel, showToast, showConfirmationModal, toggleEmptyState } from './ui.js';
import { loadShortcuts, executeShortcut, setupShortcutListeners } from './features/shortcuts.js';
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


/**
 * =========================================================================
 * 【核心修复】重构删除逻辑以允许删除正在播放的文件
 *
 * 此函数经过重构，以稳健地处理删除曲目的所有情况，特别是删除当前正在播放的曲目。
 * 1.  先重置播放器UI (`resetPlayerUI`) 来释放文件句柄，这是成功删除文件的关键。
 * 2.  请求主进程删除文件。
 * 3.  如果删除成功，则从前端的状态和UI中移除该曲目。
 * 4.  **关键逻辑**：明确地计算下一个要播放的曲目索引，确保它始终有效，
 *     即使删除了列表中的最后一项也能正确回绕到第一项。
 * 5.  最后使用这个计算好的、保证有效的索引来加载下一首曲目，从而修复了之前的 `TypeError`。
 * =========================================================================
 * @param {number} index - 要删除的曲目在播放列表中的索引。
 */
async function handleDeleteTrackRequest(index) {
    const track = state.playlist[index];
    if (!track) return;

    try {
        // 步骤 1: 弹出确认对话框，等待用户确认
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        const wasPlaying = state.isPlaying;
        const isDeletingCurrent = state.currentTrackIndex === index;

        // 步骤 2: 如果删除的是当前曲目，先停止播放并清空播放器，以释放文件句柄
        if (isDeletingCurrent) {
            resetPlayerUI();
        }

        // 步骤 3: 请求主进程执行文件删除操作
        const deleted = await requestTrackDeletion(track);

        // 如果后端删除失败 (例如权限问题)，则中止操作
        if (!deleted) {
            // 如果之前停止了播放，则尝试恢复播放状态
            if (isDeletingCurrent) {
                loadTrack(index, { forcePlay: wasPlaying });
            }
            return; // 中断后续流程
        }

        // 步骤 4: 后端删除成功，更新前端状态和UI
        const oldIndex = index; // 保存旧索引用于后续计算
        state.removeTrack(index); // 从播放列表状态数组中移除曲目

        renderPlaylist(); // 重新渲染播放列表
        updatePlaylistUI(); // 更新UI高亮等
        backgroundGallery.updatePlaylistData(state.playlist); // 更新背景画廊数据

        // 步骤 5: 决定删除后的下一步操作
        if (state.playlist.length === 0) {
            // 如果列表已空，显示空状态界面
            toggleEmptyState(true);
        } else if (isDeletingCurrent) {
            // 如果删除的是当前曲目且列表不为空
            // 确定下一个要播放的曲目索引。通常是当前位置的下一首。
            // 如果删除了最后一首歌，则回绕到第一首。
            let nextIndexToPlay = oldIndex;
            if (nextIndexToPlay >= state.playlist.length) {
                nextIndexToPlay = 0; // 或 state.playlist.length - 1
            }
            state.setCurrentTrackIndex(nextIndexToPlay);

            // 加载新的当前曲目，并根据之前的状态决定是否自动播放
            loadTrack(state.currentTrackIndex, { forcePlay: wasPlaying });
        }

        showToast(`"${track.title}" 已删除`);

    } catch (err) {
        // 用户在确认对话框中点击了“取消”或发生其他错误
        console.log("删除操作已取消或失败。", err);
    }
}


/**
 * [修正] 增强 makeTrackPlayable 函数，以正确编码包含特殊字符的文件路径
 * @param {object} track - 原始曲目对象
 * @returns {object} - 处理后可供播放的曲目对象
 */
function makeTrackPlayable(track) {
    const playableTrack = { ...track };

    // 辅助函数，用于安全地编码 media:// 协议的路径。
    // 这能确保文件名中的特殊字符 (如 #, ?, …) 不会破坏 URL 结构。
    // 它将路径按 '/' 分割，对每个部分（目录或文件名）进行编码，然后再用 '/' 连接起来。
    const encodeMediaUrl = (relativePath) => {
        if (!relativePath) return '';
        const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        return `media://${encodedPath}`;
    };

    if (playableTrack.src && !playableTrack.src.startsWith('http')) {
        playableTrack.src = encodeMediaUrl(playableTrack.src);
    }
    if (playableTrack.albumArt && !playableTrack.albumArt.startsWith('http')) {
        playableTrack.albumArt = encodeMediaUrl(playableTrack.albumArt);
    }
    if (playableTrack.lyrics && !playableTrack.lyrics.startsWith('http') && !playableTrack.lyrics.startsWith('data:')) {
        playableTrack.lyrics = encodeMediaUrl(playableTrack.lyrics);
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

    if (dom.openMediaFolderBtn && window.electronAPI?.openMediaFolder) {
        dom.openMediaFolderBtn.addEventListener('click', () => {
            window.electronAPI.openMediaFolder();
        });
    }

    if (dom.emptyStateSearchBtn) {
        dom.emptyStateSearchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDownloadPanel();
            setTimeout(() => {
                if (dom.urlOrSearchInput) dom.urlOrSearchInput.focus();
            }, 500);
        });
    }

    if (dom.emptyStateImportBtn) {
        dom.emptyStateImportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dom.importLocalBtn) dom.importLocalBtn.click();
        });
    }

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
        const src = dom.mediaPlayer.getAttribute('src');
        if ((!src || src === '' || src === 'null') && state.playlist.length === 0) {
            return;
        }

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
            executeShortcut(action);
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
}

document.addEventListener('DOMContentLoaded', init);