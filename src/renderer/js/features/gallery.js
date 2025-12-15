// src/renderer/js/features/gallery.js

/**
 * @file 背景画廊组件 (Gallery Component)
 * @description
 * 负责渲染和控制可交互的背景封面画廊。
 * 这是一个独立的UI组件，它订阅播放列表状态的变化来更新自身内容，
 * 并通过请求状态变更来与应用的其他部分交互。
 *
 * 工作流程:
 * 1. 初始化时，订阅 `playlistChanged` 事件。
 * 2. 监听用户交互（拖拽、点击），并更新自身的内部状态（位置、速度等）。
 * 3. 当用户点击某个封面时，不直接调用播放器，而是调用 `state.mutations` 来
 *    请求更改当前轨道和播放状态，实现与播放核心的解耦。
 */

import * as dom from '../dom.js';
// --- 核心修复：正确导入 subscribe 函数 ---
import { getters, mutations, subscribe } from '../state.js';
import { DEFAULT_ART } from '../config.js';
import * as ICONS from '../icons.js';
import { getTemplate } from '../utils.js';

// --- 配置项 ---
const ITEM_WIDTH = 280;
const GAP = 30;
const RENDER_BUFFER = 1;         // 视口外额外渲染的行列数
const LONG_PRESS_DURATION = 300; // 长按触发拖拽的阈值
const FRICTION = 0.92;           // 惯性滚动的摩擦力
const IDLE_TIMEOUT = 3000;       // 拖拽后播放器自动显示前的延迟
const DRAG_THRESHOLD = 5;        // 触发拖拽的最小像素移动距离
const AUTO_SCROLL_SPEED = 0.3;   // 屏保模式下的自动滚动速度

// --- 模块内部状态 ---
const _state = {
    isInitialized: false,
    isPressing: false,
    isDragging: false,
    justDragged: false,         // 用于区分拖拽结束和单击
    longPressTimer: null,
    startPos: { x: 0, y: 0 },
    currentPos: { x: 0, y: 0 }, // 平滑动画的当前位置
    targetPos: { x: 0, y: 0 },  // 拖拽或惯性的目标位置
    velocity: { x: 0, y: 0 },
    lastMoveTime: 0,
    lastMovePos: { x: 0, y: 0 },
    animationFrame: null,
    renderedCells: new Map(),   // 虚拟化渲染的单元格缓存
    idleTimer: null,
    isAutoScrolling: false,
};


/** 节流函数，用于优化resize事件处理 */
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
 * 虚拟化渲染，只创建视口内的 DOM 元素。
 */
function updateGallery() {
    const playlistData = getters.playlist();
    if (playlistData.length === 0) {
        // 如果播放列表为空，则清空画廊
        dom.galleryWrapper.innerHTML = '';
        _state.renderedCells.clear();
        return;
    }

    _state.lastUpdatePos = { ..._state.targetPos };
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fullItemWidth = ITEM_WIDTH + GAP;
    const fullItemHeight = ITEM_WIDTH + GAP; // 保持正方形

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
                item.dataset.index = trackIndex;

                const artElement = item.querySelector('.gallery-item-art');
                artElement.src = track.albumArt || DEFAULT_ART;
                item.querySelector('.gallery-item-title').textContent = track.title || '未知标题';
                item.querySelector('.gallery-item-artist').textContent = track.artist || '未知艺术家';

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
                requestAnimationFrame(() => item.classList.add('visible'));
                _state.renderedCells.set(cellId, item);
            }
        }
    }
    dom.galleryWrapper.appendChild(fragment);
}

function animate() {
    _state.currentPos.x += (_state.targetPos.x - _state.currentPos.x) * 0.1;
    _state.currentPos.y += (_state.targetPos.y - _state.currentPos.y) * 0.1;

    if (_state.isAutoScrolling) {
        _state.targetPos.x -= AUTO_SCROLL_SPEED;
    } else if (!_state.isDragging && (Math.abs(_state.velocity.x) > 0.01 || Math.abs(_state.velocity.y) > 0.01)) {
        _state.velocity.x *= FRICTION;
        _state.velocity.y *= FRICTION;
        _state.targetPos.x += _state.velocity.x;
        _state.targetPos.y += _state.velocity.y;
    }

    dom.galleryWrapper.style.transform = `translate(${_state.currentPos.x}px, ${_state.currentPos.y}px)`;

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
    if (_state.justDragged) return;
    const item = e.target.closest('.gallery-item[data-index]');
    if (item) {
        const trackIndex = parseInt(item.dataset.index, 10);
        if (!isNaN(trackIndex)) {
            mutations.setCurrentTrackIndex(trackIndex);
            mutations.setIsPlaying(true);
            showPlayer();
        }
    }
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

    // --- 核心修复：直接调用 subscribe 函数 ---
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

    const centerOffset = { x: (-5 * (ITEM_WIDTH + GAP)) / 2, y: (-5 * (ITEM_WIDTH + GAP)) / 2 };
    _state.currentPos = { ...centerOffset };
    _state.targetPos = { ...centerOffset };

    updateGallery();
    animate();
    _state.isInitialized = true;
    console.log("Gallery Component initialized.");
}