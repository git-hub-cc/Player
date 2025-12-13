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

// =========================================================================
// 【新增】用于存储当前播放速率的状态变量
// =========================================================================
/**
 * @type {number} 当前的播放速率。1.0 为正常速度。
 */
export let playbackRate = 1.0;
// =========================================================================

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

/**
 * =========================================================================
 * 【核心修复】简化 removeTrack 函数的职责
 *
 * 1.  此函数现在只负责从播放列表数组中移除指定的项。
 * 2.  它会正确处理当被删除的曲目位于当前播放曲目之前时，对 `currentTrackIndex` 的递减操作。
 * 3.  **重要**: 它不再负责决定“删除当前曲目后应该播放哪一首”的复杂逻辑。
 *     这个职责已完全移交给 `renderer.js` 中的 `handleDeleteTrackRequest` 函数，
 *     使得状态变更的流程更清晰、更可控，从而修复了之前的 bug。
 * =========================================================================
 * @param {number} indexToRemove - 要从播放列表中移除的曲目的索引。
 */
export function removeTrack(indexToRemove) {
    if (indexToRemove < 0 || indexToRemove >= playlist.length) {
        // 如果索引无效，则不执行任何操作
        return;
    }

    // 从播放列表中移除曲目
    playlist.splice(indexToRemove, 1);

    // 如果删除的是当前播放曲目之前的曲目，需要更新当前索引以指向正确的曲目
    if (indexToRemove < currentTrackIndex) {
        currentTrackIndex--;
    }

    // 如果列表变为空，重置索引
    if (playlist.length === 0) {
        currentTrackIndex = -1;
    }
}


export function setCurrentTrackIndex(index) {
    // 如果索引未变且当前播放的不是临时曲目，则不执行任何操作
    if (currentTrackIndex === index && !temporaryPlayingTrack) {
        return;
    }
    // 设置新索引，并清除临时曲目信息，确保状态一致性
    currentTrackIndex = index;
    temporaryPlayingTrack = null;
}

export function setTemporaryPlayingTrack(track) {
    if (temporaryPlayingTrack === track) return;
    temporaryPlayingTrack = track;
    currentTrackIndex = -1; // 播放临时曲目时，取消播放列表的激活索引
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

// =========================================================================
// 【新增】用于更新播放速率状态的函数
// =========================================================================
export function setPlaybackRate(newRate) {
    playbackRate = newRate;
}
// =========================================================================

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