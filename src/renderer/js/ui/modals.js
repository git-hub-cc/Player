// src/renderer/js/ui/modals.js

/**
 * @file 模态框与通知模块
 * @description 负责所有模态框、Toast提示、UI反馈元素的管理。
 *              这是一个独立的UI组件库，提供可复用的函数。
 */

import * as dom from '../dom.js';
import { getters } from '../state.js';

// --- 模块私有状态 ---
let toastTimeout = null;
let seekFeedbackTimeout = null;
let speedFeedbackTimeout = null;

/**
 * 显示一个短暂的提示消息（Toast）。
 * @param {string} message - 要显示的消息。
 * @param {'info'|'success'|'error'} [type='info'] - 消息类型。
 */
export function showToast(message, type = 'info') {
    if (!dom.toastEl) return;
    clearTimeout(toastTimeout);
    dom.toastEl.textContent = message;
    dom.toastEl.className = `toast show ${type}`;
    toastTimeout = setTimeout(() => {
        dom.toastEl?.classList.remove('show');
    }, 3000);
}

/**
 * 显示快进/快退的视觉反馈。
 * @param {string|number} feedback - 要显示的反馈文本或秒数。
 */
export function showSeekFeedback(feedback) {
    if (!dom.seekFeedbackEl) return;
    clearTimeout(seekFeedbackTimeout);
    dom.seekFeedbackEl.textContent = typeof feedback === 'number'
        ? `${feedback > 0 ? '»' : '«'} ${Math.abs(feedback)}s`
        : feedback;
    dom.seekFeedbackEl.classList.add('visible');
    seekFeedbackTimeout = setTimeout(() => {
        dom.seekFeedbackEl?.classList.remove('visible');
    }, 1000);
}

/**
 * 显示播放速度变化的视觉反馈。
 */
export function showSpeedFeedback() {
    if (!dom.speedFeedbackEl) return;
    clearTimeout(speedFeedbackTimeout);
    dom.speedFeedbackEl.textContent = `${getters.playbackRate().toFixed(1)}x`;
    dom.speedFeedbackEl.classList.add('visible');
    speedFeedbackTimeout = setTimeout(() => {
        dom.speedFeedbackEl?.classList.remove('visible');
    }, 1500);
}

/**
 * 显示一个确认对话框。
 * @param {string} message - 对话框内容。
 * @param {object} [options={}] - 配置项，如按钮文本。
 * @param {string} [options.confirmText='确认'] - 确认按钮文本。
 * @param {string} [options.cancelText='取消'] - 取消按钮文本。
 * @returns {Promise<void>} - 用户点击确认时 resolve，点击取消或关闭时 reject。
 */
export function showConfirmationModal(message, options = {}) {
    return new Promise((resolve, reject) => {
        if (!dom.confirmationModal || !dom.confirmationMessage || !dom.confirmBtn || !dom.cancelBtn) {
            return reject(new Error('确认对话框的DOM元素未找到。'));
        }

        dom.confirmationMessage.textContent = message;
        dom.confirmBtn.textContent = options.confirmText || '确认';
        dom.cancelBtn.textContent = options.cancelText || '取消';
        dom.confirmationModal.classList.add('visible');

        const cleanup = (callback) => {
            dom.confirmationModal?.classList.remove('visible');
            // 移除监听器，防止内存泄漏
            dom.confirmBtn?.removeEventListener('click', onConfirm);
            dom.cancelBtn?.removeEventListener('click', onCancel);
            callback();
        };

        const onConfirm = () => cleanup(resolve);
        const onCancel = () => cleanup(() => reject('cancel'));

        // 使用 { once: true } 确保事件只触发一次
        dom.confirmBtn.addEventListener('click', onConfirm, { once: true });
        dom.cancelBtn.addEventListener('click', onCancel, { once: true });
    });
}

/**
 * 切换空状态视图的显示。
 * @param {boolean} isEmpty - 是否显示空状态。
 */
export function toggleEmptyState(isEmpty) {
    dom.mainView?.classList.toggle('is-empty', isEmpty);
    dom.playerControls?.classList.toggle('disabled', isEmpty);
}