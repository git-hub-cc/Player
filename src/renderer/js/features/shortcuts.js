// src/renderer/js/features/shortcuts.js
// REFACTORED: Now uses Pinia stores instead of state.js / dom.js / ui.js

/**
 * @file 快捷键管理器 (Shortcut Manager) — Vue/Pinia 版本
 */

import { usePlayerStore } from '../../stores/playerStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { defaultShortcuts, PLAY_MODES, FILTER_MODES } from '../config.js';
import { normalizeKey } from '../utils.js';
import { getMediaElement } from '../../composables/usePlayer.js';

const LONG_PRESS_THRESHOLD = 250;
const SEEK_STEP_SHORT = 10;
const SEEK_STEP_LONG = 30;
const LONG_PRESS_RATE = 8.0;

let longPressTimer = null;
let isLongPressActive = false;
let pressedShortcutKeys = new Set();
let activeSeekAction = null;
let rewindInterval = null;

// =========================================================================
// --- 命令模式实现 ---
// =========================================================================

class Command {
    execute() { throw new Error('Command must implement execute method.'); }
}

function isTrackPlayableInCurrentMode(track) {
    const store = usePlayerStore();
    const mode = store.mediaFilterMode;
    if (mode === FILTER_MODES.ALL) return true;
    if (mode === FILTER_MODES.AUDIO) return track.type !== 'video';
    if (mode === FILTER_MODES.VIDEO) return track.type === 'video';
    return true;
}

class TogglePlayCommand extends Command {
    execute() { usePlayerStore().togglePlayState(); }
}

export class NextTrackCommand extends Command {
    execute() {
        const store = usePlayerStore();
        const ui = useUiStore();
        const playlist = store.playlist;
        const len = playlist.length;
        if (len === 0 && !store.temporaryPlayingTrack) return;

        if (store.temporaryPlayingTrack) {
            store.clearPlayingTrackInfo();
            if (len === 0) return;
        }

        const currentMode = PLAY_MODES[store.currentModeIndex];
        let currentIndex = store.currentTrackIndex;

        if (currentMode === 'shuffle') {
            const validIndices = playlist
                .map((track, idx) => ({ track, idx }))
                .filter(({ track }) => isTrackPlayableInCurrentMode(track))
                .map(({ idx }) => idx);
            if (validIndices.length > 0) {
                let newIndex;
                do {
                    const randPos = Math.floor(Math.random() * validIndices.length);
                    newIndex = validIndices[randPos];
                } while (validIndices.length > 1 && newIndex === currentIndex);
                store.setCurrentTrackIndex(newIndex);
            }
            return;
        }

        let searchIndex = (currentIndex + 1) % len;
        let foundIndex = -1;
        let loopCount = 0;
        while (loopCount < len) {
            if (isTrackPlayableInCurrentMode(playlist[searchIndex])) {
                foundIndex = searchIndex;
                break;
            }
            searchIndex = (searchIndex + 1) % len;
            loopCount++;
        }

        if (foundIndex !== -1) {
            store.setCurrentTrackIndex(foundIndex);
        } else {
            ui.showToast('当前过滤模式下无可播放曲目', 'info');
        }
    }
}

export class PrevTrackCommand extends Command {
    execute() {
        const store = usePlayerStore();
        const ui = useUiStore();
        const playlist = store.playlist;
        const len = playlist.length;
        if (len === 0 && !store.temporaryPlayingTrack) return;

        if (store.temporaryPlayingTrack) {
            store.clearPlayingTrackInfo();
        }

        const currentMode = PLAY_MODES[store.currentModeIndex];
        if (currentMode === 'shuffle') { new NextTrackCommand().execute(); return; }

        let currentIndex = store.currentTrackIndex;
        let searchIndex = (currentIndex - 1 + len) % len;
        let foundIndex = -1;
        let loopCount = 0;
        while (loopCount < len) {
            if (isTrackPlayableInCurrentMode(playlist[searchIndex])) {
                foundIndex = searchIndex;
                break;
            }
            searchIndex = (searchIndex - 1 + len) % len;
            loopCount++;
        }

        if (foundIndex !== -1) {
            store.setCurrentTrackIndex(foundIndex);
        } else {
            ui.showToast('当前过滤模式下无可播放曲目', 'info');
        }
    }
}

class SeekCommand extends Command {
    constructor(seconds) { super(); this.seconds = seconds; }
    execute() {
        const store = usePlayerStore();
        const ui = useUiStore();
        const duration = store.duration || 0;
        const step = this.seconds * (duration > 600 ? SEEK_STEP_LONG / SEEK_STEP_SHORT : 1);
        const newTime = store.currentTime + step;
        window.dispatchEvent(new CustomEvent('seekTo', { detail: newTime }));
        ui.showSeekFeedback(step > 0 ? `+${Math.round(step)}s` : `${Math.round(step)}s`);
    }
}

class VolumeCommand extends Command {
    constructor(delta) { super(); this.delta = delta; }
    execute() { usePlayerStore().setVolume(usePlayerStore().volume + this.delta); }
}

class SpeedCommand extends Command {
    constructor(delta) { super(); this.delta = delta; }
    execute() {
        const store = usePlayerStore();
        const ui = useUiStore();
        const newRate = parseFloat((store.playbackRate + this.delta).toFixed(1));
        store.setPlaybackRate(newRate);
        ui.showSpeedFeedback(`${newRate}x`);
    }
}

class ResetSpeedCommand extends Command {
    execute() {
        usePlayerStore().setPlaybackRate(1.0);
        useUiStore().showSpeedFeedback('1.0x');
    }
}

class RotateCommand extends Command {
    constructor(degrees) { super(); this.degrees = degrees; }
    execute() {
        const store = usePlayerStore();
        const ui = useUiStore();
        const newRotation = store.videoRotation + this.degrees;
        store.setVideoRotation(newRotation);
        let displayAngle = newRotation % 360;
        if (displayAngle < 0) displayAngle += 360;
        ui.showSeekFeedback(`旋转 ${displayAngle}°`);
    }
}

class ToggleMuteCommand extends Command {
    execute() { const s = usePlayerStore(); s.setIsMuted(!s.isMuted); }
}

class ToggleLyricsCommand extends Command {
    execute() { useUiStore().toggleLyricsPanel(); }
}

class TogglePlaylistCommand extends Command {
    execute() { useUiStore().togglePanel('playlist'); }
}

class ToggleFullscreenCommand extends Command {
    execute() {
        const mediaEl = getMediaElement();
        if (!document.fullscreenElement) {
            mediaEl?.requestFullscreen().catch(console.error);
        } else {
            document.exitFullscreen();
        }
    }
}

const commandMap = {
    'toggle-play': new TogglePlayCommand(),
    'next-track': new NextTrackCommand(),
    'prev-track': new PrevTrackCommand(),
    'seek-forward': new SeekCommand(SEEK_STEP_SHORT),
    'seek-backward': new SeekCommand(-SEEK_STEP_SHORT),
    'volume-up': new VolumeCommand(0.1),
    'volume-down': new VolumeCommand(-0.1),
    'speed-up': new SpeedCommand(0.1),
    'speed-down': new SpeedCommand(-0.1),
    'speed-reset': new ResetSpeedCommand(),
    'rotate-cw': new RotateCommand(90),
    'rotate-ccw': new RotateCommand(-90),
    'toggle-mute': new ToggleMuteCommand(),
    'toggle-lyrics': new ToggleLyricsCommand(),
    'toggle-playlist': new TogglePlaylistCommand(),
    'toggle-fullscreen': new ToggleFullscreenCommand(),
};

// =========================================================================
// --- 快捷键设置的持久化与加载 ---
// =========================================================================

function saveShortcuts() {
    localStorage.setItem('player-shortcuts', JSON.stringify(usePlayerStore().shortcutSettings));
}

export function loadShortcuts() {
    const store = usePlayerStore();
    const saved = localStorage.getItem('player-shortcuts');
    let settings;
    try {
        settings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
    } catch {
        settings = JSON.parse(JSON.stringify(defaultShortcuts));
    }
    // 强制合并新增快捷键
    for (const [key, value] of Object.entries(defaultShortcuts)) {
        if (!settings[key] || key.startsWith('rotate-') || key === 'toggle-fullscreen') {
            settings[key] = value;
        }
    }
    store.setShortcutSettings(settings);
    saveShortcuts();
}

// =========================================================================
// --- 快捷键录制 ---
// =========================================================================

function startRecording(actionId) {
    const store = usePlayerStore();
    const ui = useUiStore();
    store.setCurrentRecordingAction(actionId);
    store.setIsRecordingShortcut(true);
    pressedShortcutKeys.clear();
    ui.showShortcutModal();
    ui.setShortcutKeyPreview('');
    window.addEventListener('keydown', handleShortcutKeyDownForRecording);
    window.addEventListener('keyup', handleShortcutKeyUpForRecording);
}

function stopRecording() {
    const store = usePlayerStore();
    const ui = useUiStore();
    store.setIsRecordingShortcut(false);
    store.setCurrentRecordingAction(null);
    pressedShortcutKeys.clear();
    ui.hideShortcutModal();
    window.removeEventListener('keydown', handleShortcutKeyDownForRecording);
    window.removeEventListener('keyup', handleShortcutKeyUpForRecording);
}

function handleShortcutKeyDownForRecording(e) {
    const store = usePlayerStore();
    const ui = useUiStore();
    if (!store.isRecordingShortcut) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(); return; }
    pressedShortcutKeys.add(normalizeKey(e.key));
    ui.setShortcutKeyPreview(Array.from(pressedShortcutKeys).join(' + '));
}

function handleShortcutKeyUpForRecording(e) {
    const store = usePlayerStore();
    const ui = useUiStore();
    if (!store.isRecordingShortcut || pressedShortcutKeys.size === 0) return;
    const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    const hasNonModifierKey = Array.from(pressedShortcutKeys).some(k => !modifierKeys.includes(k));
    if (hasNonModifierKey) {
        const newSettings = { ...store.shortcutSettings };
        newSettings[store.currentRecordingAction].keys = Array.from(pressedShortcutKeys);
        store.setShortcutSettings(newSettings);
        saveShortcuts();
        stopRecording();
    }
}

// =========================================================================
// --- 全局快捷键监听 ---
// =========================================================================

function isExactKeyMatch(requiredKeys) {
    if (requiredKeys.size !== pressedShortcutKeys.size) return false;
    for (let key of requiredKeys) {
        if (!pressedShortcutKeys.has(key)) return false;
    }
    return true;
}

function executeShortcut(actionId) {
    const command = commandMap[actionId];
    if (command) command.execute();
}

function handleGlobalKeyDown(e) {
    const store = usePlayerStore();
    const ui = useUiStore();
    if (e.repeat || store.isRecordingShortcut ||
        ['input', 'textarea'].includes(e.target.tagName.toLowerCase()) ||
        store.playlist.length === 0) return;

    pressedShortcutKeys.add(normalizeKey(e.key));
    const settings = store.shortcutSettings;

    for (const actionId in settings) {
        const requiredKeys = new Set(settings[actionId].keys);
        if (requiredKeys.size > 0 && isExactKeyMatch(requiredKeys)) {
            e.preventDefault();

            if (actionId === 'seek-forward' || actionId === 'seek-backward') {
                activeSeekAction = actionId;
            } else {
                activeSeekAction = null;
            }

            if (actionId === 'seek-forward') {
                isLongPressActive = false;
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true;
                    const mediaEl = getMediaElement();
                    if (mediaEl) mediaEl.playbackRate = LONG_PRESS_RATE;
                    ui.showSeekFeedback('倍速播放');
                }, LONG_PRESS_THRESHOLD);
            } else if (actionId === 'seek-backward') {
                isLongPressActive = false;
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true;
                    if (rewindInterval) clearInterval(rewindInterval);
                    const mediaEl = getMediaElement();
                    rewindInterval = setInterval(() => {
                        const step = LONG_PRESS_RATE * 0.05;
                        if (mediaEl) mediaEl.currentTime = Math.max(0, mediaEl.currentTime - step);
                    }, 50);
                    ui.showSeekFeedback('<< 倒带');
                }, LONG_PRESS_THRESHOLD);
            } else {
                executeShortcut(actionId);
            }
            break;
        }
    }
}

function handleGlobalKeyUp(e) {
    const store = usePlayerStore();
    const ui = useUiStore();
    if (store.isRecordingShortcut) return;

    clearTimeout(longPressTimer);
    longPressTimer = null;
    const normalizedKey = normalizeKey(e.key);
    const settings = store.shortcutSettings;

    if (activeSeekAction) {
        const requiredKeys = new Set(settings[activeSeekAction]?.keys || []);
        if (requiredKeys.has(normalizedKey)) {
            if (isLongPressActive) {
                if (activeSeekAction === 'seek-backward') {
                    if (rewindInterval) { clearInterval(rewindInterval); rewindInterval = null; }
                } else {
                    const mediaEl = getMediaElement();
                    if (mediaEl) mediaEl.playbackRate = store.playbackRate;
                }
                ui.showSeekFeedback('恢复正常');
            } else {
                executeShortcut(activeSeekAction);
            }
            activeSeekAction = null;
        }
    }

    isLongPressActive = false;
    pressedShortcutKeys.delete(normalizedKey);
}

/**
 * 设置快捷键面板的事件监听（由 ShortcutPanel 组件调用）
 * @param {string} actionId
 * @param {'set'|'clear'} action
 */
export function handleShortcutPanelAction(actionId, action) {
    if (action === 'set') {
        startRecording(actionId);
    } else if (action === 'clear') {
        const store = usePlayerStore();
        const newSettings = { ...store.shortcutSettings };
        newSettings[actionId].keys = [];
        store.setShortcutSettings(newSettings);
        saveShortcuts();
    }
}

export function setupShortcutListeners() {
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('keyup', handleGlobalKeyUp);
    window.addEventListener('blur', () => {
        const store = usePlayerStore();
        pressedShortcutKeys.clear();
        isLongPressActive = false;
        activeSeekAction = null;
        clearTimeout(longPressTimer);
        if (rewindInterval) { clearInterval(rewindInterval); rewindInterval = null; }
        const mediaEl = getMediaElement();
        if (mediaEl && mediaEl.playbackRate !== store.playbackRate) {
            mediaEl.playbackRate = store.playbackRate;
        }
    });
}