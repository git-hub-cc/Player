// src/renderer/composables/useVisuals.js
/**
 * @file 视觉效果 Composable
 * @description 封装音频可视化和动态背景色提取逻辑。
 */

import { watch } from 'vue';
import { usePlayerStore } from '../stores/playerStore.js';
import { rgbToHsl, hslToRgb } from '../js/utils.js';

let visualizerDataArray = null;
let animationFrameId = null;
let nextBackgroundUpdateTime = 0;
const BACKGROUND_BEAT_MULTIPLIER = 12;

// DOM 引用（由调用方传入）
let _canvasEl = null;      // audio-visualizer canvas
let _albumArtEl = null;    // album-art img
let _bgCanvas = null;      // 离屏 canvas
let _bgCtx = null;
let _mainViewEl = null;
let _mediaEl = null;
let _albumArtContainerEl = null;

function extractAndApplyGradient(sourceElement, playerStore) {
    const isReady = sourceElement &&
        (sourceElement.tagName === 'IMG' && sourceElement.complete && sourceElement.naturalWidth > 0) ||
        (sourceElement.tagName === 'VIDEO' && sourceElement.readyState >= 2);

    if (!isReady) {
        playerStore.setCurrentGradientColors(null);
        return;
    }

    try {
        const canvas = _bgCanvas;
        const ctx = _bgCtx;
        if (!canvas || !ctx) return;
        const w = canvas.width = 100;
        const h = canvas.height = 100;
        ctx.drawImage(sourceElement, 0, 0, w, h);
        const p1 = ctx.getImageData(1, 1, 1, 1).data;
        const p4 = ctx.getImageData(w - 2, h - 2, 1, 1).data;
        playerStore.setCurrentGradientColors([[p1[0], p1[1], p1[2]], [p4[0], p4[1], p4[2]]]);
    } catch (e) {
        playerStore.setCurrentGradientColors(null);
    }
}

function drawVisualizer(playerStore) {
    const analyser = playerStore.analyser;
    if (!analyser || !_canvasEl || !_albumArtContainerEl) return;

    if (!visualizerDataArray) {
        visualizerDataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(visualizerDataArray);

    const canvas = _canvasEl;
    const ctx = canvas.getContext('2d');

    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }

    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);

    const artSize = _albumArtContainerEl.offsetWidth;
    if (artSize === 0) return;

    const centerX = w / 2, centerY = h / 2, halfSize = artSize / 2;
    const barWidth = 3, maxBarHeight = 100, numBarsPerSide = 64;

    let startColor = 'rgba(29, 185, 84, 0.2)';
    let endColor = 'rgba(29, 185, 84, 0.8)';
    const colors = playerStore.currentGradientColors;
    if (colors && colors[1]) {
        try {
            const hsl = rgbToHsl(...colors[1]);
            const rgb = hslToRgb(
                (hsl.h + 30) % 360,
                Math.min(hsl.s + 0.15, 1),
                Math.min(hsl.l + 0.2, 0.85)
            );
            startColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`;
            endColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`;
        } catch { }
    }
    ctx.lineWidth = barWidth;
    ctx.lineCap = 'round';

    const halfPerimeter = halfSize * 2 + artSize;
    const step = halfPerimeter / numBarsPerSide;

    for (let i = 0; i < numBarsPerSide; i++) {
        const dataIndex = Math.floor(i * (visualizerDataArray.length * 0.75) / numBarsPerSide);
        const barHeight = (visualizerDataArray[dataIndex] / 255) ** 2.5 * maxBarHeight;
        if (barHeight < 1) continue;

        const p = i * step;
        let x, y, dx, dy;
        if (p < halfSize) { x = centerX + p; y = centerY + halfSize; dx = 0; dy = 1; }
        else if (p < halfSize + artSize) { x = centerX + halfSize; y = centerY + halfSize - (p - halfSize); dx = 1; dy = 0; }
        else { x = centerX + halfSize - (p - (halfSize + artSize)); y = centerY - halfSize; dx = 0; dy = -1; }

        const [sx, sy, ex, ey] = [x, y, x + dx * barHeight, y + dy * barHeight];
        let grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        const [msx, msy, mex, mey] = [2 * centerX - sx, sy, 2 * centerX - ex, ey];
        grad = ctx.createLinearGradient(msx, msy, mex, mey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(msx, msy); ctx.lineTo(mex, mey); ctx.stroke();
    }
}

function runAnimationFrame(playerStore) {
    if (playerStore.isPlaying) {
        const track = playerStore.currentTrack;
        if (track?.type === 'audio' && playerStore.analyser) {
            drawVisualizer(playerStore);
        }
        const now = performance.now();
        if (track?.beatInterval > 0) {
            if (nextBackgroundUpdateTime === 0) nextBackgroundUpdateTime = now;
            if (now >= nextBackgroundUpdateTime) {
                if (track.type === 'video') extractAndApplyGradient(_mediaEl, playerStore);
                const interval = track.beatInterval * 1000 * BACKGROUND_BEAT_MULTIPLIER;
                nextBackgroundUpdateTime = Math.max(now, nextBackgroundUpdateTime + interval);
            }
        }
    }
    animationFrameId = requestAnimationFrame(() => runAnimationFrame(playerStore));
}

/**
 * 初始化视觉效果 Composable
 */
export function useVisuals({ canvasEl, albumArtEl, bgCanvas, bgCtx, mainViewEl, mediaEl, albumArtContainerEl }) {
    _canvasEl = canvasEl;
    _albumArtEl = albumArtEl;
    _bgCanvas = bgCanvas;
    _bgCtx = bgCtx;
    _mainViewEl = mainViewEl;
    _mediaEl = mediaEl;
    _albumArtContainerEl = albumArtContainerEl;

    const playerStore = usePlayerStore();

    // 监听播放状态，控制动画循环
    watch(() => playerStore.isPlaying, (isPlaying) => {
        if (isPlaying && animationFrameId === null) {
            nextBackgroundUpdateTime = 0;
            runAnimationFrame(playerStore);
        }
    });

    // 监听曲目变化，提取封面背景色
    watch(() => playerStore.currentTrack, (track) => {
        if (!track) return;
        if (track.type === 'video') {
            _mediaEl?.addEventListener('canplay', () => extractAndApplyGradient(_mediaEl, playerStore), { once: true });
        } else {
            if (_albumArtEl) {
                _albumArtEl.onload = () => extractAndApplyGradient(_albumArtEl, playerStore);
                if (_albumArtEl.complete) extractAndApplyGradient(_albumArtEl, playerStore);
            }
        }
    });

    // 监听渐变颜色，应用到主视图背景
    watch(() => playerStore.currentGradientColors, (colors) => {
        if (_mainViewEl) {
            if (colors) {
                const [c1, c2] = colors;
                _mainViewEl.style.background = `linear-gradient(145deg, rgb(${c1.join(',')}), rgb(${c2.join(',')}))`;
            } else {
                _mainViewEl.style.background = '';
            }
        }
    });

    // 启动动画循环
    runAnimationFrame(playerStore);
}
