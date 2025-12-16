// src/renderer/js/dom.js

// --- 播放器核心元素 ---
export let playerContainer = document.querySelector('.player-container');
export let mainView = document.querySelector('.main-view');
export let mediaPlayer = document.getElementById('media-player');
export let playerControls = document.querySelector('.player-controls');

// --- 专辑封面与可视化 ---
export let albumArtContainer = document.getElementById('album-art-container');
export let albumArtEl = document.getElementById('album-art');
export let controlAlbumArtEl = document.getElementById('control-album-art');
export let audioVisualizer = document.getElementById('audio-visualizer');

// --- 播放控制按钮 ---
export let playPauseBtn = document.getElementById('play-pause-btn');
export let prevBtn = document.getElementById('prev-btn');
export let nextBtn = document.getElementById('next-btn');
export let modeBtn = document.getElementById('mode-btn');

// --- 进度条与时间显示 ---
export let progressBar = document.getElementById('progress-bar');
export let currentTimeEl = document.getElementById('current-time');
export let durationEl = document.getElementById('duration');

// --- 曲目信息 ---
export let trackTitleEl = document.getElementById('track-title');
export let trackArtistEl = document.getElementById('track-artist');

// --- 音量控制 ---
export let volumeBtn = document.getElementById('volume-btn');
export let volumeBar = document.getElementById('volume-bar');

// --- 歌词相关 ---
export let lyricsBtn = document.getElementById('lyrics-btn');
export let mobileLyricsBtn = document.getElementById('mobile-lyrics-btn');
export let lyricsContainer = document.getElementById('lyrics-container');
export let lyricsList = document.getElementById('lyrics-list');
export let lyricsListWrapper = document.getElementById('lyrics-list-wrapper');
export let lyricsDragIndicator = document.getElementById('lyrics-drag-indicator');
export let lyricsDragTime = document.getElementById('lyrics-drag-time');

// --- 播放列表面板 ---
export let playlistPanel = document.getElementById('playlist-panel');
export let playlistBtn = document.getElementById('playlist-btn');
export let mobilePlaylistBtn = document.getElementById('mobile-playlist-btn');
export let closePlaylistBtn = document.getElementById('close-playlist-btn');
export let playlistEl = document.getElementById('playlist');
export let playlistSearchInput = document.getElementById('playlist-search');
export let playlistNoResultsEl = document.getElementById('playlist-no-results');
export let openMediaFolderBtn = document.getElementById('open-media-folder-btn');

// --- 信息面板 ---
export let infoPanel = document.getElementById('info-panel');
// 【核心修改】直接引用菜单项中的按钮，确保事件监听有效
export let infoBtn = document.getElementById('info-btn');
export let closeInfoBtn = document.getElementById('close-info-btn');

// --- 快捷键面板 ---
export let shortcutPanel = document.getElementById('shortcut-panel');
// 【核心修改】直接引用菜单项中的按钮
export let shortcutBtn = document.getElementById('shortcut-btn');
export let closeShortcutBtn = document.getElementById('close-shortcut-btn');
export let shortcutListEl = document.getElementById('shortcut-list');

// --- 下载/搜索面板 ---
export let downloadPanel = document.getElementById('download-panel');
export let downloadPanelBtn = document.getElementById('download-panel-btn');
export let closeDownloadBtn = document.getElementById('close-download-btn');
export let urlOrSearchInput = document.getElementById('url-or-search-input');
export let downloadStatusEl = document.getElementById('download-status');
export let downloadActionsContainer = document.getElementById('download-actions-container');
export let startDownloadBtn = document.getElementById('start-download-btn');
export let searchNeteaseBtn = document.getElementById('search-netease-btn');
export let downloaderView = document.getElementById('downloader-view');
export let panelDescription = downloaderView.querySelector('.panel-description');
export let searchResultsContainer = document.getElementById('search-results-container');
export let searchResultsList = document.getElementById('search-results-list');
export let paginationControls = document.getElementById('pagination-controls');
export let importLocalBtn = document.getElementById('import-local-btn');

// --- 空状态 ---
export let emptyStateView = document.getElementById('empty-state-view');
export let emptyStateSearchBtn = document.getElementById('empty-state-search-btn');
export let emptyStateImportBtn = document.getElementById('empty-state-import-btn');

// --- 背景画廊 ---
export let galleryContainer = document.getElementById('gallery-container');
export let galleryWrapper = document.getElementById('gallery-wrapper');

// --- 模态框与上下文菜单 ---
export let shortcutModalOverlayEl = document.getElementById('shortcut-modal-overlay');
export let shortcutKeyPreviewEl = document.getElementById('shortcut-key-preview');
export let confirmationModal = document.getElementById('confirmation-modal-overlay');
export let confirmationMessage = document.getElementById('confirmation-message');
export let confirmBtn = document.getElementById('confirm-btn');
export let cancelBtn = document.getElementById('cancel-btn');
export let contextMenu = document.getElementById('custom-context-menu');
export let toastEl = document.getElementById('toast-notification');

// --- 视频与UI辅助 ---
export let fullscreenBtn = document.getElementById('fullscreen-btn');

// --- 动态创建与底层元素 ---
export let bgCanvas = document.createElement('canvas');
export let bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
export let templatesContainer = document.getElementById('templates');
export let docElement = document.documentElement;

// --- 反馈 UI 元素 ---
export let seekFeedbackEl = document.getElementById('seek-feedback');
export let speedFeedbackEl = document.getElementById('speed-feedback');

// =========================================================================
// 【核心修改】新增对“更多选项”按钮和菜单的引用
// =========================================================================
export let moreOptionsBtn = document.getElementById('more-options-btn');
export let moreOptionsMenu = document.getElementById('more-options-menu');
// =========================================================================

export const allSidePanels = [playlistPanel, infoPanel, shortcutPanel, downloadPanel];

// --- DOM 查询/创建辅助函数 ---
export const getTemplateElementById = (id) => document.getElementById(id);
export const createFragment = () => document.createDocumentFragment();
export const createListItem = () => document.createElement('li');
export const getLyricLines = () => lyricsList.querySelectorAll('p');
export const getAllPlaylistItems = () => playlistEl.querySelectorAll('.playlist-item');
export const getContextMenuList = () => contextMenu.querySelector('ul');
export const getFullscreenElement = () => document.fullscreenElement;
export const exitFullscreen = () => document.exitFullscreen();