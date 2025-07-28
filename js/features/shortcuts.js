// js/features/shortcuts.js

import * as dom from '../dom.js';
import * as state from '../state.js';
import { defaultShortcuts } from '../config.js';
import { getTemplate, normalizeKey } from '../utils.js';
import { togglePlayPause, playNextTrack, playPrevTrack } from '../player.js';
import { toggleLyricsPanel, togglePlaylistPanel, updateVolumeBarVisual } from '../ui.js';

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
    window.addEventListener('keydown', handleShortcutKeyDown);
    window.addEventListener('keyup', handleShortcutKeyUp);
}

function stopRecording() {
    state.setIsRecordingShortcut(false);
    state.setCurrentRecordingAction(null);
    state.pressedShortcutKeys.clear();
    dom.shortcutModalOverlayEl.classList.remove('visible');
    window.removeEventListener('keydown', handleShortcutKeyDown);
    window.removeEventListener('keyup', handleShortcutKeyUp);
}

function handleShortcutKeyDown(e) {
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

function handleShortcutKeyUp(e) {
    if (!state.isRecordingShortcut || state.pressedShortcutKeys.size === 0) return;

    // BUG修复：在设置快捷键后立即停止录制，防止事件继续冒泡触发全局快捷键
    const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    const hasNonModifierKey = Array.from(state.pressedShortcutKeys).some(k => !modifierKeys.includes(k));

    if (hasNonModifierKey) {
        // 1. 先保存新的快捷键
        state.shortcutSettings[state.currentRecordingAction].keys = Array.from(state.pressedShortcutKeys);
        saveShortcuts();

        // 2. 立即停止录制，移除监听器并隐藏模态框
        stopRecording();

        // 3. 最后再更新UI列表
        renderShortcutList();
    }
}

export function executeShortcut(actionId) {
    switch (actionId) {
        case 'toggle-play': togglePlayPause(); break;
        case 'next-track': playNextTrack(); break;
        case 'prev-track': playPrevTrack(); break;
        case 'volume-up':
            dom.mediaPlayer.volume = Math.min(1, dom.mediaPlayer.volume + 0.1);
            updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
            break;
        case 'volume-down':
            dom.mediaPlayer.volume = Math.max(0, dom.mediaPlayer.volume - 0.1);
            updateVolumeBarVisual(dom.mediaPlayer.volume, dom.mediaPlayer.muted);
            break;
        case 'toggle-mute': dom.volumeBtn.click(); break;
        case 'toggle-lyrics': toggleLyricsPanel(); break;
        case 'toggle-playlist': togglePlaylistPanel(); break;
    }
}

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
}