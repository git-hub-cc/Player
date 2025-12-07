// js/state.js

/**
 * @type {Array<Object>} 播放列表，包含所有媒体轨道对象。
 */
export let playlist = [];

/**
 * @type {number} 当前播放轨道在播放列表中的索引。-1 表示没有来自播放列表的曲目被激活。
 */
export let currentTrackIndex = -1;

/**
 * @type {boolean} 播放器是否正在播放。
 */
export let isPlaying = false;

/**
 * @type {Object|null} 记录当前正在播放的临时（在线）曲目对象。如果为 null，表示当前播放的是播放列表中的曲目。
 */
export let temporaryPlayingTrack = null;

/**
 * @type {Array<{time: number, text: string}>} 当前已解析的歌词数组。
 */
export let parsedLyrics = [];

/**
 * @type {number} 当前播放模式的索引 (0: list, 1: single, 2: shuffle)。
 */
export let currentModeIndex = 0;

/**
 * @type {Object} 用户的快捷键设置。
 */
export let shortcutSettings = {};

/**
 * @type {Set<string>} 当前按下的快捷键集合。
 */
export let pressedShortcutKeys = new Set();

/**
 * @type {boolean} 是否正在录制新的快捷键。
 */
export let isRecordingShortcut = false;

/**
 * @type {string|null} 正在录制快捷键的目标动作ID。
 */
export let currentRecordingAction = null;

/**
 * @type {boolean} 用户是否正在拖动歌词。
 */
export let isDraggingLyrics = false;

/**
 * @type {boolean} 用户是否正在拖动进度条。
 */
export let isScrubbing = false;

/**
 * @type {number} 当前音频使用的颜色调色板索引。
 */
export let currentColorPaletteIndex = 0;

/**
 * @type {AudioContext|null} Web Audio API 的音频上下文。
 */
export let audioContext = null;

/**
 * @type {MediaElementAudioSourceNode|null} 连接到媒体元素的音频源节点。
 */
export let audioSource = null;

/**
 * @type {AnalyserNode|null} 用于音频可视化的分析器节点。
 */
export let analyser = null;

/**
 * @type {Array<Array<number>>|null} 存储当前背景的基色 [[r,g,b], [r,g,b]]
 */
export let currentGradientColors = null;

/**
 * @type {boolean} 是否处于演示/屏保模式。
 */
export let isScreensaverMode = false;


// --- State Modifying Functions ---

export function setPlaylist(newPlaylist) {
    playlist = newPlaylist;
}

export function removeTrack(indexToRemove) {
    if (indexToRemove < 0 || indexToRemove >= playlist.length) {
        return;
    }

    playlist.splice(indexToRemove, 1);

    if (playlist.length === 0) {
        currentTrackIndex = -1;
        return;
    }

    if (indexToRemove < currentTrackIndex) {
        currentTrackIndex--;
    }
    else if (indexToRemove === currentTrackIndex && currentTrackIndex >= playlist.length) {
        currentTrackIndex = 0;
    }
}

export function setCurrentTrackIndex(index) {
    if (currentTrackIndex === index && !temporaryPlayingTrack) {
        return;
    }
    currentTrackIndex = index;
    temporaryPlayingTrack = null;
}

export function setTemporaryPlayingTrack(track) {
    if (temporaryPlayingTrack === track) return;
    temporaryPlayingTrack = track;
    currentTrackIndex = -1;
}

export function clearPlayingTrackInfo() {
    temporaryPlayingTrack = null;
    currentTrackIndex = -1;
}

export function setIsPlaying(playing) {
    if (isPlaying === playing) return;
    isPlaying = playing;
}

export function setParsedLyrics(lyrics) {
    parsedLyrics = lyrics;
}

export function setCurrentModeIndex(index) {
    currentModeIndex = index;
}

export function setShortcutSettings(settings) {
    shortcutSettings = settings;
}
export function setIsRecordingShortcut(recording) {
    isRecordingShortcut = recording;
}
export function setCurrentRecordingAction(action) {
    currentRecordingAction = action;
}

export function setIsDraggingLyrics(dragging) {
    isDraggingLyrics = dragging;
}

export function setIsScrubbing(scrubbing) {
    isScrubbing = scrubbing;
}

export function setCurrentColorPaletteIndex(index) {
    currentColorPaletteIndex = index;
}

export function setAudioContext(context) {
    audioContext = context;
}
export function setAudioSource(source) {
    audioSource = source;
}
export function setAnalyser(analyserNode) {
    analyser = analyserNode;
}

export function setCurrentGradientColors(colors) {
    currentGradientColors = colors;
}

export function setScreensaverMode(value) {
    if (isScreensaverMode === value) return;
    isScreensaverMode = value;
}
