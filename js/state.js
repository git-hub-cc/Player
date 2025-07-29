// js/state.js

import {mediaPlayer} from "./dom.js";

export let playlist = [];
export let currentTrackIndex = 0;
export let isPlaying = false;
export let parsedLyrics = [];
export let currentModeIndex = 0;
export let shortcutSettings = {};
export let pressedShortcutKeys = new Set();
export let isRecordingShortcut = false;
export let currentRecordingAction = null;

export let isDraggingLyrics = false;
// Functions to modify state
export function setPlaylist(newPlaylist) {
    playlist = newPlaylist;
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