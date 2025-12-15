// src/renderer/js/renderer.js

/**
 * @file 应用引导程序 (App Bootstrapper)
 * @description
 * 这是渲染进程的唯一入口。它的职责极其精简：
 * 1. 初始化所有核心模块（UI, Player, Services, Features）。
 * 2. 绑定顶层用户输入事件，作为“总装配车间”将 UI 事件连接到 State 或 Services。
 * 3. 加载应用的初始数据。
 */

import * as dom from './dom.js';
import { getters, mutations, subscribe } from './state.js';
import { PLAY_MODES } from './config.js'; // 导入播放模式常量用于上一首/下一首逻辑
import * as player from './player.js';
import * as ui from './ui.js';
import * as mediaService from './services/mediaService.js';
import * as ICONS from './icons.js';
import { loadShortcuts, setupShortcutListeners } from './features/shortcuts.js';
import * as backgroundGallery from './features/gallery.js';
import { setupDownloaderListeners } from './features/downloader.js';

// --- 常量 ---
const PLAYER_STATE_KEY = 'player_state';

/**
 * 将所有 SVG 图标加载到 DOM 中。
 * 这是应用启动时最先执行的视觉操作之一，确保后续 JS 获取元素时图标已存在。
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
            if (iconMap[iconName]) {
                p.outerHTML = iconMap[iconName];
            } else {
                console.warn(`Icon not found for placeholder: ${iconName}`);
                p.remove();
            }
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
            trackIndex: getters.currentTrackIndex(),
            currentTime: getters.currentTime(),
            volume: getters.volume(),
            muted: getters.isMuted(),
            modeIndex: getters.currentModeIndex(),
            playbackRate: getters.playbackRate(),
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
            console.error("Failed to parse player state from localStorage:", error);
            localStorage.removeItem(PLAYER_STATE_KEY);
        }
    }
    return initialTime;
}

/**
 * 辅助函数：处理“下一首/上一首”的逻辑。
 * 因为 player.js 现在只负责核心控制，所以列表跳转逻辑在此处作为“调度者”处理。
 * @param {number} direction - 1 为下一首，-1 为上一首。
 */
function handleTrackChange(direction) {
    const playlist = getters.playlist();
    const len = playlist.length;

    // 如果播放列表为空且没有临时曲目，不操作
    if (len === 0 && !getters.temporaryPlayingTrack()) return;

    // 如果正在播放临时曲目，按下切换则回到列表第一首
    if (getters.temporaryPlayingTrack()) {
        mutations.clearPlayingTrackInfo();
        if (len > 0) mutations.setCurrentTrackIndex(0);
        return;
    }

    const currentMode = PLAY_MODES[getters.currentModeIndex()];
    let newIndex;

    if (currentMode === 'shuffle') {
        // 随机模式：随机选择一个非当前的索引
        do {
            newIndex = Math.floor(Math.random() * len);
        } while (len > 1 && newIndex === getters.currentTrackIndex());
    } else {
        // 列表/单曲循环模式：按顺序切换（单曲模式下切歌也应切到下一首）
        newIndex = (getters.currentTrackIndex() + direction + len) % len;
    }

    mutations.setCurrentTrackIndex(newIndex);
    mutations.setIsPlaying(true);
}

/**
 * 设置核心 UI 元素的事件监听器。
 * 修复：确保所有面板切换、菜单交互和核心控制按钮都已绑定。
 */
function setupEventListeners() {
    // =========================================================================
    // 1. 播放控制栏 (Play Control Bar)
    // =========================================================================

    // 播放/暂停
    document.getElementById('play-pause-btn')?.addEventListener('click', mutations.togglePlayState);

    // 上一首 / 下一首
    document.getElementById('prev-btn')?.addEventListener('click', () => handleTrackChange(-1));
    document.getElementById('next-btn')?.addEventListener('click', () => handleTrackChange(1));

    // 播放模式切换
    document.getElementById('mode-btn')?.addEventListener('click', mutations.cyclePlayMode);

    // 进度条拖拽与跳转
    const progressBar = document.getElementById('progress-bar');
    if (progressBar) {
        progressBar.addEventListener('mousedown', () => mutations.setIsScrubbing(true));
        // 使用 'change' 事件在拖拽结束时触发跳转
        progressBar.addEventListener('change', (e) => {
            const duration = getters.duration();
            if (!isNaN(duration) && duration > 0) {
                const newTime = (e.target.value / 100) * duration;
                window.dispatchEvent(new CustomEvent('seekTo', { detail: newTime }));
            }
            mutations.setIsScrubbing(false);
        });
        // 'input' 事件在 ui.js 中处理（视觉更新），此处无需重复绑定
    }

    // 音量控制
    document.getElementById('volume-btn')?.addEventListener('click', () => mutations.setIsMuted(!getters.isMuted()));
    document.getElementById('volume-bar')?.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        mutations.setVolume(newVolume);
        mutations.setIsMuted(newVolume === 0);
    });

    // =========================================================================
    // 2. 侧边面板切换与关闭 (Side Panels)
    // =========================================================================

    // 媒体库面板 (Playlist)
    document.getElementById('playlist-btn')?.addEventListener('click', ui.togglePlaylistPanel);
    document.getElementById('mobile-playlist-btn')?.addEventListener('click', ui.togglePlaylistPanel);
    document.getElementById('close-playlist-btn')?.addEventListener('click', ui.closeActivePanels);

    // 歌词面板 (Lyrics)
    document.getElementById('lyrics-btn')?.addEventListener('click', ui.toggleLyricsPanel);
    document.getElementById('mobile-lyrics-btn')?.addEventListener('click', ui.toggleLyricsPanel);
    // 歌词面板本身通常没有关闭按钮，而是再次点击图标或点击背景关闭，这在 ui.js 的 init 中已处理（点击背景）

    // 添加资源/下载面板 (Download)
    document.getElementById('download-panel-btn')?.addEventListener('click', ui.toggleDownloadPanel);
    document.getElementById('close-download-btn')?.addEventListener('click', ui.closeActivePanels);

    // 信息面板 (Info) - 按钮位于“更多选项”菜单中
    document.getElementById('info-btn')?.addEventListener('click', () => {
        ui.toggleInfoPanel();
        // 点击菜单项后，关闭菜单本身
        document.getElementById('more-options-menu')?.classList.remove('visible');
    });
    document.getElementById('close-info-btn')?.addEventListener('click', ui.closeActivePanels);

    // 快捷键面板 (Shortcut) - 按钮位于“更多选项”菜单中
    document.getElementById('shortcut-btn')?.addEventListener('click', () => {
        ui.toggleShortcutPanel();
        document.getElementById('more-options-menu')?.classList.remove('visible');
    });
    document.getElementById('close-shortcut-btn')?.addEventListener('click', ui.closeActivePanels);

    // =========================================================================
    // 3. 菜单与更多选项 (Menus)
    // =========================================================================

    // “更多选项”按钮
    const moreOptionsBtn = document.getElementById('more-options-btn');
    moreOptionsBtn?.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止冒泡，防止被全局点击关闭
        ui.toggleMoreOptionsMenu();
    });

    // 全局点击：关闭“更多选项”菜单和右键菜单
    document.addEventListener('click', (e) => {
        const moreMenu = document.getElementById('more-options-menu');
        const contextMenu = document.getElementById('custom-context-menu');

        // 如果点击的不是“更多”按钮且菜单是打开的，则关闭
        if (moreMenu?.classList.contains('visible') && !moreOptionsBtn?.contains(e.target) && !moreMenu.contains(e.target)) {
            moreMenu.classList.remove('visible');
        }

        // 关闭右键菜单
        if (contextMenu?.style.display === 'block' && !contextMenu.contains(e.target)) {
            ui.hideContextMenu();
        }
    });

    // 右键菜单交互（委托给服务层处理复杂逻辑）
    document.getElementById('custom-context-menu')?.addEventListener('click', (e) => {
        const target = e.target.closest('li[data-action]');
        if (!target) return;

        ui.hideContextMenu();
        const action = target.dataset.action;
        const index = parseInt(target.dataset.index, 10);

        if (action === 'separate-video' && !isNaN(index)) {
            mediaService.separateVideo(index);
        } else if (action === 'delete-track' && !isNaN(index)) {
            mediaService.deleteTrack(index);
        }
    });

    // =========================================================================
    // 4. 媒体库功能 (Library Features)
    // =========================================================================

    // 播放列表项点击
    document.getElementById('playlist')?.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item[data-index]');
        if (item) {
            const newIndex = parseInt(item.dataset.index, 10);
            if (!isNaN(newIndex)) {
                mutations.setCurrentTrackIndex(newIndex);
                mutations.setIsPlaying(true);
            }
        }
    });

    // 媒体库搜索过滤
    document.getElementById('playlist-search')?.addEventListener('input', ui.filterPlaylist);

    // 打开本地媒体文件夹
    document.getElementById('open-media-folder-btn')?.addEventListener('click', () => {
        window.electronAPI.openMediaFolder();
    });

    // =========================================================================
    // 5. 视图控制与杂项 (View & Misc)
    // =========================================================================

    // 全屏控制
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    fullscreenBtn?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.getElementById('media-player')?.requestFullscreen().catch(e => console.error("Fullscreen error:", e));
        } else {
            document.exitFullscreen();
        }
    });

    // 双击主视图切换沉浸模式
    document.querySelector('.main-view')?.addEventListener('dblclick', () => {
        if (document.fullscreenElement || getters.isScreensaverMode()) return;
        const mainView = document.querySelector('.main-view');
        const galleryContainer = document.getElementById('gallery-container');

        mainView.classList.toggle('main-view-fullscreen');
        galleryContainer.classList.toggle('suppressed-by-fullscreen');

        // 关闭可能打开的面板
        if (mainView.classList.contains('main-view-fullscreen')) {
            ui.closeActivePanels();
        }
    });

    // 监听全屏变化，同步退出屏保模式
    window.electronAPI.onFullscreenChange((isFullscreen) => {
        if (!isFullscreen && getters.isScreensaverMode()) {
            mutations.setScreensaverMode(false);
        }
    });

    // 空状态页面按钮
    document.getElementById('empty-state-search-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        ui.toggleDownloadPanel();
        // 自动聚焦输入框
        setTimeout(() => document.getElementById('url-or-search-input')?.focus(), 500);
    });

    // 页面卸载前保存状态
    window.addEventListener('beforeunload', savePlayerState);

    // 全局按键：ESC 关闭面板/屏保
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            ui.hideContextMenu();
            ui.closeActivePanels();
            if (getters.isScreensaverMode()) {
                mutations.setScreensaverMode(false);
                window.electronAPI.toggleFullscreen(false);
            }
        }
        // F11 屏保模式切换
        if (e.key === 'F11') {
            e.preventDefault();
            const isSaver = getters.isScreensaverMode();
            if (isSaver) {
                mutations.setScreensaverMode(false);
                window.electronAPI.toggleFullscreen(false);
            } else if (getters.playlist().length > 0) {
                mutations.setScreensaverMode(true);
                window.electronAPI.toggleFullscreen(true);
            }
        }
    });
}

/**
 * 应用初始化函数。
 */
async function init() {
    // 1. 渲染基础UI
    loadIcons();

    // 2. 初始化所有模块
    ui.init();
    player.init();
    mediaService.init();
    backgroundGallery.init();
    loadShortcuts();

    // 3. 绑定所有事件监听
    setupEventListeners();
    setupDownloaderListeners();
    setupShortcutListeners();

    // 4. 加载持久化状态和初始数据
    const initialTime = loadPlayerState();
    await mediaService.loadInitialData();

    // 5. 根据初始数据决定最终UI状态
    const playlist = getters.playlist();
    if (playlist.length > 0) {
        let trackIndex = getters.currentTrackIndex();
        if (trackIndex >= playlist.length || trackIndex < 0) {
            trackIndex = 0;
        }
        // 使用 setTimeout 确保所有订阅者都已准备就绪
        setTimeout(() => {
            mutations.setCurrentTrackIndex(trackIndex);
            // 如果有保存的播放进度，等待元数据加载后跳转
            if (initialTime > 0) {
                const unsubscribe = subscribe('timeChanged', ({ duration }) => {
                    if (duration > 0) {
                        window.dispatchEvent(new CustomEvent('seekTo', { detail: initialTime }));
                        unsubscribe(); // 跳转后立即取消订阅
                    }
                });
            }
        }, 0);
    } else {
        // 如果没有播放列表，显示空状态并自动打开下载面板
        ui.toggleEmptyState(true);
        // 延迟打开，给用户一个视觉缓冲
        setTimeout(() => ui.toggleDownloadPanel(), 600);
        // 确保最终隐藏骨架屏
        window.dispatchEvent(new CustomEvent('hideSkeleton'));
    }

    console.log("App initialized.");
}

// 确保在 DOM 加载完成后执行初始化
document.addEventListener('DOMContentLoaded', init);