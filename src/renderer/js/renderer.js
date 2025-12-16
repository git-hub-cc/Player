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
            GALLERY_PLAY: ICONS.ICON_GALLERY_PLAY
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
    if (getters.playlist().length === 0) {
        localStorage.removeItem(PLAYER_STATE_KEY);
        return;
    }
    try {
        const stateToSave = {
            trackIndex: getters.currentTrackIndex(), currentTime: getters.currentTime(),
            volume: getters.volume(), muted: getters.isMuted(),
            modeIndex: getters.currentModeIndex(), playbackRate: getters.playbackRate(),
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
            initialTime = parsedState.currentTime || 0;
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

    async function traverseFileTree(entry) {
        let files = [];
        if (entry.isFile) {
            return new Promise((resolve, reject) => {
                entry.file(file => resolve([file]), reject);
            });
        } else if (entry.isDirectory) {
            return new Promise((resolve, reject) => {
                const dirReader = entry.createReader();
                let allEntries = [];
                const readEntries = () => {
                    dirReader.readEntries(async (entries) => {
                        if (entries.length === 0) {
                            try {
                                const nestedFiles = await Promise.all(allEntries.map(e => traverseFileTree(e)));
                                resolve(nestedFiles.flat());
                            } catch (err) {
                                reject(err);
                            }
                        } else {
                            allEntries = allEntries.concat(entries);
                            readEntries();
                        }
                    }, reject);
                };
                readEntries();
            });
        }
        return files;
    }

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
        const items = e.dataTransfer.items;
        if (!items || items.length === 0) return;
        ui.showToast('正在处理拖拽的文件/文件夹...', 'info');
        try {
            const promises = Array.from(items)
                .map(item => item.webkitGetAsEntry())
                .filter(Boolean)
                .map(entry => traverseFileTree(entry));
            const nestedFiles = await Promise.all(promises);
            const allFiles = nestedFiles.flat();
            if (allFiles.length > 0) {
                // Electron Forge 的 Vite 插件会自动处理 File 对象的 path
                await window.electronAPI.handleFileDrop(allFiles);
                ui.showToast(`已开始处理 ${allFiles.length} 个文件...`, 'info');
            } else {
                ui.showToast('未在拖拽项中找到支持的媒体文件。', 'error');
            }
        } catch (error) {
            console.error('处理拖拽文件/文件夹失败:', error);
            ui.showToast(`处理失败: ${error.message}`, 'error');
        }
    });
}


/**
 * 设置核心 UI 元素的事件监听器。
 */
function setupEventListeners() {
    // --- 播放控制 ---
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

    // --- 进度条 ---
    dom.progressBar?.addEventListener('mousedown', () => mutations.setIsScrubbing(true));
    dom.progressBar?.addEventListener('change', (e) => {
        const duration = getters.duration();
        if (!isNaN(duration) && duration > 0) {
            window.dispatchEvent(new CustomEvent('seekTo', { detail: (e.target.value / 100) * duration }));
        }
        mutations.setIsScrubbing(false);
    });

    // --- 音量控制 ---
    dom.volumeBtn?.addEventListener('click', () => mutations.setIsMuted(!getters.isMuted()));
    dom.volumeBar?.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        mutations.setVolume(newVolume);
        mutations.setIsMuted(newVolume === 0);
    });

    // --- 面板切换 ---
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

    // --- 菜单 ---
    dom.moreOptionsBtn?.addEventListener('click', (e) => { e.stopPropagation(); ui.toggleMoreOptionsMenu(); });
    document.addEventListener('click', (e) => {
        if (dom.moreOptionsMenu?.classList.contains('visible') && !dom.moreOptionsBtn?.contains(e.target)) {
            ui.closeActivePanels();
        }
        if (dom.contextMenu?.style.display === 'block' && !dom.contextMenu.contains(e.target)) {
            ui.hideContextMenu();
        }
    });

    // --- 媒体库交互 ---
    dom.playlistEl?.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item[data-index]');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            if (!isNaN(newIndex)) { mutations.setCurrentTrackIndex(newIndex); mutations.setIsPlaying(true); }
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
    dom.openMediaFolderBtn?.addEventListener('click', () => window.electronAPI.openMediaFolder());

    // --- 视图与杂项 ---
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

    // =========================================================================
    // 【核心新增】监听主进程通过文件关联打开文件的事件
    // =========================================================================
    window.electronAPI.onOpenFile((filePath) => {
        console.log(`[Renderer] 接收到文件路径: ${filePath}`);
        mediaService.playFileFromPath(filePath);
    });
    // =========================================================================

    const initialTime = loadPlayerState();
    await mediaService.loadInitialData();

    const playlist = getters.playlist();
    if (playlist.length > 0) {
        let trackIndex = getters.currentTrackIndex();
        if (trackIndex >= playlist.length || trackIndex < 0) trackIndex = 0;
        setTimeout(() => {
            // 仅在没有通过文件关联启动时，才恢复上次播放的轨道
            if (!getters.currentTrack()) {
                mutations.setCurrentTrackIndex(trackIndex, true); // 强制触发更新
            }
            if (initialTime > 0) {
                const unsubscribe = subscribe('timeChanged', ({ duration }) => {
                    if (duration > 0) {
                        window.dispatchEvent(new CustomEvent('seekTo', { detail: initialTime }));
                        unsubscribe();
                    }
                });
            }
        }, 0);
    } else {
        ui.toggleEmptyState(true);
        // 如果播放列表为空，但有文件要打开，则不自动打开下载面板
        if (!getters.currentTrack()) {
            setTimeout(() => ui.toggleDownloadPanel(), 600);
        }
        window.dispatchEvent(new CustomEvent('hideSkeleton'));
    }
    console.log("App initialized.");
}

document.addEventListener('DOMContentLoaded', init);