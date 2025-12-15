// src/renderer/js/features/shortcuts.js

/**
 * @file 快捷键管理器 (Shortcut Manager)
 * @description
 * 负责处理所有全局快捷键的注册、监听和执行。
 * 采用命令模式将每个快捷键动作解耦为独立的对象，增强了可扩展性。
 * 同时处理了长按/短按的区分逻辑。
 *
 * 工作流程:
 * 1. 初始化时，为每个快捷键动作创建一个对应的命令(Command)实例，并存储在映射中。
 * 2. 监听全局键盘事件。
 * 3. 当检测到匹配的按键组合时，从映射中查找对应的命令对象。
 * 4. 调用该命令对象的 `execute()` 方法来执行操作。
 */

import * as dom from '../dom.js';
import { getters, mutations } from '../state.js';
import { defaultShortcuts } from '../config.js';
import { getTemplate, normalizeKey } from '../utils.js';
import * as ui from '../ui.js';
import { PLAY_MODES } from '../config.js';


// --- 配置与模块私有状态 ---
const LONG_PRESS_THRESHOLD = 250; // 长按检测阈值（毫秒）
const SEEK_STEP_SHORT = 10;       // 短媒体步进秒数
const SEEK_STEP_LONG = 30;        // 长媒体步进秒数
const LONG_PRESS_RATE = 4.0;      // 长按倍速

let longPressTimer = null;
let isLongPressActive = false;
let pressedShortcutKeys = new Set();


// =========================================================================
// --- 命令模式实现 (Command Pattern) ---
// =========================================================================

/**
 * @class Command
 * @description 命令的抽象基类（接口）。
 */
class Command {
    execute() { throw new Error("Command must implement execute method."); }
}

// --- 具体命令实现 ---
class TogglePlayCommand extends Command {
    execute() { mutations.togglePlayState(); }
}

class NextTrackCommand extends Command {
    execute() {
        // 播放下一首的逻辑现在集中在这里
        const playlist = getters.playlist();
        const playlistLength = playlist.length;
        if (playlistLength <= 1 && !getters.temporaryPlayingTrack()) return;

        // 如果当前是临时曲目，切换到播放列表的第一个
        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            if (playlistLength > 0) {
                mutations.setCurrentTrackIndex(0);
            }
            return;
        }

        let newIndex;
        const currentMode = PLAY_MODES[getters.currentModeIndex()];

        if (currentMode === 'shuffle') {
            do { newIndex = Math.floor(Math.random() * playlistLength); }
            while (playlistLength > 1 && newIndex === getters.currentTrackIndex());
        } else {
            newIndex = (getters.currentTrackIndex() + 1) % playlistLength;
        }
        mutations.setCurrentTrackIndex(newIndex);
    }
}

class PrevTrackCommand extends Command {
    execute() {
        const playlist = getters.playlist();
        const playlistLength = playlist.length;
        if (playlistLength <= 1 && !getters.temporaryPlayingTrack()) return;

        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            if (playlistLength > 0) {
                mutations.setCurrentTrackIndex(0);
            }
            return;
        }

        let newIndex;
        const currentMode = PLAY_MODES[getters.currentModeIndex()];
        if (currentMode === 'shuffle') {
            do { newIndex = Math.floor(Math.random() * playlistLength); }
            while (playlistLength > 1 && newIndex === getters.currentTrackIndex());
        } else {
            newIndex = (getters.currentTrackIndex() - 1 + playlistLength) % playlistLength;
        }
        mutations.setCurrentTrackIndex(newIndex);
    }
}

class SeekCommand extends Command {
    constructor(seconds) {
        super();
        this.seconds = seconds; // 正为快进，负为快退
    }
    execute() {
        const duration = getters.duration() || 0;
        const step = this.seconds * (duration > 600 ? SEEK_STEP_LONG / SEEK_STEP_SHORT : 1);
        const newTime = getters.currentTime() + step;

        // 请求 player 模块跳转
        const event = new CustomEvent('seekTo', { detail: newTime });
        window.dispatchEvent(event);

        ui.showSeekFeedback(step);
    }
}

class VolumeCommand extends Command {
    constructor(delta) {
        super();
        this.delta = delta; // 0.1 或 -0.1
    }
    execute() {
        const newVolume = getters.volume() + this.delta;
        mutations.setVolume(newVolume); // mutation 内部会处理边界值
    }
}

class SpeedCommand extends Command {
    constructor(delta) {
        super();
        this.delta = delta; // 0.1 或 -0.1
    }
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


// --- 命令注册表 ---
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
    'toggle-mute': new ToggleMuteCommand(),
    'toggle-lyrics': new ToggleLyricsCommand(),
    'toggle-playlist': new TogglePlaylistCommand(),
};


// =========================================================================
// --- 快捷键设置 UI 与逻辑 ---
// =========================================================================

function formatKeysToFragment(keys) {
    // ... (此函数与重构前相同)
    const fragment = document.createDocumentFragment();
    if (!keys || keys.length === 0) {
        fragment.appendChild(getTemplate('template-key-placeholder'));
        return fragment;
    }
    keys.forEach((key, index) => {
        const kbdNode = getTemplate('template-key-kbd');
        kbdNode.querySelector('kbd').textContent = key;
        fragment.appendChild(kbdNode);
        if (index < keys.length - 1) {
            fragment.appendChild(document.createTextNode(' + '));
        }
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
    const newSettings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
    mutations.setShortcutSettings(newSettings);
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
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
        stopRecording();
        return;
    }

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

/**
 * 执行快捷键对应的命令。
 * @param {string} actionId - 动作的唯一标识符。
 */
function executeShortcut(actionId) {
    const command = commandMap[actionId];
    if (command) {
        command.execute();
    }
}

function handleGlobalKeyDown(e) {
    if (e.repeat || getters.isRecordingShortcut() || ['input', 'textarea'].includes(e.target.tagName.toLowerCase()) || getters.playlist().length === 0) {
        return;
    }

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
                    dom.mediaPlayer.playbackRate = LONG_PRESS_RATE; // 直接操作DOM元素
                    ui.showSeekFeedback('倍速播放');
                }, LONG_PRESS_THRESHOLD);
            } else {
                executeShortcut(actionId);
            }
            break;
        }
    }
}

function handleGlobalKeyUp(e) {
    if (getters.isRecordingShortcut()) return;

    clearTimeout(longPressTimer);
    longPressTimer = null;
    const normalizedKey = normalizeKey(e.key);
    const settings = getters.shortcutSettings();

    const seekForwardKeys = new Set(settings['seek-forward'].keys);
    const seekBackwardKeys = new Set(settings['seek-backward'].keys);

    if (seekForwardKeys.has(normalizedKey) && [...seekForwardKeys].every(k => pressedShortcutKeys.has(k))) {
        if (isLongPressActive) {
            dom.mediaPlayer.playbackRate = getters.playbackRate(); // 恢复到状态中保存的速率
            ui.showSeekFeedback('恢复正常');
        } else {
            executeShortcut('seek-forward');
        }
    } else if (seekBackwardKeys.has(normalizedKey) && [...seekBackwardKeys].every(k => pressedShortcutKeys.has(k))) {
        if (isLongPressActive) {
            dom.mediaPlayer.playbackRate = getters.playbackRate();
            ui.showSeekFeedback('恢复正常');
        } else {
            executeShortcut('seek-backward');
        }
    }

    isLongPressActive = false;
    pressedShortcutKeys.delete(normalizedKey);
}

/**
 * 初始化所有与快捷键相关的事件监听器。
 */
export function setupShortcutListeners() {
    dom.shortcutListEl.addEventListener('click', (e) => {
        const target = e.target;
        const item = target.closest('.shortcut-item');
        if (!item) return;
        const actionId = item.dataset.action;
        if (target.classList.contains('set-btn')) startRecording(actionId);
        if (target.classList.contains('clear-btn')) {
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
        pressedShortcutKeys.clear();
        isLongPressActive = false;
        clearTimeout(longPressTimer);
        if (dom.mediaPlayer.playbackRate !== getters.playbackRate()) {
            dom.mediaPlayer.playbackRate = getters.playbackRate();
        }
    });
}