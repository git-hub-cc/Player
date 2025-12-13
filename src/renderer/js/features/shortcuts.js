// js/features/shortcuts.js

import * as dom from '../dom.js';
import * as state from '../state.js';
import { defaultShortcuts } from '../config.js';
import { getTemplate, normalizeKey } from '../utils.js';
import { togglePlayPause, playNextTrack, playPrevTrack, seek, setTemporaryPlaybackRate, restorePlaybackRate } from '../player.js';
import { toggleLyricsPanel, togglePlaylistPanel, updateVolumeBarVisual, showSeekFeedback } from '../ui.js';

// =========================================================================
// 【核心修改】引入长按检测机制所需的状态变量
// =========================================================================
const LONG_PRESS_THRESHOLD = 250; // 长按阈值 (毫秒)
const SEEK_STEP_SHORT = 10; // 短按跳转秒数 (短视频/音频)
const SEEK_STEP_LONG = 30; // 短按跳转秒数 (长视频)
const LONG_PRESS_RATE = 4.0; // 长按倍速

let longPressTimer = null; // 用于检测长按的计时器
let isLongPressActive = false; // 标记长按行为是否已触发
const activeKeys = new Map(); // 存储当前按下的键及其状态
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
        if (index < keys.length - 1) {
            fragment.appendChild(document.createTextNode(' + '));
        }
    });
    return fragment;
}

function renderShortcutList() {
    dom.shortcutListEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const actionId in state.shortcutSettings) {
        const setting = state.shortcutSettings[actionId];
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
    localStorage.setItem('player-shortcuts', JSON.stringify(state.shortcutSettings));
}

export function loadShortcuts() {
    const saved = localStorage.getItem('player-shortcuts');
    const newSettings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
    state.setShortcutSettings(newSettings);
    renderShortcutList();
}

function startRecording(actionId) {
    state.setCurrentRecordingAction(actionId);
    state.setIsRecordingShortcut(true);
    state.pressedShortcutKeys.clear();
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(getTemplate('template-recording-placeholder'));
    dom.shortcutModalOverlayEl.classList.add('visible');
    window.addEventListener('keydown', handleShortcutKeyDownForRecording);
    window.addEventListener('keyup', handleShortcutKeyUpForRecording);
}

function stopRecording() {
    state.setIsRecordingShortcut(false);
    state.setCurrentRecordingAction(null);
    state.pressedShortcutKeys.clear();
    dom.shortcutModalOverlayEl.classList.remove('visible');
    window.removeEventListener('keydown', handleShortcutKeyDownForRecording);
    window.removeEventListener('keyup', handleShortcutKeyUpForRecording);
}

function handleShortcutKeyDownForRecording(e) {
    if (!state.isRecordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
        stopRecording();
        return;
    }
    state.pressedShortcutKeys.add(normalizeKey(e.key));
    const keysFragment = formatKeysToFragment(Array.from(state.pressedShortcutKeys));
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(keysFragment);
}

function handleShortcutKeyUpForRecording(e) {
    if (!state.isRecordingShortcut || state.pressedShortcutKeys.size === 0) return;
    const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    const hasNonModifierKey = Array.from(state.pressedShortcutKeys).some(k => !modifierKeys.includes(k));

    if (hasNonModifierKey) {
        state.shortcutSettings[state.currentRecordingAction].keys = Array.from(state.pressedShortcutKeys);
        saveShortcuts();
        stopRecording();
        renderShortcutList();
    }
}

/**
 * 执行快捷键对应的具体操作。
 * @param {string} actionId - 动作的唯一标识符。
 */
export function executeShortcut(actionId) {
    switch (actionId) {
        case 'toggle-play':
            togglePlayPause();
            break;
        case 'next-track':
            playNextTrack();
            break;
        case 'prev-track':
            playPrevTrack();
            break;
        case 'seek-forward': // 短按时触发
        {
            const step = (dom.mediaPlayer.duration || 0) > 600 ? SEEK_STEP_LONG : SEEK_STEP_SHORT;
            seek(step);
            showSeekFeedback(step);
        }
            break;
        case 'seek-backward': // 短按时触发
        {
            const step = (dom.mediaPlayer.duration || 0) > 600 ? SEEK_STEP_LONG : SEEK_STEP_SHORT;
            seek(-step);
            showSeekFeedback(-step);
        }
            break;
        case 'volume-up':
            dom.mediaPlayer.volume = Math.min(1, dom.mediaPlayer.volume + 0.1);
            updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
            break;
        case 'volume-down':
            dom.mediaPlayer.volume = Math.max(0, dom.mediaPlayer.volume - 0.1);
            updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
            break;
        case 'toggle-mute':
            dom.volumeBtn.click();
            break;
        case 'toggle-lyrics':
            toggleLyricsPanel();
            break;
        case 'toggle-playlist':
            togglePlaylistPanel();
            break;
    }
}

/**
 * =========================================================================
 * 【核心重构】新的快捷键事件监听逻辑，支持长按/短按区分
 * =========================================================================
 */
function handleGlobalKeyDown(e) {
    // 如果正在录制快捷键或焦点在输入框，则忽略
    if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) {
        return;
    }
    // 如果播放列表为空，则忽略
    if (state.playlist.length === 0) {
        return;
    }
    // 如果按键已经按下（系统触发的 repeat 事件），则忽略
    if (activeKeys.has(e.key)) {
        return;
    }

    const normalizedKey = normalizeKey(e.key);
    state.pressedShortcutKeys.add(normalizedKey);
    activeKeys.set(e.key, true);

    // 查找匹配的快捷键动作
    for (const actionId in state.shortcutSettings) {
        const setting = state.shortcutSettings[actionId];
        const requiredKeys = new Set(setting.keys);

        // 检查当前按下的键是否完全匹配某个快捷键组合
        if (requiredKeys.size > 0 && requiredKeys.size === state.pressedShortcutKeys.size &&
            [...requiredKeys].every(key => state.pressedShortcutKeys.has(key))) {

            e.preventDefault();

            // 如果是快进/快退键，则启动长按检测
            if (actionId === 'seek-forward' || actionId === 'seek-backward') {
                isLongPressActive = false; // 重置长按状态
                longPressTimer = setTimeout(() => {
                    isLongPressActive = true; // 标记长按已触发
                    setTemporaryPlaybackRate(LONG_PRESS_RATE); // 触发长按行为：倍速播放
                    showSeekFeedback('倍速播放'); // 显示UI反馈
                }, LONG_PRESS_THRESHOLD);
            } else {
                // 对于其他快捷键，立即执行
                executeShortcut(actionId);
            }
            break; // 找到匹配项后即退出循环
        }
    }
}

function handleGlobalKeyUp(e) {
    if (state.isRecordingShortcut) return;

    // 清除长按计时器
    clearTimeout(longPressTimer);
    longPressTimer = null;

    const normalizedKey = normalizeKey(e.key);

    // 查找释放的键是否是快进/快退的一部分
    const seekForwardKeys = new Set(state.shortcutSettings['seek-forward'].keys);
    const seekBackwardKeys = new Set(state.shortcutSettings['seek-backward'].keys);

    let wasSeekKey = false;
    if (seekForwardKeys.has(normalizedKey) && [...seekForwardKeys].every(k => state.pressedShortcutKeys.has(k))) {
        wasSeekKey = true;
        // 如果长按行为已触发，则恢复正常播放速率
        if (isLongPressActive) {
            restorePlaybackRate();
            showSeekFeedback('恢复正常');
        } else {
            // 否则，视为短按，执行单次跳转
            executeShortcut('seek-forward');
        }
    } else if (seekBackwardKeys.has(normalizedKey) && [...seekBackwardKeys].every(k => state.pressedShortcutKeys.has(k))) {
        wasSeekKey = true;
        if (isLongPressActive) {
            restorePlaybackRate();
            showSeekFeedback('恢复正常');
        } else {
            executeShortcut('seek-backward');
        }
    }

    // 重置状态
    isLongPressActive = false;
    state.pressedShortcutKeys.delete(normalizedKey);
    activeKeys.delete(e.key);
}

// =========================================================================

export function setupShortcutListeners() {
    dom.shortcutListEl.addEventListener('click', (e) => {
        const target = e.target;
        const item = target.closest('.shortcut-item');
        if (!item) return;
        const actionId = item.dataset.action;
        if (target.classList.contains('set-btn')) {
            startRecording(actionId);
        }
        if (target.classList.contains('clear-btn')) {
            state.shortcutSettings[actionId].keys = [];
            saveShortcuts();
            renderShortcutList();
        }
    });
    dom.shortcutModalOverlayEl.addEventListener('click', (e) => {
        if (e.target === dom.shortcutModalOverlayEl) stopRecording();
    });

    // 移除旧的、简单的监听器
    // window.removeEventListener('keydown', ...);
    // window.removeEventListener('keyup', ...);

    // 添加新的、支持长短按的监听器
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('keyup', handleGlobalKeyUp);
}