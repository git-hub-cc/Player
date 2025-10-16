// js/dom.js

export const playerContainer = document.querySelector('.player-container');
export const mainView = document.querySelector('.main-view');
export const mediaPlayer = document.getElementById('media-player');
export const playPauseBtn = document.getElementById('play-pause-btn');
export const prevBtn = document.getElementById('prev-btn');
export const nextBtn = document.getElementById('next-btn');
export const progressBar = document.getElementById('progress-bar');
export const currentTimeEl = document.getElementById('current-time');
export const durationEl = document.getElementById('duration');
export const trackTitleEl = document.getElementById('track-title');
export const trackArtistEl = document.getElementById('track-artist');
export const albumArtEl = document.getElementById('album-art');
export const controlAlbumArtEl = document.getElementById('control-album-art');
export const albumArtContainer = document.getElementById('album-art-container');
export const lyricsBtn = document.getElementById('lyrics-btn');
export const lyricsContainer = document.getElementById('lyrics-container');
export const lyricsList = document.getElementById('lyrics-list');
export const lyricsListWrapper = document.getElementById('lyrics-list-wrapper');

// 获取歌词拖拽相关元素
export const lyricsDragIndicator = document.getElementById('lyrics-drag-indicator');
export const lyricsDragTime = document.getElementById('lyrics-drag-time');

export const volumeBtn = document.getElementById('volume-btn');
export const volumeBar = document.getElementById('volume-bar');
export const playlistEl = document.getElementById('playlist');
export const playlistPanel = document.getElementById('playlist-panel');
export const playlistBtn = document.getElementById('playlist-btn');
export const closePlaylistBtn = document.getElementById('close-playlist-btn');
export const infoBtn = document.getElementById('info-btn');
export const infoPanel = document.getElementById('info-panel');
export const closeInfoBtn = document.getElementById('close-info-btn');
export const mobilePlaylistBtn = document.getElementById('mobile-playlist-btn');
export const mobileLyricsBtn = document.getElementById('mobile-lyrics-btn');
export const skeletonOverlay = document.getElementById('skeleton-overlay');
export const shortcutBtn = document.getElementById('shortcut-btn');
export const shortcutPanel = document.getElementById('shortcut-panel');
export const closeShortcutBtn = document.getElementById('close-shortcut-btn');
export const shortcutListEl = document.getElementById('shortcut-list');
export const shortcutModalOverlayEl = document.getElementById('shortcut-modal-overlay');
export const shortcutKeyPreviewEl = document.getElementById('shortcut-key-preview');
export const toastEl = document.getElementById('toast-notification');
export const modeBtn = document.getElementById('mode-btn');
export const playlistSearchInput = document.getElementById('playlist-search');
export const playlistNoResultsEl = document.getElementById('playlist-no-results');
export const galleryContainer = document.getElementById('gallery-container');
export const galleryWrapper = document.getElementById('gallery-wrapper');
export const contextMenu = document.getElementById('custom-context-menu');
export const templatesContainer = document.getElementById('templates');
export const docElement = document.documentElement;

// 故障效果元素
export const glitchOverlay = document.getElementById('glitch-overlay');
export const glitchLinesGroup = document.getElementById('glitch-lines');
export const glitchSpotifyShapesGroup = document.getElementById('glitch-spotify-shapes');
export const feTurbulence = document.querySelector('#glitch-filter-spotify feTurbulence');
export const feDisplacementMap = document.querySelector('#glitch-filter-spotify feDisplacementMap');
export const feOffsetR = document.querySelector('#glitch-filter-spotify [result="red_offset"]');
export const feOffsetB = document.querySelector('#glitch-filter-spotify [result="blue_offset"]');

// Canvas for gradient extraction
export const bgCanvas = document.createElement('canvas');
export const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });

// --- 下载/搜索面板相关元素 ---
export const downloadPanelBtn = document.getElementById('download-panel-btn');
export const downloadPanel = document.getElementById('download-panel');
export const closeDownloadBtn = document.getElementById('close-download-btn');
export const urlOrSearchInput = document.getElementById('url-or-search-input'); // 统一输入框
export const downloadStatusEl = document.getElementById('download-status');
export const downloadActionsContainer = document.getElementById('download-actions-container');

// 抖音下载按钮
export const startDownloadBtn = document.getElementById('start-download-btn');
export const downloadWorksBtn = document.getElementById('download-works-btn');
export const downloadLikesBtn = document.getElementById('download-likes-btn');

// 在线音乐搜索按钮
export const searchNeteaseBtn = document.getElementById('search-netease-btn');

// 引导视图和工作视图
export const setupView = document.getElementById('setup-view');
export const downloaderView = document.getElementById('downloader-view');
export const panelDescription = downloaderView.querySelector('.panel-description');
export const copyInstallCommandBtn = document.getElementById('copy-command-btn-install');
export const copyRunCommandBtn = document.getElementById('copy-command-btn-run');
export const connectionStatusLine = document.getElementById('connection-status-line');
export const connectionSpinner = document.getElementById('connection-spinner');
export const connectionStatusText = document.getElementById('connection-status-text');
export const retryConnectionBtn = document.getElementById('retry-connection-btn'); // [新增]

// 【新增】搜索/下载结果列表元素
export const searchResultsContainer = document.getElementById('search-results-container');
export const searchResultsList = document.getElementById('search-results-list');

// --- [新增] 通用确认模态框元素 ---
export const confirmationModal = document.getElementById('confirmation-modal-overlay');
export const confirmationMessage = document.getElementById('confirmation-message');
export const confirmBtn = document.getElementById('confirm-btn');
export const cancelBtn = document.getElementById('cancel-btn');


// DOM Query/Creation Functions
export const getTemplateElementById = (id) => document.getElementById(id);
export const createFragment = () => document.createDocumentFragment();
export const createListItem = () => document.createElement('li');
export const getLyricLines = () => lyricsList.querySelectorAll('p');
export const getAllPlaylistItems = () => playlistEl.querySelectorAll('.playlist-item');
export const getContextMenuList = () => contextMenu.querySelector('ul');

// Fullscreen API wrappers
export const getFullscreenElement = () => document.fullscreenElement;
export const exitFullscreen = () => document.exitFullscreen();