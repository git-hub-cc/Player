// js/dom.js

export let playerContainer = document.querySelector('.player-container');
export let mainView = document.querySelector('.main-view');
export let mediaPlayer = document.getElementById('media-player');
export let playPauseBtn = document.getElementById('play-pause-btn');
export let prevBtn = document.getElementById('prev-btn');
export let nextBtn = document.getElementById('next-btn');
export let progressBar = document.getElementById('progress-bar');
export let currentTimeEl = document.getElementById('current-time');
export let durationEl = document.getElementById('duration');
export let trackTitleEl = document.getElementById('track-title');
export let trackArtistEl = document.getElementById('track-artist');
export let albumArtEl = document.getElementById('album-art');
export let controlAlbumArtEl = document.getElementById('control-album-art');
export let albumArtContainer = document.getElementById('album-art-container');
// =========================================================================
// 【新增】音频可视化画布的 DOM 引用
// =========================================================================
export let audioVisualizer = document.getElementById('audio-visualizer');
// =========================================================================
export let lyricsBtn = document.getElementById('lyrics-btn');
export let lyricsContainer = document.getElementById('lyrics-container');
export let lyricsList = document.getElementById('lyrics-list');
export let lyricsListWrapper = document.getElementById('lyrics-list-wrapper');
export let lyricsDragIndicator = document.getElementById('lyrics-drag-indicator');
export let lyricsDragTime = document.getElementById('lyrics-drag-time');
export let volumeBtn = document.getElementById('volume-btn');
export let volumeBar = document.getElementById('volume-bar');
export let playlistEl = document.getElementById('playlist');
export let playlistPanel = document.getElementById('playlist-panel');
export let playlistBtn = document.getElementById('playlist-btn');
export let closePlaylistBtn = document.getElementById('close-playlist-btn');
export let infoBtn = document.getElementById('info-btn');
export let infoPanel = document.getElementById('info-panel');
export let closeInfoBtn = document.getElementById('close-info-btn');
export let mobilePlaylistBtn = document.getElementById('mobile-playlist-btn');
export let mobileLyricsBtn = document.getElementById('mobile-lyrics-btn');
export let skeletonOverlay = document.getElementById('skeleton-overlay');
export let shortcutBtn = document.getElementById('shortcut-btn');
export let shortcutPanel = document.getElementById('shortcut-panel');
export let closeShortcutBtn = document.getElementById('close-shortcut-btn');
export let shortcutListEl = document.getElementById('shortcut-list');
export let shortcutModalOverlayEl = document.getElementById('shortcut-modal-overlay');
export let shortcutKeyPreviewEl = document.getElementById('shortcut-key-preview');
export let toastEl = document.getElementById('toast-notification');
export let modeBtn = document.getElementById('mode-btn');
export let playlistSearchInput = document.getElementById('playlist-search');
export let playlistNoResultsEl = document.getElementById('playlist-no-results');
export let galleryContainer = document.getElementById('gallery-container');
export let galleryWrapper = document.getElementById('gallery-wrapper');
export let contextMenu = document.getElementById('custom-context-menu');
export let templatesContainer = document.getElementById('templates');
export let docElement = document.documentElement;

// 故障效果元素
export let glitchOverlay = document.getElementById('glitch-overlay');
export let glitchLinesGroup = document.getElementById('glitch-lines');
export let glitchSpotifyShapesGroup = document.getElementById('glitch-spotify-shapes');
export let feTurbulence = document.querySelector('#glitch-filter-spotify feTurbulence');
export let feDisplacementMap = document.querySelector('#glitch-filter-spotify feDisplacementMap');
export let feOffsetR = document.querySelector('#glitch-filter-spotify [result="red_offset"]');
export let feOffsetB = document.querySelector('#glitch-filter-spotify [result="blue_offset"]');

// Canvas for gradient extraction
export let bgCanvas = document.createElement('canvas');
export let bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });

// --- 下载/搜索面板相关元素 ---
export let downloadPanelBtn = document.getElementById('download-panel-btn');
export let downloadPanel = document.getElementById('download-panel');
export let closeDownloadBtn = document.getElementById('close-download-btn');
export let urlOrSearchInput = document.getElementById('url-or-search-input');
export let downloadStatusEl = document.getElementById('download-status');
export let downloadActionsContainer = document.getElementById('download-actions-container');
export let startDownloadBtn = document.getElementById('start-download-btn');
export let downloadWorksBtn = document.getElementById('download-works-btn');
export let downloadLikesBtn = document.getElementById('download-likes-btn');
export let searchNeteaseBtn = document.getElementById('search-netease-btn');
export let downloaderView = document.getElementById('downloader-view');
export let panelDescription = downloaderView.querySelector('.panel-description');
export let searchResultsContainer = document.getElementById('search-results-container');
export let searchResultsList = document.getElementById('search-results-list');
// =========================================================================
// 【新增】分页控件容器的 DOM 引用
// =========================================================================
export let paginationControls = document.getElementById('pagination-controls');
// =========================================================================

// --- 通用确认模态框元素 ---
export let confirmationModal = document.getElementById('confirmation-modal-overlay');
export let confirmationMessage = document.getElementById('confirmation-message');
export let confirmBtn = document.getElementById('confirm-btn');
export let cancelBtn = document.getElementById('cancel-btn');

// 【移除】updateMediaPlayerReference 函数不再需要

// DOM Query/Creation Functions
export const getTemplateElementById = (id) => document.getElementById(id);
export const createFragment = () => document.createDocumentFragment();
export const createListItem = () => document.createElement('li');
export const getLyricLines = () => lyricsList.querySelectorAll('p');
export const getAllPlaylistItems = () => playlistEl.querySelectorAll('.playlist-item');
export const getContextMenuList = () => contextMenu.querySelector('ul');
export const getFullscreenElement = () => document.fullscreenElement;
export const exitFullscreen = () => document.exitFullscreen();