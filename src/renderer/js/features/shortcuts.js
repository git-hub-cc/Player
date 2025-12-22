// src/renderer/js/features/shortcuts.js

/**
 * @file 快捷键管理器 (Shortcut Manager)
 * @description
 * 负责处理所有全局快捷键的注册、监听和执行。
 * 包含冲突检测逻辑，防止组合键触发单键功能。
 */

import * as dom from '../dom.js';
import { getters, mutations } from '../state.js';
import { defaultShortcuts, PLAY_MODES, FILTER_MODES } from '../config.js';
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
// 用于倒带的定时器
let rewindInterval = null;


// =========================================================================
// --- 命令模式实现 (Command Pattern) ---
// =========================================================================

class Command {
    execute() { throw new Error("Command must implement execute method."); }
}

class TogglePlayCommand extends Command {
    execute() { mutations.togglePlayState(); }
}

/**
 * 辅助函数：根据当前过滤模式检查曲目是否应该播放。
 * @param {object} track - 轨道对象。
 * @returns {boolean}
 */
function isTrackPlayableInCurrentMode(track) {
    const mode = getters.mediaFilterMode();
    if (mode === FILTER_MODES.ALL) return true;
    if (mode === FILTER_MODES.AUDIO) return track.type !== 'video';
    if (mode === FILTER_MODES.VIDEO) return track.type === 'video';
    return true;
}

export class NextTrackCommand extends Command {
    execute() {
        const playlist = getters.playlist();
        const len = playlist.length;
        if (len === 0 && !getters.temporaryPlayingTrack()) return;

        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            // 如果有临时曲目，且播放列表非空，尝试从列表第一个开始播放（需符合过滤模式）
            if (len > 0) {
                // 这里复用下面的查找逻辑，假设当前索引为 -1
            } else {
                return;
            }
        }

        const currentMode = PLAY_MODES[getters.currentModeIndex()];
        let currentIndex = getters.currentTrackIndex();

        // 随机模式处理
        if (currentMode === 'shuffle') {
            // 先筛选出所有符合当前过滤模式的索引
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
                mutations.setCurrentTrackIndex(newIndex);
            }
            return;
        }

        // 顺序/列表循环/单曲循环模式 (手动切歌时单曲循环也切下一首)
        let searchIndex = (currentIndex + 1) % len;
        let foundIndex = -1;
        let loopCount = 0;

        // 循环查找下一个符合过滤条件的曲目
        while (loopCount < len) {
            if (isTrackPlayableInCurrentMode(playlist[searchIndex])) {
                foundIndex = searchIndex;
                break;
            }
            searchIndex = (searchIndex + 1) % len;
            loopCount++;
        }

        if (foundIndex !== -1) {
            mutations.setCurrentTrackIndex(foundIndex);
        } else {
            // 如果当前过滤模式下没有可播放的曲目，且当前曲目也不符合（或是临时播放），停止播放
            ui.showToast('当前过滤模式下无可播放曲目', 'info');
        }
    }
}

export class PrevTrackCommand extends Command {
    execute() {
        const playlist = getters.playlist();
        const len = playlist.length;
        if (len === 0 && !getters.temporaryPlayingTrack()) return;

        if (getters.temporaryPlayingTrack()) {
            mutations.clearPlayingTrackInfo();
            // 逻辑同 NextTrackCommand
        }

        const currentMode = PLAY_MODES[getters.currentModeIndex()];
        let currentIndex = getters.currentTrackIndex();

        // 随机模式处理
        if (currentMode === 'shuffle') {
            // 随机模式下上一首通常也是随机，这里直接复用下一首的随机逻辑
            new NextTrackCommand().execute();
            return;
        }

        // 顺序模式
        let searchIndex = (currentIndex - 1 + len) % len;
        let foundIndex = -1;
        let loopCount = 0;

        // 循环查找上一个符合过滤条件的曲目
        while (loopCount < len) {
            if (isTrackPlayableInCurrentMode(playlist[searchIndex])) {
                foundIndex = searchIndex;
                break;
            }
            searchIndex = (searchIndex - 1 + len) % len;
            loopCount++;
        }

        if (foundIndex !== -1) {
            mutations.setCurrentTrackIndex(foundIndex);
        } else {
            ui.showToast('当前过滤模式下无可播放曲目', 'info');
        }
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

class ResetSpeedCommand extends Command {
    execute() {
        mutations.setPlaybackRate(1.0);
        ui.showSpeedFeedback();
    }
}

class RotateCommand extends Command {
    constructor(degrees) { super(); this.degrees = degrees; }
    execute() {
        const currentRotation = getters.videoRotation();
        const newRotation = currentRotation + this.degrees;
        mutations.setVideoRotation(newRotation);

        let displayAngle = newRotation % 360;
        if (displayAngle < 0) displayAngle += 360;
        ui.showSeekFeedback(`旋转 ${displayAngle}°`);
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

class ToggleFullscreenCommand extends Command {
    execute() {
        if (!document.fullscreenElement) {
            // 尝试请求媒体播放器元素全屏（通常用于视频模式）
            dom.mediaPlayer?.requestFullscreen().catch(console.error);
        } else {
            // 退出全屏
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
    let settings;
    try {
        settings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
    } catch (e) {
        settings = JSON.parse(JSON.stringify(defaultShortcuts));
    }

    // 强制合并/更新旋转快捷键配置
    for (const [key, value] of Object.entries(defaultShortcuts)) {
        if (!settings[key] || key.startsWith('rotate-') || key === 'toggle-fullscreen') {
            settings[key] = value;
        }
    }

    mutations.setShortcutSettings(settings);
    // 可选：如果修改了配置，最好保存回去，保持同步
    saveShortcuts();
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

/**
 * 辅助函数：判断当前按下的键是否与所需键完全匹配。
 * @param {Set<string>} requiredKeys - 快捷键配置要求的键集合
 * @returns {boolean}
 */
function isExactKeyMatch(requiredKeys) {
    if (requiredKeys.size !== pressedShortcutKeys.size) return false;
    for (let key of requiredKeys) {
        if (!pressedShortcutKeys.has(key)) return false;
    }
    return true;
}

function handleGlobalKeyDown(e) {
    if (e.repeat || getters.isRecordingShortcut() || ['input', 'textarea'].includes(e.target.tagName.toLowerCase()) || getters.playlist().length === 0) return;
    pressedShortcutKeys.add(normalizeKey(e.key));
    const settings = getters.shortcutSettings();
    for (const actionId in settings) {
        const requiredKeys = new Set(settings[actionId].keys);

        if (requiredKeys.size > 0 && isExactKeyMatch(requiredKeys)) {
            e.preventDefault();

            // 处理长按逻辑
            if (actionId === 'seek-forward') {
                isLongPressActive = false;
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true;
                    dom.mediaPlayer.playbackRate = LONG_PRESS_RATE;
                    ui.showSeekFeedback('倍速播放');
                }, LONG_PRESS_THRESHOLD);
            } else if (actionId === 'seek-backward') {
                isLongPressActive = false;
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true;
                    if (rewindInterval) clearInterval(rewindInterval);
                    rewindInterval = setInterval(() => {
                        const step = LONG_PRESS_RATE * 0.05;
                        dom.mediaPlayer.currentTime = Math.max(0, dom.mediaPlayer.currentTime - step);
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
    if (getters.isRecordingShortcut()) return;
    clearTimeout(longPressTimer); longPressTimer = null;
    const normalizedKey = normalizeKey(e.key);

    const settings = getters.shortcutSettings();
    const seekForwardKeys = new Set(settings['seek-forward']?.keys || []);
    const seekBackwardKeys = new Set(settings['seek-backward']?.keys || []);

    if (seekForwardKeys.has(normalizedKey) && isExactKeyMatch(seekForwardKeys)) {
        if (isLongPressActive) {
            dom.mediaPlayer.playbackRate = getters.playbackRate();
            ui.showSeekFeedback('恢复正常');
        } else {
            executeShortcut('seek-forward');
        }
    } else if (seekBackwardKeys.has(normalizedKey) && isExactKeyMatch(seekBackwardKeys)) {
        if (isLongPressActive) {
            if (rewindInterval) {
                clearInterval(rewindInterval);
                rewindInterval = null;
            }
            ui.showSeekFeedback('恢复正常');
        } else {
            executeShortcut('seek-backward');
        }
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
        pressedShortcutKeys.clear();
        isLongPressActive = false;
        clearTimeout(longPressTimer);
        if (rewindInterval) {
            clearInterval(rewindInterval);
            rewindInterval = null;
        }
        if (dom.mediaPlayer.playbackRate !== getters.playbackRate()) dom.mediaPlayer.playbackRate = getters.playbackRate();
    });
}