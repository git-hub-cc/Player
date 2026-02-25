// src/renderer/js/renderer.js

/**
 * @file 应用引导程序 (App Bootstrapper)
 * @description
 * 渲染进程的唯一入口。负责初始化所有模块，绑定顶层事件，并加载初始数据。
 */

import * as dom from './dom.js';
import { getters, mutations, subscribe } from './state.js';
import * as player from './player.js';
import * as ui from './ui.js';
import * as mediaService from './services/mediaService.js';
import * as ICONS from './icons.js';
import { loadShortcuts, setupShortcutListeners } from './features/shortcuts.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners } from './features/downloader.js';
import { FILTER_MODES } from './config.js';

const PLAYER_STATE_KEY = 'player_state';

/**
 * 将所有 SVG 图标加载到 DOM 中。
 */
function loadIcons() {
    try {
        const iconMap = {
            FOLDER: ICONS.ICON_FOLDER, CLOSE: ICONS.ICON_CLOSE, ADD: ICONS.ICON_ADD, DRAG_ADD: ICONS.ICON_DRAG_ADD,
            PREV: ICONS.ICON_PREV, PLAY: ICONS.ICON_PLAY, PAUSE: ICONS.ICON_PAUSE, NEXT: ICONS.ICON_NEXT,
            MORE_OPTIONS: ICONS.ICON_MORE_OPTIONS, KEYBOARD: ICONS.ICON_KEYBOARD, INFO: ICONS.ICON_INFO,
            LIST_LOOP: ICONS.ICON_LIST_LOOP, SINGLE_LOOP: ICONS.ICON_SINGLE_LOOP, SHUFFLE: ICONS.ICON_SHUFFLE,
            LYRICS: ICONS.ICON_LYRICS, FULLSCREEN_ENTER: ICONS.ICON_FULLSCREEN_ENTER, FULLSCREEN_EXIT: ICONS.ICON_FULLSCREEN_EXIT,
            PLAYLIST: ICONS.ICON_PLAYLIST, VOLUME: ICONS.ICON_VOLUME, MUTE: ICONS.ICON_MUTE,
            MOBILE_LYRICS: ICONS.ICON_MOBILE_LYRICS, MOBILE_PLAYLIST: ICONS.ICON_MOBILE_PLAYLIST,
            DOWNLOAD: ICONS.ICON_DOWNLOAD, SPINNER: ICONS.ICON_SPINNER, CACHED: ICONS.ICON_CACHED,
            GALLERY_PLAY: ICONS.ICON_GALLERY_PLAY,
            SETTINGS: ICONS.ICON_SETTINGS,
            FILTER_ALL: ICONS.ICON_FILTER_ALL,
            FILTER_AUDIO: ICONS.ICON_FILTER_AUDIO,
            FILTER_VIDEO: ICONS.ICON_FILTER_VIDEO
        };
        document.querySelectorAll('.icon-placeholder').forEach(p => {
            const iconName = p.dataset.icon;
            if (iconMap[iconName]) p.outerHTML = iconMap[iconName];
        });
    } catch (error) {
        console.error("Failed to load icons:", error);
    }
}

/**
 * 保存当前播放器核心状态到 localStorage。
 */
function savePlayerState() {
    const currentPlaylist = getters.playlist();
    if (currentPlaylist.length === 0) {
        localStorage.removeItem(PLAYER_STATE_KEY);
        return;
    }
    try {
        const stateToSave = {
            trackIndex: getters.currentTrackIndex(),
            currentTime: getters.currentTime(),
            volume: getters.volume(),
            muted: getters.isMuted(),
            modeIndex: getters.currentModeIndex(),
            playbackRate: getters.playbackRate(),
            mediaFilterMode: getters.mediaFilterMode(),
            // =========================================================================
            // 【核心修改】仅保存视频的进度信息，以减少存储空间
            // =========================================================================
            videoProgress: currentPlaylist
                .filter(track => track.type === 'video' && track.totalDuration > 0)
                .map(track => ({
                    src: track.src.replace('media://', ''), // 使用相对路径作为唯一标识
                    lastPosition: track.lastPosition,
                    totalDuration: track.totalDuration
                })),
        };
        localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(stateToSave));
    } catch (error) {
        console.error("Failed to save player state:", error);
    }
}

/**
 * 从 localStorage 加载播放器状态并应用。
 * @returns {number} 初始播放时间。
 */
function loadPlayerState() {
    const savedState = localStorage.getItem(PLAYER_STATE_KEY);
    let initialTime = 0;
    if (savedState) {
        try {
            const parsedState = JSON.parse(savedState);
            mutations.setCurrentTrackIndex(parsedState.trackIndex || 0);
            mutations.setCurrentModeIndex(parsedState.modeIndex || 0);
            mutations.setVolume(parsedState.volume ?? 1.0);
            mutations.setIsMuted(parsedState.muted ?? false);
            mutations.setPlaybackRate(parsedState.playbackRate || 1.0);
            if (parsedState.mediaFilterMode && Object.values(FILTER_MODES).includes(parsedState.mediaFilterMode)) {
                mutations.setMediaFilterMode(parsedState.mediaFilterMode);
            }
            initialTime = parsedState.currentTime || 0;

            // =========================================================================
            // 【核心修改】合并视频进度信息
            // =========================================================================
            // 此处不再直接加载整个 playlist，而是只加载进度信息，
            // 稍后在 `loadInitialData` 完成后进行合并。
            if (parsedState.videoProgress) {
                // 临时存储，等待主播放列表加载完成
                window.videoProgressCache = new Map(
                    parsedState.videoProgress.map(p => [p.src, { lastPosition: p.lastPosition, totalDuration: p.totalDuration }])
                );
            }
            // =========================================================================
        } catch (error) {
            console.error("Failed to parse player state:", error);
            localStorage.removeItem(PLAYER_STATE_KEY);
        }
    }
    return initialTime;
}

/**
 * 设置文件与文件夹拖拽功能的事件监听器。
 */
function setupDragAndDropListeners() {
    const dragOverlay = document.getElementById('drag-overlay');
    if (!dragOverlay) return;
    window.addEventListener('dragover', (e) => e.preventDefault(), false);
    window.addEventListener('drop', (e) => e.preventDefault(), false);
    let dragCounter = 0;
    window.addEventListener('dragenter', () => {
        dragCounter++;
        dragOverlay.classList.add('active');
    });
    window.addEventListener('dragleave', () => {
        dragCounter--;
        if (dragCounter === 0) {
            dragOverlay.classList.remove('active');
        }
    });
    window.addEventListener('drop', async (e) => {
        dragCounter = 0;
        dragOverlay.classList.remove('active');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            try {
                ui.showToast(`已开始处理 ${files.length} 个文件...`, 'info');
                await window.electronAPI.handleFileDrop(files);
            } catch (error) {
                console.error('处理拖拽文件失败:', error);
                ui.showToast(`文件处理失败: ${error.message}`, 'error');
            }
        }
    });
}

async function refreshToolsStatus() {
    try {
        const status = await window.electronAPI.checkCoreTools();
        updateToolCard(dom.ffmpegToolCard, status.ffmpeg);
        updateToolCard(dom.ytdlpToolCard, status.ytDlp);
    } catch (e) {
        console.error('检查工具状态失败:', e);
        ui.showToast('无法获取组件状态', 'error');
    }
}

function updateToolCard(cardEl, toolStatus) {
    if (!cardEl) return;
    const badge = cardEl.querySelector('.tool-status-badge');
    const iconContainer = cardEl.querySelector('.tool-icon');
    const pathText = cardEl.querySelector('.tool-path');
    const btn = cardEl.querySelector('.download-tool-btn');
    if (toolStatus.exists) {
        badge.textContent = '已就绪';
        badge.className = 'tool-status-badge installed';
        iconContainer.innerHTML = ICONS.ICON_CHECK_CIRCLE;
        pathText.textContent = `路径: ${toolStatus.path}`;
        pathText.title = toolStatus.path;
        btn.textContent = '重新下载 / 修复';
    } else {
        badge.textContent = '未安装';
        badge.className = 'tool-status-badge missing';
        iconContainer.innerHTML = ICONS.ICON_ALERT_CIRCLE;
        pathText.textContent = '路径: --';
        btn.textContent = '立即下载';
    }
}

function setupSettingsPanelListeners() {
    dom.settingsBtn?.addEventListener('click', () => {
        ui.toggleSettingsPanel();
        dom.moreOptionsMenu?.classList.remove('visible');
        refreshToolsStatus();
    });
    dom.closeSettingsBtn?.addEventListener('click', ui.closeActivePanels);
    dom.openToolsFolderBtn?.addEventListener('click', () => {
        window.electronAPI.openToolsFolder();
    });
    dom.downloadToolBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const toolName = e.currentTarget.dataset.tool;
            const btnEl = e.currentTarget;
            btnEl.disabled = true;
            btnEl.classList.add('loading');
            ui.showToast(`开始下载 ${toolName}...`, 'info');
            try {
                const result = await window.electronAPI.downloadCoreTool(toolName);
                if (result.success) {
                    ui.showToast(`${toolName} 下载安装成功！`, 'success');
                    refreshToolsStatus();
                } else {
                    ui.showToast(`下载失败: ${result.error}`, 'error');
                }
            } catch (err) {
                ui.showToast(`操作异常: ${err.message}`, 'error');
            } finally {
                btnEl.disabled = false;
                btnEl.classList.remove('loading');
            }
        });
    });
}

/**
 * 设置核心 UI 元素的事件监听器。
 */
function setupEventListeners() {
    dom.playPauseBtn?.addEventListener('click', mutations.togglePlayState);
    dom.prevBtn?.addEventListener('click', async () => {
        const shortcutsModule = await import('./features/shortcuts.js');
        new shortcutsModule.PrevTrackCommand().execute();
    });
    dom.nextBtn?.addEventListener('click', async () => {
        const shortcutsModule = await import('./features/shortcuts.js');
        new shortcutsModule.NextTrackCommand().execute();
    });
    dom.modeBtn?.addEventListener('click', mutations.cyclePlayMode);
    dom.progressBar?.addEventListener('mousedown', () => mutations.setIsScrubbing(true));
    dom.progressBar?.addEventListener('change', (e) => {
        const duration = getters.duration();
        if (!isNaN(duration) && duration > 0) {
            window.dispatchEvent(new CustomEvent('seekTo', { detail: (e.target.value / 100) * duration }));
        }
        mutations.setIsScrubbing(false);
    });
    dom.volumeBtn?.addEventListener('click', () => mutations.setIsMuted(!getters.isMuted()));
    dom.volumeBar?.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        mutations.setVolume(newVolume);
        mutations.setIsMuted(newVolume === 0);
    });
    dom.playlistBtn?.addEventListener('click', ui.togglePlaylistPanel);
    dom.mobilePlaylistBtn?.addEventListener('click', ui.togglePlaylistPanel);
    dom.closePlaylistBtn?.addEventListener('click', ui.closeActivePanels);
    dom.lyricsBtn?.addEventListener('click', ui.toggleLyricsPanel);
    dom.mobileLyricsBtn?.addEventListener('click', ui.toggleLyricsPanel);
    dom.downloadPanelBtn?.addEventListener('click', ui.toggleDownloadPanel);
    dom.closeDownloadBtn?.addEventListener('click', ui.closeActivePanels);
    dom.infoBtn?.addEventListener('click', () => { ui.toggleInfoPanel(); dom.moreOptionsMenu?.classList.remove('visible'); });
    dom.closeInfoBtn?.addEventListener('click', ui.closeActivePanels);
    dom.shortcutBtn?.addEventListener('click', () => { ui.toggleShortcutPanel(); dom.moreOptionsMenu?.classList.remove('visible'); });
    dom.closeShortcutBtn?.addEventListener('click', ui.closeActivePanels);
    dom.moreOptionsBtn?.addEventListener('click', (e) => { e.stopPropagation(); ui.toggleMoreOptionsMenu(); });
    document.addEventListener('click', (e) => {
        if (dom.moreOptionsMenu?.classList.contains('visible') && !dom.moreOptionsBtn?.contains(e.target)) {
            ui.closeActivePanels();
        }
        if (dom.contextMenu?.style.display === 'block' && !dom.contextMenu.contains(e.target)) {
            ui.hideContextMenu();
        }
    });
    dom.playlistEl?.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item[data-index]');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            if (!isNaN(newIndex)) { mutations.setCurrentTrackIndex(newIndex, true); mutations.setIsPlaying(true); }
        }
    });
    dom.playlistEl?.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.playlist-item[data-index]');
        if (!item) return; e.preventDefault();
        const index = parseInt(item.dataset.index, 10);
        if (isNaN(index)) return;
        ui.renderContextMenu({ type: 'playlist-item', index: index });
        const { clientX, clientY } = e;
        const { innerWidth, innerHeight } = window;
        const menuWidth = dom.contextMenu.offsetWidth, menuHeight = dom.contextMenu.offsetHeight;
        dom.contextMenu.style.left = `${clientX + menuWidth > innerWidth ? innerWidth - menuWidth - 5 : clientX}px`;
        dom.contextMenu.style.top = `${clientY + menuHeight > innerHeight ? innerHeight - menuHeight - 5 : clientY}px`;
        dom.contextMenu.style.display = 'block';
    });
    dom.contextMenu?.addEventListener('click', (e) => {
        const target = e.target.closest('li[data-action]');
        if (!target) return;
        ui.hideContextMenu();
        const action = target.dataset.action, index = parseInt(target.dataset.index, 10);
        if (action === 'separate-video' && !isNaN(index)) mediaService.separateVideo(index);
        else if (action === 'delete-track' && !isNaN(index)) mediaService.deleteTrack(index);
    });
    dom.playlistSearchInput?.addEventListener('input', ui.filterPlaylist);
    dom.openMediaFolderBtn?.addEventListener('click', () => window.electronAPI.openMediaFolder(getters.mediaFilterMode()));
    dom.fullscreenBtn?.addEventListener('click', () => {
        if (!document.fullscreenElement) dom.mediaPlayer?.requestFullscreen().catch(console.error);
        else document.exitFullscreen();
    });
    dom.mainView?.addEventListener('dblclick', () => {
        if (document.fullscreenElement || getters.isScreensaverMode()) return;
        dom.mainView.classList.toggle('main-view-fullscreen');
        dom.galleryContainer.classList.toggle('suppressed-by-fullscreen');
        if (dom.mainView.classList.contains('main-view-fullscreen')) ui.closeActivePanels();
    });
    window.electronAPI.onFullscreenChange((isFullscreen) => {
        if (!isFullscreen && getters.isScreensaverMode()) mutations.setScreensaverMode(false);
    });
    dom.emptyStateSearchBtn?.addEventListener('click', (e) => {
        e.stopPropagation(); ui.toggleDownloadPanel();
        setTimeout(() => dom.urlOrSearchInput?.focus(), 500);
    });
    window.addEventListener('beforeunload', savePlayerState);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            ui.hideContextMenu(); ui.closeActivePanels();
            if (getters.isScreensaverMode()) { mutations.setScreensaverMode(false); window.electronAPI.toggleFullscreen(false); }
        }
        if (e.key === 'F11') {
            e.preventDefault();
            const isSaver = getters.isScreensaverMode();
            if (isSaver) { mutations.setScreensaverMode(false); window.electronAPI.toggleFullscreen(false); }
            else if (getters.playlist().length > 0) { mutations.setScreensaverMode(true); window.electronAPI.toggleFullscreen(true); }
        }
    });
    setupSettingsPanelListeners();
}

/**
 * 应用初始化函数。
 */
async function init() {
    loadIcons();
    ui.init();
    player.init();
    mediaService.init();
    backgroundGallery.init();
    loadShortcuts();
    setupEventListeners();
    setupDownloaderListeners();
    setupShortcutListeners();
    setupDragAndDropListeners();

    window.electronAPI.onOpenFile((filePath) => {
        console.log(`[Renderer] 接收到文件路径: ${filePath}`);
        mediaService.playFileFromPath(filePath);
    });

    const initialTime = loadPlayerState();

    // =========================================================================
    // 【核心修改】将数据加载与进度合并逻辑分离
    // =========================================================================
    // 先从 playlist.json 加载基础数据
    await mediaService.loadInitialData();

    // 在基础数据加载后，合并 localStorage 中的视频进度
    if (window.videoProgressCache) {
        const playlist = getters.playlist();
        playlist.forEach(track => {
            const progressData = window.videoProgressCache.get(track.src.replace('media://', ''));
            if (progressData) {
                track.lastPosition = progressData.lastPosition;
                track.totalDuration = progressData.totalDuration;
            }
        });
        // 更新整个播放列表状态，以确保进度数据被 반영
        mutations.setPlaylist(playlist);
        // 清理缓存
        delete window.videoProgressCache;
    }
    // =========================================================================

    const playlist = getters.playlist();
    if (playlist.length > 0) {
        let trackIndex = getters.currentTrackIndex();
        if (trackIndex >= playlist.length || trackIndex < 0) trackIndex = 0;

        setTimeout(() => {
            const isPlayingExternalFile = !!getters.temporaryPlayingTrack();
            if (!isPlayingExternalFile) {
                mutations.setCurrentTrackIndex(trackIndex, true);
            }
            if (initialTime > 0) {
                const unsubscribe = subscribe('timeChanged', ({ duration }) => {
                    if (getters.temporaryPlayingTrack()) {
                        unsubscribe();
                        return;
                    }
                    if (duration > 0) {
                        window.dispatchEvent(new CustomEvent('seekTo', { detail: initialTime }));
                        unsubscribe();
                    }
                });
            }
        }, 0);
    } else {
        ui.toggleEmptyState(true);
        if (!getters.temporaryPlayingTrack()) {
            setTimeout(() => ui.toggleDownloadPanel(), 600);
        }
        window.dispatchEvent(new CustomEvent('hideSkeleton'));
    }
    console.log("App initialized.");
}

document.addEventListener('DOMContentLoaded', init);