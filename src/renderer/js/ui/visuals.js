// src/renderer/js/ui/visuals.js

/**
 * @file 视觉效果模块
 * @description 负责处理计算密集型的视觉效果，如音频可视化和动态背景。
 */

import * as dom from '../dom.js';
import { getters, mutations, subscribe } from '../state.js';
import { rgbToHsl, hslToRgb } from '../utils.js';

// --- 模块私有状态 ---
let visualizerDataArray = null;
let animationFrameId = null;
let nextBackgroundUpdateTime = 0;
const BACKGROUND_BEAT_MULTIPLIER = 12; // 背景更新频率与节拍的倍数关系

/**
 * 从图像或视频帧中提取关键颜色，并应用为背景渐变。
 * @param {HTMLImageElement|HTMLVideoElement} sourceElement - 颜色来源元素。
 */
function extractAndApplyGradient(sourceElement) {
    // 检查源元素是否有效且已加载完成
    const isReady = sourceElement &&
        (sourceElement.tagName === 'IMG' && sourceElement.complete && sourceElement.naturalWidth > 0) ||
        (sourceElement.tagName === 'VIDEO' && sourceElement.readyState >= 2);

    if (!isReady) {
        mutations.setCurrentGradientColors(null); // 如果源未就绪，重置颜色
        return;
    }

    try {
        // 使用一个小的离屏Canvas提高颜色提取性能
        const canvas = dom.bgCanvas;
        const ctx = dom.bgCtx;
        if (!canvas || !ctx) return;

        const w = canvas.width = 100;
        const h = canvas.height = 100;
        ctx.drawImage(sourceElement, 0, 0, w, h);

        // 从左上角和右下角提取两个像素点作为渐变色
        const p1 = ctx.getImageData(1, 1, 1, 1).data;
        const p4 = ctx.getImageData(w - 2, h - 2, 1, 1).data;
        mutations.setCurrentGradientColors([[p1[0], p1[1], p1[2]], [p4[0], p4[1], p4[2]]]);
    } catch (e) {
        // 捕获跨域等错误，并重置颜色
        console.warn('提取背景颜色失败:', e.message);
        mutations.setCurrentGradientColors(null);
    }
}

/**
 * 更新动态背景。视频模式下从当前帧提取颜色，音频模式下切换预设的调色板。
 * @param {object} track - 当前轨道对象。
 */
function updateDynamicBackground(track) {
    if (!track) return;
    if (track.type === 'video') {
        extractAndApplyGradient(dom.mediaPlayer);
    }
    // 音频模式的背景切换逻辑暂时移除，简化为基于封面的静态渐变
}

/**
 * 绘制音频可视化效果。
 */
function drawVisualizer() {
    const analyser = getters.analyser();
    if (!analyser || !dom.audioVisualizer || !dom.albumArtContainer) return;

    if (!visualizerDataArray) {
        visualizerDataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(visualizerDataArray);

    const canvas = dom.audioVisualizer;
    const ctx = canvas.getContext('2d');

    // 响应式画布尺寸调整，仅在需要时执行
    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }

    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);

    const artSize = dom.albumArtContainer.offsetWidth;
    if (artSize === 0) return; // 如果封面不可见，则不绘制

    const centerX = w / 2, centerY = h / 2, halfSize = artSize / 2;
    const barWidth = 3, maxBarHeight = 100, numBarsPerSide = 64;

    // 根据当前背景色动态计算频谱条颜色
    let startColor = 'rgba(29, 185, 84, 0.2)';
    let endColor = 'rgba(29, 185, 84, 0.8)';
    const colors = getters.currentGradientColors();
    if (colors && colors[1]) {
        try {
            const hsl = rgbToHsl(...colors[1]); // 使用背景色中的亮色
            // 调整颜色，使其更醒目
            const rgb = hslToRgb((hsl.h + 30) % 360, Math.min(hsl.s + 0.15, 1), Math.min(hsl.l + 0.2, 0.85));
            startColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`;
            endColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`;
        } catch (e) {
            // 颜色转换失败时使用默认值
        }
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

        // 绘制右侧频谱条
        const [sx, sy, ex, ey] = [x, y, x + dx * barHeight, y + dy * barHeight];
        let grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        // 绘制左侧镜像的频谱条
        const [msx, msy, mex, mey] = [2 * centerX - sx, sy, 2 * centerX - ex, ey];
        grad = ctx.createLinearGradient(msx, msy, mex, mey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(msx, msy); ctx.lineTo(mex, mey); ctx.stroke();
    }
}

/**
 * 启动动画循环，用于驱动音频可视化和动态背景等持续更新的视觉效果。
 */
function runAnimationFrame() {
    // 只有在播放状态下才执行动画逻辑
    if (getters.isPlaying()) {
        const track = getters.currentTrack();
        if (track?.type === 'audio' && getters.analyser()) {
            drawVisualizer();
        }

        // 基于节拍的动态背景更新
        const now = performance.now();
        if (track?.beatInterval > 0) {
            if (nextBackgroundUpdateTime === 0) nextBackgroundUpdateTime = now;
            if (now >= nextBackgroundUpdateTime) {
                updateDynamicBackground(track);
                const interval = track.beatInterval * 1000 * BACKGROUND_BEAT_MULTIPLIER;
                nextBackgroundUpdateTime = Math.max(now, nextBackgroundUpdateTime + interval);
            }
        }
    }
    // 递归调用，形成持续的动画循环
    animationFrameId = requestAnimationFrame(runAnimationFrame);
}


/**
 * 初始化视觉效果模块。
 */
export function init() {
    // 监听播放状态，控制动画循环的启停
    subscribe('isPlayingChanged', (isPlaying) => {
        if (isPlaying && animationFrameId === null) {
            nextBackgroundUpdateTime = 0; // 重置节拍更新计时器
            runAnimationFrame();
        }
    });

    // 监听轨道变化，为新轨道提取初始背景色
    subscribe('currentTrackChanged', (track) => {
        if (track) {
            if (track.type === 'video') {
                dom.mediaPlayer?.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
            } else {
                dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
                if (dom.albumArtEl.complete) {
                    extractAndApplyGradient(dom.albumArtEl);
                }
            }
        }
    });

    // 监听提取出的渐变色，并应用到UI
    subscribe('gradientColorsChanged', (colors) => {
        if (dom.mainView) {
            if (colors) {
                const [c1, c2] = colors;
                dom.mainView.style.background = `linear-gradient(145deg, rgb(${c1.join(',')}), rgb(${c2.join(',')}))`;
            } else {
                dom.mainView.style.background = ''; // 恢复默认背景
            }
        }
    });

    console.log("Visuals UI module initialized.");
}