// js/state.js

import { mediaPlayer } from "./dom.js";

/**
 * @type {Array<Object>} 播放列表，包含所有媒体轨道对象。
 */
export let playlist = [];

/**
 * @type {number} 当前播放轨道在播放列表中的索引。
 */
export let currentTrackIndex = 0;

/**
 * @type {boolean} 播放器是否正在播放。
 */
export let isPlaying = false;

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

// --- State Modifying Functions ---

export function setPlaylist(newPlaylist) {
    playlist = newPlaylist;
}

/**
 * [新增] 从播放列表中移除一个曲目并智能调整当前播放索引。
 * @param {number} indexToRemove - 要移除的曲目的索引。
 */
export function removeTrack(indexToRemove) {
    if (indexToRemove < 0 || indexToRemove >= playlist.length) {
        return;
    }

    playlist.splice(indexToRemove, 1);

    if (playlist.length === 0) {
        currentTrackIndex = 0;
        return;
    }

    // 如果删除的是当前播放曲目之前的曲目，则将当前索引减一
    if (indexToRemove < currentTrackIndex) {
        currentTrackIndex--;
    }
    // 如果删除的是最后一个曲目，并且它也是当前播放的曲目，则将索引重置为0
    else if (indexToRemove === currentTrackIndex && currentTrackIndex >= playlist.length) {
        currentTrackIndex = 0;
    }
    // 其他情况（删除当前或之后的曲目），currentTrackIndex 保持不变或已在边界内，无需调整
    // (例如，删除当前曲目后，下一首会自动成为新的 currentTrackIndex)
}


export function setCurrentTrackIndex(index) {
    // 只有在索引真正改变时才更新，防止不必要的重渲染
    if (currentTrackIndex === index && mediaPlayer.src) return;
    currentTrackIndex = index;
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