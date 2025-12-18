// src/renderer/js/features/gallery.js

/**
 * @file 背景画廊组件 (Gallery Component)
 * @description
 * 负责渲染和控制可交互的背景封面画廊。
 * 这是一个独立的UI组件，它订阅播放列表状态的变化来更新自身内容，
 * 并通过请求状态变更来与应用的其他部分交互。
 */

import * as dom from '../dom.js';
import { getters, mutations, subscribe } from '../state.js';
import { DEFAULT_ART } from '../config.js';
import * as ICONS from '../icons.js';
import { getTemplate } from '../utils.js';

// --- 配置项 ---
const ITEM_WIDTH = 280;             // 单个项目的宽度
const GAP = 30;                     // 项目之间的间隙
const RENDER_BUFFER = 1;            // 视口外额外渲染的行列数，用于平滑滚动
const LONG_PRESS_DURATION = 300;    // 长按触发拖拽的阈值 (毫秒)
const FRICTION = 0.92;              // 惯性滚动的摩擦力 (值越小，停止越快)
const IDLE_TIMEOUT = 3000;          // 拖拽停止后，播放器自动显示前的延迟
const DRAG_THRESHOLD = 5;           // 触发拖拽的最小像素移动距离
const AUTO_SCROLL_SPEED = 0.3;      // 屏保模式下的自动滚动速度

// --- 模块内部状态 ---
const _state = {
    isInitialized: false,           // 是否已初始化
    isPressing: false,              // 鼠标/手指是否按下
    isDragging: false,              // 是否正在拖拽
    justDragged: false,             // 用于区分拖拽结束和单击的标志
    longPressTimer: null,           // 长按计时器
    startPos: { x: 0, y: 0 },       // 拖拽起始位置
    currentPos: { x: 0, y: 0 },     // 平滑动画的当前位置
    targetPos: { x: 0, y: 0 },      // 拖拽或惯性的目标位置
    velocity: { x: 0, y: 0 },       // 惯性滚动的速度
    lastMoveTime: 0,                // 上次移动的时间戳
    lastMovePos: { x: 0, y: 0 },    // 上次移动的位置
    animationFrame: null,           // 动画帧ID
    renderedCells: new Map(),       // 虚拟化渲染的单元格缓存
    idleTimer: null,                // 闲置计时器
    isAutoScrolling: false,         // 是否处于自动滚动（屏保）模式
};


/**
 * 节流函数，用于优化 resize 事件处理，防止过于频繁地触发。
 * @param {Function} func - 要节流的函数。
 * @param {number} delay - 延迟时间 (毫秒)。
 * @returns {Function} - 节流后的函数。
 */
function debounce(func, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

// --- UI 控制 ---
function showPlayer() {
    clearTimeout(_state.idleTimer);
    dom.playerContainer.classList.remove('hidden-by-gallery');
}

function hidePlayer() {
    clearTimeout(_state.idleTimer);
    dom.playerContainer.classList.add('hidden-by-gallery');
}


// --- 核心渲染逻辑 ---
/**
 * 虚拟化渲染，只创建视口内及缓冲区内的 DOM 元素以提高性能。
 */
function updateGallery() {
    const playlistData = getters.playlist();
    if (playlistData.length === 0) {
        dom.galleryWrapper.innerHTML = '';
        _state.renderedCells.clear();
        return;
    }

    _state.lastUpdatePos = { ..._state.targetPos };
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fullItemWidth = ITEM_WIDTH + GAP;
    const fullItemHeight = ITEM_WIDTH + GAP;

    const startCol = Math.floor(-_state.targetPos.x / fullItemWidth) - RENDER_BUFFER;
    const endCol = Math.floor((-_state.targetPos.x + viewportWidth) / fullItemWidth) + RENDER_BUFFER;
    const startRow = Math.floor(-_state.targetPos.y / fullItemHeight) - RENDER_BUFFER;
    const endRow = Math.floor((-_state.targetPos.y + viewportHeight) / fullItemHeight) + RENDER_BUFFER;

    // 移除视口外的元素
    for (const [cellId, element] of _state.renderedCells.entries()) {
        const [row, col] = cellId.split(',').map(Number);
        if (row < startRow || row > endRow || col < startCol || col > endCol) {
            element.remove();
            _state.renderedCells.delete(cellId);
        }
    }

    const fragment = document.createDocumentFragment();

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            const cellId = `${row},${col}`;
            if (!_state.renderedCells.has(cellId)) {
                const itemNode = getTemplate('template-gallery-item');
                const item = itemNode.querySelector('.gallery-item');
                if (!item) continue;

                // 注入SVG图标
                const playIconPlaceholder = item.querySelector('.icon-placeholder[data-icon="GALLERY_PLAY"]');
                if (playIconPlaceholder) {
                    playIconPlaceholder.outerHTML = ICONS.ICON_GALLERY_PLAY;
                }

                const x = col * fullItemWidth + GAP;
                const y = row * fullItemHeight + GAP;
                item.style.setProperty('--x', `${x}px`);
                item.style.setProperty('--y', `${y}px`);

                const hash = Math.abs(row * 31 + col * 37);
                const trackIndex = hash % playlistData.length;
                const track = playlistData[trackIndex];
                if (!track) continue; // 健壮性检查

                // =========================================================================
                // 【核心修改】使用稳定的 `src` 作为唯一标识符，而不是易变的 `index`
                // =========================================================================
                item.dataset.src = track.src;
                // =========================================================================

                const artElement = item.querySelector('.gallery-item-art');
                artElement.src = track.albumArt || DEFAULT_ART;
                item.querySelector('.gallery-item-title').textContent = track.title || '未知标题';
                item.querySelector('.gallery-item-artist').textContent = track.artist || '未知艺术家';

                // 提取封面颜色用于边框
                artElement.onload = () => {
                    try {
                        const canvas = dom.bgCanvas;
                        const ctx = dom.bgCtx;
                        canvas.width = 50; canvas.height = 50;
                        ctx.drawImage(artElement, 0, 0, 50, 50);
                        const p = ctx.getImageData(1, 1, 1, 1).data;
                        item.style.setProperty('--gallery-item-border-color', `rgb(${p[0]}, ${p[1]}, ${p[2]})`);
                    } catch (e) {
                        item.style.setProperty('--gallery-item-border-color', 'var(--highlight-bg)');
                    }
                };
                if (artElement.complete) artElement.onload();

                fragment.appendChild(item);
                requestAnimationFrame(() => item.classList.add('visible')); // 延迟添加以触发淡入动画
                _state.renderedCells.set(cellId, item);
            }
        }
    }
    dom.galleryWrapper.appendChild(fragment);
}

/**
 * 动画循环，负责平滑滚动、惯性效果和自动滚动。
 */
function animate() {
    // 使用插值实现平滑过渡
    _state.currentPos.x += (_state.targetPos.x - _state.currentPos.x) * 0.1;
    _state.currentPos.y += (_state.targetPos.y - _state.currentPos.y) * 0.1;

    if (_state.isAutoScrolling) {
        _state.targetPos.x -= AUTO_SCROLL_SPEED; // 屏保模式下自动滚动
    } else if (!_state.isDragging && (Math.abs(_state.velocity.x) > 0.01 || Math.abs(_state.velocity.y) > 0.01)) {
        _state.velocity.x *= FRICTION; // 应用摩擦力，实现惯性滚动
        _state.velocity.y *= FRICTION;
        _state.targetPos.x += _state.velocity.x;
        _state.targetPos.y += _state.velocity.y;
    }

    dom.galleryWrapper.style.transform = `translate(${_state.currentPos.x}px, ${_state.currentPos.y}px)`;

    // 当移动距离足够大时，触发一次虚拟渲染
    const movedDistance = Math.hypot(_state.targetPos.x - (_state.lastUpdatePos?.x || 0), _state.targetPos.y - (_state.lastUpdatePos?.y || 0));
    if (movedDistance > ITEM_WIDTH / 2) {
        updateGallery();
    }
    _state.animationFrame = requestAnimationFrame(animate);
}

// --- 事件处理 ---

function onPointerDown(e) {
    if (_state.isAutoScrolling) return;
    e.preventDefault();
    hidePlayer();
    _state.isPressing = true;
    _state.justDragged = false;
    _state.startPos = { x: e.clientX, y: e.clientY };
    const dragStartTarget = { ..._state.targetPos };
    _state.velocity = { x: 0, y: 0 };
    _state.lastMoveTime = Date.now();
    _state.lastMovePos = { ..._state.startPos };
    _state.longPressTimer = setTimeout(() => {
        _state.isDragging = true;
        dom.galleryContainer.classList.add('active');
    }, LONG_PRESS_DURATION);

    const onPointerMove = (e) => {
        if (!_state.isPressing) return;
        const currentMovePos = { x: e.clientX, y: e.clientY };
        const deltaX = currentMovePos.x - _state.startPos.x;
        const deltaY = currentMovePos.y - _state.startPos.y;
        if (!_state.isDragging && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD) {
            clearTimeout(_state.longPressTimer);
            _state.isDragging = true;
            dom.galleryContainer.classList.add('active');
        }
        if (_state.isDragging) {
            const now = Date.now();
            const deltaTime = now - _state.lastMoveTime;
            _state.targetPos.x = dragStartTarget.x + deltaX;
            _state.targetPos.y = dragStartTarget.y + deltaY;
            if (deltaTime > 0) {
                // 计算瞬时速度，用于实现惯性滚动
                _state.velocity.x = (currentMovePos.x - _state.lastMovePos.x) / deltaTime * 16.67;
                _state.velocity.y = (currentMovePos.y - _state.lastMovePos.y) / deltaTime * 16.67;
            }
            _state.lastMoveTime = now;
            _state.lastMovePos = currentMovePos;
            _state.justDragged = true;
        }
    };

    const onPointerUp = () => {
        clearTimeout(_state.longPressTimer);
        _state.idleTimer = setTimeout(showPlayer, IDLE_TIMEOUT);
        if (_state.isDragging) setTimeout(() => { _state.justDragged = false; }, 50);
        _state.isPressing = false;
        _state.isDragging = false;
        dom.galleryContainer.classList.remove('active');
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
    };
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
}

function onGalleryItemClick(e) {
    if (_state.justDragged) return; // 如果是拖拽结束，则不触发点击事件

    // =========================================================================
    // 【核心修改】点击后，通过 `src` 查找最新的 `index` 来播放
    // =========================================================================
    const item = e.target.closest('.gallery-item[data-src]');
    if (item) {
        const trackSrc = item.dataset.src;
        if (!trackSrc) return;

        // 在当前的播放列表状态中查找该歌曲的最新索引
        const trackIndex = getters.playlist().findIndex(t => t.src === trackSrc);

        // 只有当歌曲仍然存在于播放列表中时才进行播放
        if (trackIndex !== -1) {
            mutations.setCurrentTrackIndex(trackIndex);
            mutations.setIsPlaying(true);
            showPlayer();
        } else {
            // 可选：提示用户该歌曲已被移除
            console.warn(`[Gallery] 尝试播放的歌曲 (src: ${trackSrc}) 已不在播放列表中。`);
        }
    }
    // =========================================================================
}

const handleResize = debounce(updateGallery, 250);

// --- 公共 API ---

export function startAutoScroll() {
    _state.isAutoScrolling = true;
    _state.velocity = { x: 0, y: 0 };
    dom.galleryContainer.removeEventListener('mousedown', onPointerDown);
}

export function stopAutoScroll() {
    _state.isAutoScrolling = false;
    dom.galleryContainer.addEventListener('mousedown', onPointerDown);
}

/**
 * 初始化背景画廊组件。
 */
export function init() {
    if (_state.isInitialized) return;

    subscribe('playlistChanged', (playlist) => {
        if (playlist && playlist.length > 0) {
            updateGallery();
        } else {
            dom.galleryWrapper.innerHTML = '';
            _state.renderedCells.clear();
        }
    });

    subscribe('screensaverModeChanged', (isActive) => {
        if (isActive) {
            startAutoScroll();
            dom.playerContainer.classList.add('screensaver-active');
        } else {
            stopAutoScroll();
            dom.playerContainer.classList.remove('screensaver-active');
        }
    });

    dom.galleryContainer.addEventListener('mousedown', onPointerDown);
    dom.galleryContainer.addEventListener('click', onGalleryItemClick);
    window.addEventListener('resize', handleResize);

    // 初始化画廊的中心位置
    const centerOffset = { x: (-5 * (ITEM_WIDTH + GAP)) / 2, y: (-5 * (ITEM_WIDTH + GAP)) / 2 };
    _state.currentPos = { ...centerOffset };
    _state.targetPos = { ...centerOffset };

    updateGallery();
    animate();
    _state.isInitialized = true;
    console.log("Gallery Component initialized.");
}