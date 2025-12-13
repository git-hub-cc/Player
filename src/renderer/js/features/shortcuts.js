// js/features/shortcuts.js

import * as dom from '../dom.js';
import * as state from '../state.js';
import { defaultShortcuts } from '../config.js';
import { getTemplate, normalizeKey } from '../utils.js';
import { togglePlayPause, playNextTrack, playPrevTrack, seek, setTemporaryPlaybackRate, restorePlaybackRate, increaseSpeed, decreaseSpeed } from '../player.js';
import { toggleLyricsPanel, togglePlaylistPanel, updateVolumeBarVisual, showSeekFeedback } from '../ui.js';

// --- 配置与状态变量 ---

// 长按检测阈值（毫秒），超过此时长视为长按
const LONG_PRESS_THRESHOLD = 250;
// 短按时步进的秒数（适用于短于10分钟的媒体）
const SEEK_STEP_SHORT = 10;
// 短按时步进的秒数（适用于长于10分钟的媒体）
const SEEK_STEP_LONG = 30;
// 长按时设置的播放速率
const LONG_PRESS_RATE = 4.0;

let longPressTimer = null; // 用于检测长按的计时器
let isLongPressActive = false; // 标记长按行为是否已触发

/**
 * 将按键数组格式化为可显示的 DOM 片段（<kbd>...</kbd>）。
 * @param {string[]} keys - 按键名称数组。
 * @returns {DocumentFragment} - 包含格式化按键的 DOM 片段。
 */
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

/**
 * 渲染快捷键设置列表到 UI。
 */
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

/**
 * 保存当前快捷键设置到 localStorage。
 */
function saveShortcuts() {
    localStorage.setItem('player-shortcuts', JSON.stringify(state.shortcutSettings));
}

/**
 * 从 localStorage 加载快捷键设置，如果不存在则使用默认设置。
 */
export function loadShortcuts() {
    const saved = localStorage.getItem('player-shortcuts');
    // 使用深拷贝确保默认设置不被意外修改
    const newSettings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
    state.setShortcutSettings(newSettings);
    renderShortcutList();
}

/**
 * 开始录制新的快捷键。
 * @param {string} actionId - 正在设置的目标动作ID。
 */
function startRecording(actionId) {
    state.setCurrentRecordingAction(actionId);
    state.setIsRecordingShortcut(true);
    state.pressedShortcutKeys.clear(); // 清空当前按键状态
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(getTemplate('template-recording-placeholder'));
    dom.shortcutModalOverlayEl.classList.add('visible'); // 显示模态框
    // 注册录制专用的事件监听
    window.addEventListener('keydown', handleShortcutKeyDownForRecording);
    window.addEventListener('keyup', handleShortcutKeyUpForRecording);
}

/**
 * 停止录制快捷键。
 */
function stopRecording() {
    state.setIsRecordingShortcut(false);
    state.setCurrentRecordingAction(null);
    state.pressedShortcutKeys.clear();
    dom.shortcutModalOverlayEl.classList.remove('visible'); // 隐藏模态框
    // 移除录制专用的事件监听
    window.removeEventListener('keydown', handleShortcutKeyDownForRecording);
    window.removeEventListener('keyup', handleShortcutKeyUpForRecording);
}

/**
 * 录制过程中的 keydown 事件处理器。
 * @param {KeyboardEvent} e - 键盘事件对象。
 */
function handleShortcutKeyDownForRecording(e) {
    if (!state.isRecordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();

    // 按下 Esc 键取消录制
    if (e.key === 'Escape') {
        stopRecording();
        return;
    }

    state.pressedShortcutKeys.add(normalizeKey(e.key));
    const keysFragment = formatKeysToFragment(Array.from(state.pressedShortcutKeys));
    dom.shortcutKeyPreviewEl.innerHTML = '';
    dom.shortcutKeyPreviewEl.appendChild(keysFragment);
}

/**
 * 录制过程中的 keyup 事件处理器。
 * 当检测到非修饰键抬起时，确认并保存快捷键。
 * @param {KeyboardEvent} e - 键盘事件对象。
 */
function handleShortcutKeyUpForRecording(e) {
    if (!state.isRecordingShortcut || state.pressedShortcutKeys.size === 0) return;

    const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    // 检查按下的键中是否包含非修饰键（如 A, B, Space 等）
    const hasNonModifierKey = Array.from(state.pressedShortcutKeys).some(k => !modifierKeys.includes(k));

    // 如果包含，则认为快捷键设置完成
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
            // 根据媒体时长决定步进大小
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
        // =========================================================================
        // 【新增】处理加速和减速的快捷键动作
        // =========================================================================
        case 'speed-up':
            increaseSpeed();
            break;
        case 'speed-down':
            decreaseSpeed();
            break;
        // =========================================================================
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
 * 全局 keydown 事件处理器，支持长按/短按区分。
 * @param {KeyboardEvent} e - 键盘事件对象。
 */
function handleGlobalKeyDown(e) {
    // 【鲁棒性增强】如果事件是系统长按重复触发的，则忽略，防止逻辑重复执行。
    if (e.repeat) {
        return;
    }
    // 如果正在录制快捷键或焦点在输入框，则忽略
    if (state.isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) {
        return;
    }
    // 如果播放列表为空，则忽略
    if (state.playlist.length === 0) {
        return;
    }

    const normalizedKey = normalizeKey(e.key);
    state.pressedShortcutKeys.add(normalizedKey);

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

/**
 * 全局 keyup 事件处理器。
 * @param {KeyboardEvent} e - 键盘事件对象。
 */
function handleGlobalKeyUp(e) {
    if (state.isRecordingShortcut) return;

    // 释放按键时，清除长按计时器
    clearTimeout(longPressTimer);
    longPressTimer = null;

    const normalizedKey = normalizeKey(e.key);

    // 查找释放的键是否是快进/快退的一部分
    const seekForwardKeys = new Set(state.shortcutSettings['seek-forward'].keys);
    const seekBackwardKeys = new Set(state.shortcutSettings['seek-backward'].keys);

    // 检查释放的键是否是快进键，并且所有快进组合键都曾被按下
    if (seekForwardKeys.has(normalizedKey) && [...seekForwardKeys].every(k => state.pressedShortcutKeys.has(k))) {
        // 如果长按行为已触发，则恢复正常播放速率
        if (isLongPressActive) {
            restorePlaybackRate();
            showSeekFeedback('恢复正常');
        } else {
            // 否则，视为短按，执行单次跳转
            executeShortcut('seek-forward');
        }
    }
    // 检查释放的键是否是快退键
    else if (seekBackwardKeys.has(normalizedKey) && [...seekBackwardKeys].every(k => state.pressedShortcutKeys.has(k))) {
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
}

/**
 * 初始化所有与快捷键相关的事件监听器。
 */
export function setupShortcutListeners() {
    // --- 设置面板内的交互 ---
    dom.shortcutListEl.addEventListener('click', (e) => {
        const target = e.target;
        const item = target.closest('.shortcut-item');
        if (!item) return;
        const actionId = item.dataset.action;

        // 点击“设置”按钮
        if (target.classList.contains('set-btn')) {
            startRecording(actionId);
        }
        // 点击“清除”按钮
        if (target.classList.contains('clear-btn')) {
            state.shortcutSettings[actionId].keys = [];
            saveShortcuts();
            renderShortcutList();
        }
    });

    // 点击模态框背景可取消录制
    dom.shortcutModalOverlayEl.addEventListener('click', (e) => {
        if (e.target === dom.shortcutModalOverlayEl) stopRecording();
    });

    // --- 全局事件监听 ---
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('keyup', handleGlobalKeyUp);

    // 【鲁棒性增强】当窗口失去焦点时，重置所有按键状态。
    // 这可以防止用户 Alt+Tab 切换应用后，按键状态残留导致快捷键失灵。
    window.addEventListener('blur', () => {
        state.pressedShortcutKeys.clear();
        isLongPressActive = false;
        clearTimeout(longPressTimer);
        longPressTimer = null;
        // 如果倍速播放被激活，也恢复正常速率
        if (dom.mediaPlayer && dom.mediaPlayer.playbackRate !== state.playbackRate) {
            // 注意: 此处不再使用 restorePlaybackRate，而是直接设置为 state 中的值，
            // 因为长按快进可能与用户设定的倍速播放冲突。
            // 用户的设定（state.playbackRate）优先级更高。
            dom.mediaPlayer.playbackRate = state.playbackRate;
        }
    });
}