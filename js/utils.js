// js/utils.js

import { getTemplateElementById } from "./dom.js";

export function getTemplate(id) {
    const template = getTemplateElementById(id);
    if (!template) {
        console.error(`Template with id "${id}" not found.`);
        return document.createDocumentFragment();
    }
    return template.content.cloneNode(true);
}

export function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function parseLRC(lrcText) {
    if (!lrcText || lrcText.trim() === '') return [];

    // --- ⬇️ 核心修改：将格式化逻辑移入此函数，使其更健壮 ⬇️ ---
    const normalizedText = lrcText
        .replace(/\r\n/g, '\n') // 将 Windows 换行符转为标准换行符
        .replace(/\[/g, '\n[') // 确保每个时间标签都在新的一行
        .replace(/\n{2,}/g, '\n') // 将多个连续换行符合并为一个
        .replace(/^\n/, '');      // 移除可能由上面操作产生的开头空行

    return normalizedText.split('\n').map(line => {
        // --- ⬆️ 核心修改结束 ⬆️ ---
        // 匹配 [mm:ss.xx] 或 [mm:ss.xxx] 格式
        const match = line.match(/\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            // 处理毫秒部分，可能是两位或三位
            const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
            const time = minutes * 60 + seconds + milliseconds / 1000;
            return { time, text: match[4].trim() };
        }
        return null;
    }).filter(Boolean); // 过滤掉无法解析的行 (如 [ti:...] 等元信息)
}

export function normalizeKey(key) {
    const keyMap = { 'Control': 'Ctrl', 'Meta': 'Cmd', ' ': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→' };
    return keyMap[key] || key.charAt(0).toUpperCase() + key.slice(1);
}