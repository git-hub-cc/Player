// src/renderer/js/ui/lyrics.js

/**
 * @file 歌词模块
 * @description 封装所有与歌词相关的渲染、同步和拖拽交互逻辑。
 */

import * as dom from '../dom.js';
import { getters, mutations, subscribe } from '../state.js';
import { getTemplate, formatTime } from '../utils.js';

// --- 模块私有状态 ---
let lastActiveLyricIndex = -1;

/**
 * 当歌词数据改变时，重新渲染歌词列表。
 * @param {Array<object>} parsedLyrics - 解析后的歌词数组。
 */
function onLyricsChanged(parsedLyrics) {
    if (!dom.lyricsList) return;

    dom.lyricsList.innerHTML = '';
    dom.lyricsList.style.transform = 'translateY(0)'; // 重置滚动位置

    if (!parsedLyrics || parsedLyrics.length === 0) {
        dom.lyricsList.appendChild(getTemplate('template-no-lyrics'));
        return;
    }

    const fragment = document.createDocumentFragment();
    parsedLyrics.forEach(line => {
        const pNode = getTemplate('template-lyric-line');
        const p = pNode.querySelector('p');
        if (p) {
            p.textContent = line.text || '...'; // 默认显示省略号以防空行
            fragment.appendChild(p);
        }
    });
    dom.lyricsList.appendChild(fragment);
    lastActiveLyricIndex = -1; // 重置上次高亮索引
}

/**
 * 根据当前播放时间同步歌词滚动和高亮。
 * @param {number} currentTime - 当前播放时间（秒）。
 */
export function syncLyrics(currentTime) {
    const parsedLyrics = getters.parsedLyrics();
    if (getters.isDraggingLyrics() || !parsedLyrics || parsedLyrics.length === 0) return;

    const allLyricLines = dom.getLyricLines();
    if (allLyricLines.length === 0) return;

    // 找到当前时间对应的歌词行索引
    let activeIndex = parsedLyrics.findIndex((line, i) =>
        currentTime >= line.time && (!parsedLyrics[i + 1] || currentTime < parsedLyrics[i + 1].time)
    );

    // 如果未找到（例如在歌曲开头空白），则保持未高亮状态
    if (activeIndex === -1 && currentTime < (parsedLyrics[0]?.time || 0)) {
        // 无操作，等待进入第一句歌词时间
    }

    // 仅在索引变化时更新DOM，优化性能
    if (activeIndex !== lastActiveLyricIndex) {
        if (lastActiveLyricIndex !== -1 && allLyricLines[lastActiveLyricIndex]) {
            allLyricLines[lastActiveLyricIndex].classList.remove('active');
        }
        if (activeIndex !== -1 && allLyricLines[activeIndex]) {
            allLyricLines[activeIndex].classList.add('active');
        }
        lastActiveLyricIndex = activeIndex;
    }

    // 平滑滚动到当前行
    if (activeIndex !== -1 && allLyricLines[activeIndex]) {
        const wrapperHeight = dom.lyricsListWrapper?.clientHeight || 0;
        const lineOffsetTop = allLyricLines[activeIndex].offsetTop;
        const lineHeight = allLyricLines[activeIndex].clientHeight;
        const translateY = wrapperHeight / 2 - lineOffsetTop - lineHeight / 2;

        if(dom.lyricsList) {
            dom.lyricsList.style.transform = `translateY(${translateY}px)`;
        }
    }
}


/**
 * 初始化歌词拖拽交互。
 */
function setupLyricsDragHandler() {
    if (!dom.lyricsListWrapper) return;

    let wasPlayingBeforeDrag = false;
    let dragStartY = 0;
    let initialTranslateY = 0;
    let targetTimeOnDragEnd = 0;

    function onLyricsDragStart(e) {
        // 仅当有歌词且是鼠标左键按下时触发
        if (getters.parsedLyrics().length === 0 || e.button !== 0) return;
        e.preventDefault();

        mutations.setIsDraggingLyrics(true);
        wasPlayingBeforeDrag = getters.isPlaying();
        if (wasPlayingBeforeDrag) mutations.setIsPlaying(false);

        dom.lyricsList?.classList.add('dragging');
        dom.lyricsDragIndicator?.classList.add('active');
        dragStartY = e.clientY;
        const transform = dom.lyricsList.style.transform;
        initialTranslateY = transform ? parseFloat(transform.match(/-?[\d.]+/)[0]) : 0;

        window.addEventListener('mousemove', onLyricsDragMove);
        window.addEventListener('mouseup', onLyricsDragEnd, { once: true }); // 确保只触发一次
    }

    function onLyricsDragMove(e) {
        if (!getters.isDraggingLyrics()) return;
        e.preventDefault();

        dom.lyricsList.style.transform = `translateY(${initialTranslateY + e.clientY - dragStartY}px)`;

        const centerLineY = dom.lyricsListWrapper.getBoundingClientRect().top + dom.lyricsListWrapper.clientHeight / 2;
        let closestIndex = -1;
        let minDistance = Infinity;

        // 寻找离中心线最近的歌词行
        dom.getLyricLines().forEach((line, index) => {
            const lineRect = line.getBoundingClientRect();
            const distance = Math.abs((lineRect.top + lineRect.height / 2) - centerLineY);
            if (distance < minDistance) {
                minDistance = distance;
                closestIndex = index;
            }
        });

        // 更新拖拽指示器的时间
        if (closestIndex !== -1 && getters.parsedLyrics()[closestIndex]) {
            targetTimeOnDragEnd = getters.parsedLyrics()[closestIndex].time;
            dom.lyricsDragTime.textContent = formatTime(targetTimeOnDragEnd);
        }
    }

    function onLyricsDragEnd(e) {
        if (!getters.isDraggingLyrics()) return;
        e.preventDefault();

        mutations.setIsDraggingLyrics(false);
        dom.lyricsList?.classList.remove('dragging');
        dom.lyricsDragIndicator?.classList.remove('active');
        window.removeEventListener('mousemove', onLyricsDragMove);

        // 跳转到目标时间
        if (targetTimeOnDragEnd >= 0) {
            window.dispatchEvent(new CustomEvent('seekTo', { detail: targetTimeOnDragEnd }));
        }
        if (wasPlayingBeforeDrag) {
            mutations.setIsPlaying(true);
        }
        // 立即同步一次UI，确保歌词位置正确
        syncLyrics(getters.currentTime());
    }

    dom.lyricsListWrapper.addEventListener('mousedown', onLyricsDragStart);
}

/**
 * 初始化歌词模块。
 */
export function init() {
    subscribe('lyricsChanged', onLyricsChanged);
    subscribe('timeChanged', ({ currentTime }) => syncLyrics(currentTime));

    setupLyricsDragHandler();
    console.log("Lyrics UI module initialized.");
}