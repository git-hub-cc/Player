// src/renderer/js/features/shortcuts.js

/**
 * @file 快捷键管理器 (Shortcut Manager)
 * @description
 * 负责处理所有全局快捷键的注册、监听和执行。
 * 采用命令模式将每个快捷键动作解耦为独立的对象，增强了可扩展性。
 */

import * as dom from '../dom.js';
import { getters, mutations } from '../state.js';
import { defaultShortcuts, PLAY_MODES } from '../config.js';
import { getTemplate, normalizeKey } from '../utils.js';
import * as ui from '../ui.js';


// --- 配置与模块私有状态 ---
const LONG_PRESS_THRESHOLD = 250;
const SEEK_STEP_SHORT = 10;
const SEEK_STEP_LONG = 30;
const LONG_PRESS_RATE = 4.0;

let longPressTimer = null;
let isLongPressActive = false;
let pressedShortcutKeys = new Set();


// =========================================================================
// --- 命令模式实现 (Command Pattern) ---
// =========================================================================

class Command {
    execute() { throw new Error("Command must implement execute method."); }
}

class TogglePlayCommand extends Command {
    execute() { mutations.togglePlayState(); }
}

export class NextTrackCommand extends Command { // Export for player.js
    execute() {
        const playlist = getters.playlist();
        const len = playlist.length;
        if (len === 0 && !getters.temporaryPlayingTrack()) return;
        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            if (len > 0) mutations.setCurrentTrackIndex(0);
            return;
        }
        const currentMode = PLAY_MODES[getters.currentModeIndex()];
        let newIndex;
        if (currentMode === 'shuffle') {
            do { newIndex = Math.floor(Math.random() * len); }
            while (len > 1 && newIndex === getters.currentTrackIndex());
        } else {
            newIndex = (getters.currentTrackIndex() + 1 + len) % len;
        }
        mutations.setCurrentTrackIndex(newIndex);
    }
}

export class PrevTrackCommand extends Command {
    execute() {
        const playlist = getters.playlist();
        const len = playlist.length;
        if (len === 0 && !getters.temporaryPlayingTrack()) return;
        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            if (len > 0) mutations.setCurrentTrackIndex(0);
            return;
        }
        const currentMode = PLAY_MODES[getters.currentModeIndex()];
        let newIndex;
        if (currentMode === 'shuffle') {
            do { newIndex = Math.floor(Math.random() * len); }
            while (len > 1 && newIndex === getters.currentTrackIndex());
        } else {
            newIndex = (getters.currentTrackIndex() - 1 + len) % len;
        }
        mutations.setCurrentTrackIndex(newIndex);
    }
}

class SeekCommand extends Command {
    constructor(seconds) { super(); this.seconds = seconds; }
    execute() {
        const duration = getters.duration() || 0;
        const step = this.seconds * (duration > 600 ? SEEK_STEP_LONG / SEEK_STEP_SHORT : 1);
        const newTime = getters.currentTime() + step;
        window.dispatchEvent(new CustomEvent('seekTo', { detail: newTime }));
        ui.showSeekFeedback(step);
    }
}

class VolumeCommand extends Command {
    constructor(delta) { super(); this.delta = delta; }
    execute() { mutations.setVolume(getters.volume() + this.delta); }
}

class SpeedCommand extends Command {
    constructor(delta) { super(); this.delta = delta; }
    execute() {
        const newRate = parseFloat((getters.playbackRate() + this.delta).toFixed(1));
        mutations.setPlaybackRate(newRate);
        ui.showSpeedFeedback();
    }
}

class ToggleMuteCommand extends Command {
    execute() { mutations.setIsMuted(!getters.isMuted()); }
}

class ToggleLyricsCommand extends Command {
    execute() { ui.toggleLyricsPanel(); }
}

class TogglePlaylistCommand extends Command {
    execute() { ui.togglePlaylistPanel(); }
}

const commandMap = {
    'toggle-play': new TogglePlayCommand(), 'next-track': new NextTrackCommand(),
    'prev-track': new PrevTrackCommand(), 'seek-forward': new SeekCommand(SEEK_STEP_SHORT),
    'seek-backward': new SeekCommand(-SEEK_STEP_SHORT), 'volume-up': new VolumeCommand(0.1),
    'volume-down': new VolumeCommand(-0.1), 'speed-up': new SpeedCommand(0.1),
    'speed-down': new SpeedCommand(-0.1), 'toggle-mute': new ToggleMuteCommand(),
    'toggle-lyrics': new ToggleLyricsCommand(), 'toggle-playlist': new TogglePlaylistCommand(),
};

// =========================================================================
// --- 快捷键设置 UI 与逻辑 ---
// =========================================================================

function formatKeysToFragment(keys) {
    const fragment = document.createDocumentFragment();
    if (!keys || keys.length === 0) {
        fragment.appendChild(getTemplate('template-key-placeholder'));
        return fragment;
    }
    keys.forEach((key, index) => {
        const kbdNode = getTemplate('template-key-kbd');
        kbdNode.querySelector('kbd').textContent = key;
        fragment.appendChild(kbdNode);
        if (index < keys.length - 1) fragment.appendChild(document.createTextNode(' + '));
    });
    return fragment;
}

function renderShortcutList() {
    dom.shortcutListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const settings = getters.shortcutSettings();
    for (const actionId in settings) {
        const setting = settings[actionId];
        const itemNode = getTemplate('template-shortcut-item');
        const itemEl = itemNode.querySelector('.shortcut-item');
        itemEl.dataset.action = actionId;
        itemEl.querySelector('.action-label').textContent = setting.label;
        const shortcutDisplay = itemEl.querySelector('.shortcut-display');
        shortcutDisplay.innerHTML = '';
        shortcutDisplay.appendChild(formatKeysToFragment(setting.keys));
        fragment.appendChild(itemNode);
    }
    dom.shortcutListEl.appendChild(fragment);
}

function saveShortcuts() {
    localStorage.setItem('player-shortcuts', JSON.stringify(getters.shortcutSettings()));
}

export function loadShortcuts() {
    const saved = localStorage.getItem('player-shortcuts');
    try {
        const newSettings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
        mutations.setShortcutSettings(newSettings);
    } catch (e) {
        mutations.setShortcutSettings(JSON.parse(JSON.stringify(defaultShortcuts)));
    }
    renderShortcutList();
}

function startRecording(actionId) {
    mutations.setCurrentRecordingAction(actionId);
    mutations.setIsRecordingShortcut(true);
    pressedShortcutKeys.clear();
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(getTemplate('template-recording-placeholder'));
    dom.shortcutModalOverlayEl.classList.add('visible');
    window.addEventListener('keydown', handleShortcutKeyDownForRecording);
    window.addEventListener('keyup', handleShortcutKeyUpForRecording);
}

function stopRecording() {
    mutations.setIsRecordingShortcut(false);
    mutations.setCurrentRecordingAction(null);
    pressedShortcutKeys.clear();
    dom.shortcutModalOverlayEl.classList.remove('visible');
    window.removeEventListener('keydown', handleShortcutKeyDownForRecording);
    window.removeEventListener('keyup', handleShortcutKeyUpForRecording);
}

function handleShortcutKeyDownForRecording(e) {
    if (!getters.isRecordingShortcut()) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(); return; }
    pressedShortcutKeys.add(normalizeKey(e.key));
    const keysFragment = formatKeysToFragment(Array.from(pressedShortcutKeys));
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(keysFragment);
}

function handleShortcutKeyUpForRecording(e) {
    if (!getters.isRecordingShortcut() || pressedShortcutKeys.size === 0) return;
    const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    const hasNonModifierKey = Array.from(pressedShortcutKeys).some(k => !modifierKeys.includes(k));
    if (hasNonModifierKey) {
        const newSettings = { ...getters.shortcutSettings() };
        newSettings[getters.currentRecordingAction()].keys = Array.from(pressedShortcutKeys);
        mutations.setShortcutSettings(newSettings);
        saveShortcuts();
        stopRecording();
        renderShortcutList();
    }
}

// =========================================================================
// --- 全局事件监听与执行 ---
// =========================================================================

function executeShortcut(actionId) {
    const command = commandMap[actionId];
    if (command) command.execute();
}

function handleGlobalKeyDown(e) {
    if (e.repeat || getters.isRecordingShortcut() || ['input', 'textarea'].includes(e.target.tagName.toLowerCase()) || getters.playlist().length === 0) return;
    pressedShortcutKeys.add(normalizeKey(e.key));
    const settings = getters.shortcutSettings();
    for (const actionId in settings) {
        const requiredKeys = new Set(settings[actionId].keys);
        if (requiredKeys.size > 0 && requiredKeys.size === pressedShortcutKeys.size && [...requiredKeys].every(key => pressedShortcutKeys.has(key))) {
            e.preventDefault();
            if (actionId === 'seek-forward' || actionId === 'seek-backward') {
                isLongPressActive = false;
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true;
                    dom.mediaPlayer.playbackRate = LONG_PRESS_RATE;
                    ui.showSeekFeedback('倍速播放');
                }, LONG_PRESS_THRESHOLD);
            } else { executeShortcut(actionId); }
            break;
        }
    }
}

function handleGlobalKeyUp(e) {
    if (getters.isRecordingShortcut()) return;
    clearTimeout(longPressTimer); longPressTimer = null;
    const normalizedKey = normalizeKey(e.key);
    const settings = getters.shortcutSettings();
    const seekForwardKeys = new Set(settings['seek-forward']?.keys || []);
    const seekBackwardKeys = new Set(settings['seek-backward']?.keys || []);
    if (seekForwardKeys.has(normalizedKey) && [...seekForwardKeys].every(k => pressedShortcutKeys.has(k))) {
        if (isLongPressActive) {
            dom.mediaPlayer.playbackRate = getters.playbackRate();
            ui.showSeekFeedback('恢复正常');
        } else { executeShortcut('seek-forward'); }
    } else if (seekBackwardKeys.has(normalizedKey) && [...seekBackwardKeys].every(k => pressedShortcutKeys.has(k))) {
        if (isLongPressActive) {
            dom.mediaPlayer.playbackRate = getters.playbackRate();
            ui.showSeekFeedback('恢复正常');
        } else { executeShortcut('seek-backward'); }
    }
    isLongPressActive = false;
    pressedShortcutKeys.delete(normalizedKey);
}

export function setupShortcutListeners() {
    dom.shortcutListEl.addEventListener('click', (e) => {
        const item = e.target.closest('.shortcut-item');
        if (!item) return;
        const actionId = item.dataset.action;
        if (e.target.classList.contains('set-btn')) startRecording(actionId);
        if (e.target.classList.contains('clear-btn')) {
            const newSettings = { ...getters.shortcutSettings() };
            newSettings[actionId].keys = [];
            mutations.setShortcutSettings(newSettings);
            saveShortcuts();
            renderShortcutList();
        }
    });
    dom.shortcutModalOverlayEl.addEventListener('click', (e) => {
        if (e.target === dom.shortcutModalOverlayEl) stopRecording();
    });
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('keyup', handleGlobalKeyUp);
    window.addEventListener('blur', () => {
        pressedShortcutKeys.clear(); isLongPressActive = false; clearTimeout(longPressTimer);
        if (dom.mediaPlayer.playbackRate !== getters.playbackRate()) dom.mediaPlayer.playbackRate = getters.playbackRate();
    });
}