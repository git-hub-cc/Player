// js/utils.js

import {playerContainer, templatesContainer, getTemplateElementById} from "./dom.js";

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
    return lrcText.split('\n').map(line => {
        const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
        if (match) {
            const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 1000;
            return { time, text: match[4].trim() };
        }
        return null;
    }).filter(Boolean);
}

export function normalizeKey(key) {
    const keyMap = { 'Control': 'Ctrl', 'Meta': 'Cmd', ' ': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→' };
    return keyMap[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

export async function loadTemplates() {
    try {
        const response = await fetch('template.html');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        templatesContainer.innerHTML = await response.text();
    } catch (error) {
        console.error("无法加载模板文件 'template.html':", error);
        playerContainer.innerHTML = '<h1>Error: Could not load app templates.</h1>';
    }
}