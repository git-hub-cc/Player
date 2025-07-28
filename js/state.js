// js/state.js

export let playlist = [];
export let currentTrackIndex = 0;
export let isPlaying = false;
export let parsedLyrics = [];
export let currentModeIndex = 0;
export let shortcutSettings = {};
export let pressedShortcutKeys = new Set();
export let isRecordingShortcut = false;
export let currentRecordingAction = null;

// Functions to modify state
export function setPlaylist(newPlaylist) {
    playlist = newPlaylist;
}
export function setCurrentTrackIndex(index) {
    currentTrackIndex = index;
}
export function setIsPlaying(playing) {
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