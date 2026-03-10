// src/renderer/stores/uiStore.js
/**
 * @file Pinia UI 状态 Store
 * @description 管理所有 UI 面板状态、Toast、ContextMenu、Modal 等。
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useUiStore = defineStore('ui', () => {
    // =========================================================================
    // 面板状态 — 同一时间只显示一个侧边面板
    // =========================================================================
    const activePanel = ref(null); // 'playlist' | 'download' | 'settings' | 'shortcut' | 'info' | null
    const isLyricsVisible = ref(false);
    const isMoreOptionsMenuVisible = ref(false);
    const isMainViewFullscreen = ref(false);
    const isDragOverlayActive = ref(false);

    function setDragOverlayActive(value) { isDragOverlayActive.value = value; }

    // =========================================================================
    // Toast
    // =========================================================================
    const toast = ref({ message: '', type: 'info', visible: false });
    let toastTimer = null;

    function showToast(message, type = 'info') {
        if (toastTimer) clearTimeout(toastTimer);
        toast.value = { message, type, visible: true };
        toastTimer = setTimeout(() => {
            toast.value = { ...toast.value, visible: false };
        }, 3000);
    }

    // =========================================================================
    // Context Menu
    // =========================================================================
    const contextMenu = ref({ visible: false, x: 0, y: 0, items: [], context: null });

    function showContextMenu({ x, y, items, context }) {
        contextMenu.value = { visible: true, x, y, items, context };
    }

    function hideContextMenu() {
        contextMenu.value = { ...contextMenu.value, visible: false };
    }

    // =========================================================================
    // Modals
    // =========================================================================
    // 确认弹窗
    const confirmModal = ref({ visible: false, message: '', resolve: null });

    function showConfirmationModal(message) {
        return new Promise((resolve) => {
            confirmModal.value = { visible: true, message, resolve };
        });
    }

    function resolveConfirm(result) {
        if (confirmModal.value.resolve) confirmModal.value.resolve(result);
        confirmModal.value = { visible: false, message: '', resolve: null };
    }

    // 快捷键录制弹窗
    const shortcutModal = ref({ visible: false, keyPreview: '' });

    function showShortcutModal() { shortcutModal.value.visible = true; }
    function hideShortcutModal() { shortcutModal.value = { visible: false, keyPreview: '' }; }
    function setShortcutKeyPreview(preview) { shortcutModal.value.keyPreview = preview; }

    // 下载进度弹窗
    const downloadProgressModal = ref({ visible: false, title: '', file: '', percent: 0 });

    function showDownloadProgress({ title, file, percent }) {
        downloadProgressModal.value = { visible: true, title, file, percent };
    }

    function hideDownloadProgress() {
        downloadProgressModal.value = { ...downloadProgressModal.value, visible: false };
    }

    // =========================================================================
    // Seek / Speed Feedback
    // =========================================================================
    const seekFeedback = ref({ text: '', visible: false });
    const speedFeedback = ref({ text: '', visible: false });
    let seekTimer = null;
    let speedTimer = null;

    function showSeekFeedback(text) {
        if (seekTimer) clearTimeout(seekTimer);
        seekFeedback.value = { text, visible: true };
        seekTimer = setTimeout(() => { seekFeedback.value.visible = false; }, 800);
    }

    function showSpeedFeedback(text) {
        if (speedTimer) clearTimeout(speedTimer);
        speedFeedback.value = { text, visible: true };
        speedTimer = setTimeout(() => { speedFeedback.value.visible = false; }, 800);
    }

    // =========================================================================
    // Empty State
    // =========================================================================
    const showEmptyState = ref(false);

    function toggleEmptyState(value) { showEmptyState.value = value; }

    // =========================================================================
    // Panel Actions
    // =========================================================================
    function openPanel(name) { activePanel.value = name; }

    function closeActivePanels() {
        activePanel.value = null;
        isMoreOptionsMenuVisible.value = false;
    }

    function togglePanel(name) {
        if (activePanel.value === name) {
            activePanel.value = null;
        } else {
            activePanel.value = name;
            isMoreOptionsMenuVisible.value = false;
        }
    }

    function toggleMoreOptionsMenu() {
        if (activePanel.value) {
            closeActivePanels();
        }
        isMoreOptionsMenuVisible.value = !isMoreOptionsMenuVisible.value;
    }

    function toggleLyricsPanel() { isLyricsVisible.value = !isLyricsVisible.value; }

    function toggleMainViewFullscreen(value) {
        isMainViewFullscreen.value = value !== undefined ? value : !isMainViewFullscreen.value;
    }

    return {
        // state
        activePanel, isLyricsVisible, isMoreOptionsMenuVisible, isMainViewFullscreen,
        isDragOverlayActive,
        toast, contextMenu, confirmModal, shortcutModal, downloadProgressModal,
        seekFeedback, speedFeedback, showEmptyState,
        // actions
        showToast, showContextMenu, hideContextMenu,
        showConfirmationModal, resolveConfirm,
        showShortcutModal, hideShortcutModal, setShortcutKeyPreview,
        showDownloadProgress, hideDownloadProgress,
        showSeekFeedback, showSpeedFeedback, toggleEmptyState,
        openPanel, closeActivePanels, togglePanel, toggleMoreOptionsMenu,
        toggleLyricsPanel, toggleMainViewFullscreen, setDragOverlayActive,
    };
});
