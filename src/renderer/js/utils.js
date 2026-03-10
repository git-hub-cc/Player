// js/utils.js

export function getTemplate(id) {
    const template = document.getElementById(id);
    if (!template) {
        console.warn(`Template with id "${id}" not found.`);
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

    const normalizedText = lrcText
        .replace(/\r\n/g, '\n')
        .replace(/\[/g, '\n[')
        .replace(/\n{2,}/g, '\n')
        .replace(/^\n/, '');

    return normalizedText.split('\n').map(line => {
        const match = line.match(/\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
            const time = minutes * 60 + seconds + milliseconds / 1000;
            return { time, text: match[4].trim() };
        }
        return null;
    }).filter(Boolean);
}

export function normalizeKey(key) {
    const keyMap = { 'Control': 'Ctrl', 'Meta': 'Cmd', ' ': 'Space', 'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→' };
    return keyMap[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

// =========================================================================
// 【新增】颜色转换工具函数
// =========================================================================

/**
 * 将 RGB 颜色值转换为 HSL。转换公式基于 M.W. Kramer 在
 * http://www.cs.rit.edu/~ncs/color/t_convert.html 上的文章。
 * @param   {number}  r       红色值 (0-255)
 * @param   {number}  g       绿色值 (0-255)
 * @param   {number}  b       蓝色值 (0-255)
 * @returns {object}          包含 h, s, l 属性的对象
 */
export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s, l };
}

/**
 * 将 HSL 颜色值转换为 RGB。转换公式基于 M.W. Kramer 在
 * http://www.cs.rit.edu/~ncs/color/t_convert.html 上的文章。
 * @param   {number}  h       色相 (0-360)
 * @param   {number}  s       饱和度 (0-1)
 * @param   {number}  l       亮度 (0-1)
 * @returns {Array}           [r, g, b] 数组
 */
export function hslToRgb(h, s, l) {
    let r, g, b;
    h /= 360;

    if (s === 0) {
        r = g = b = l; // achromatic
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
// =========================================================================