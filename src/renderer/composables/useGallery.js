// src/renderer/composables/useGallery.js
/**
 * @file 背景画廊 Composable
 * @description 封装背景画廊的虚拟化渲染和交互逻辑。
 * 从原 gallery.js 迁移，使用 Pinia store 代替旧 state.js。
 */

import { watch } from 'vue';
import { usePlayerStore } from '../stores/playerStore.js';
import { DEFAULT_ART } from '../js/config.js';
import * as ICONS from '../js/icons.js';

// --- 配置 ---
const ITEM_WIDTH = 280;
const GAP = 30;
const RENDER_BUFFER = 1;
const LONG_PRESS_DURATION = 300;
const FRICTION = 0.92;
const IDLE_TIMEOUT = 3000;
const DRAG_THRESHOLD = 5;
const AUTO_SCROLL_SPEED = 0.3;

// DOM 引用
let _galleryContainer = null;
let _galleryWrapper = null;
let _playerContainer = null;
let _bgCanvas = null;
let _bgCtx = null;
let _resizeHandler = null; // 保存监听引用以便卸载时清理

// 模块内部状态
const _s = {
    isInitialized: false,
    isPressing: false,
    isDragging: false,
    justDragged: false,
    longPressTimer: null,
    startPos: { x: 0, y: 0 },
    currentPos: { x: 0, y: 0 },
    targetPos: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    lastMoveTime: 0,
    lastMovePos: { x: 0, y: 0 },
    animationFrame: null,
    renderedCells: new Map(),
    idleTimer: null,
    isAutoScrolling: false,
    lastUpdatePos: { x: 0, y: 0 },
};

function debounce(func, delay) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

function showPlayer() {
    clearTimeout(_s.idleTimer);
    _playerContainer?.classList.remove('hidden-by-gallery');
}

function hidePlayer() {
    clearTimeout(_s.idleTimer);
    _playerContainer?.classList.add('hidden-by-gallery');
}

function updateGallery(store) {
    const playlistData = store.filteredPlaylist;
    if (!_galleryWrapper) return;

    if (playlistData.length === 0) {
        _galleryWrapper.innerHTML = '';
        _s.renderedCells.clear();
        return;
    }

    _s.lastUpdatePos = { ..._s.targetPos };
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fullItemWidth = ITEM_WIDTH + GAP;
    const fullItemHeight = ITEM_WIDTH + GAP;

    const startCol = Math.floor(-_s.targetPos.x / fullItemWidth) - RENDER_BUFFER;
    const endCol = Math.floor((-_s.targetPos.x + viewportWidth) / fullItemWidth) + RENDER_BUFFER;
    const startRow = Math.floor(-_s.targetPos.y / fullItemHeight) - RENDER_BUFFER;
    const endRow = Math.floor((-_s.targetPos.y + viewportHeight) / fullItemHeight) + RENDER_BUFFER;

    for (const [cellId, element] of _s.renderedCells.entries()) {
        const [row, col] = cellId.split(',').map(Number);
        if (row < startRow || row > endRow || col < startCol || col > endCol) {
            element.remove();
            _s.renderedCells.delete(cellId);
        }
    }

    const fragment = document.createDocumentFragment();

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            const cellId = `${row},${col}`;
            if (!_s.renderedCells.has(cellId)) {
                const item = document.createElement('div');
                item.className = 'gallery-item';

                const x = col * fullItemWidth + GAP;
                const y = row * fullItemHeight + GAP;
                item.style.setProperty('--x', `${x}px`);
                item.style.setProperty('--y', `${y}px`);

                const hash = Math.abs(row * 31 + col * 37);
                const trackIndex = hash % playlistData.length;
                const track = playlistData[trackIndex];
                if (!track) continue;

                item.dataset.src = track.src;
                item.innerHTML = `
                    <img class="gallery-item-art" alt="" loading="lazy" crossorigin="anonymous">
                    <div class="gallery-item-overlay">
                        <div class="gallery-item-play-icon">${ICONS.ICON_GALLERY_PLAY}</div>
                        <div class="gallery-item-details">
                            <h4 class="gallery-item-title">${track.title || '未知标题'}</h4>
                            <p class="gallery-item-artist">${track.artist || '未知艺术家'}</p>
                        </div>
                    </div>`;

                const artElement = item.querySelector('.gallery-item-art');
                artElement.src = track.albumArt || DEFAULT_ART;

                artElement.onload = () => {
                    try {
                        if (!_bgCanvas || !_bgCtx) return;
                        _bgCanvas.width = 50; _bgCanvas.height = 50;
                        _bgCtx.drawImage(artElement, 0, 0, 50, 50);
                        const p = _bgCtx.getImageData(1, 1, 1, 1).data;
                        item.style.setProperty('--gallery-item-border-color', `rgb(${p[0]}, ${p[1]}, ${p[2]})`);
                    } catch {
                        item.style.setProperty('--gallery-item-border-color', 'var(--highlight-bg)');
                    }
                };
                if (artElement.complete) artElement.onload();

                fragment.appendChild(item);
                requestAnimationFrame(() => item.classList.add('visible'));
                _s.renderedCells.set(cellId, item);
            }
        }
    }
    _galleryWrapper.appendChild(fragment);
}

function animate(store) {
    _s.currentPos.x += (_s.targetPos.x - _s.currentPos.x) * 0.1;
    _s.currentPos.y += (_s.targetPos.y - _s.currentPos.y) * 0.1;

    if (_s.isAutoScrolling) {
        _s.targetPos.x -= AUTO_SCROLL_SPEED;
    } else if (!_s.isDragging && (Math.abs(_s.velocity.x) > 0.01 || Math.abs(_s.velocity.y) > 0.01)) {
        _s.velocity.x *= FRICTION;
        _s.velocity.y *= FRICTION;
        _s.targetPos.x += _s.velocity.x;
        _s.targetPos.y += _s.velocity.y;
    }

    if (_galleryWrapper) {
        _galleryWrapper.style.transform = `translate(${_s.currentPos.x}px, ${_s.currentPos.y}px)`;
    }

    const movedDistance = Math.hypot(
        _s.targetPos.x - (_s.lastUpdatePos?.x || 0),
        _s.targetPos.y - (_s.lastUpdatePos?.y || 0)
    );
    if (movedDistance > ITEM_WIDTH / 2) {
        updateGallery(store);
    }
    _s.animationFrame = requestAnimationFrame(() => animate(store));
}

function onPointerDown(e, store) {
    if (_s.isAutoScrolling) return;
    e.preventDefault();
    hidePlayer();
    _s.isPressing = true;
    _s.justDragged = false;
    _s.startPos = { x: e.clientX, y: e.clientY };
    const dragStartTarget = { ..._s.targetPos };
    _s.velocity = { x: 0, y: 0 };
    _s.lastMoveTime = Date.now();
    _s.lastMovePos = { ..._s.startPos };
    _s.longPressTimer = setTimeout(() => {
        _s.isDragging = true;
        _galleryContainer?.classList.add('active');
    }, LONG_PRESS_DURATION);

    const onPointerMove = (e) => {
        if (!_s.isPressing) return;
        const currentMovePos = { x: e.clientX, y: e.clientY };
        const deltaX = currentMovePos.x - _s.startPos.x;
        const deltaY = currentMovePos.y - _s.startPos.y;
        if (!_s.isDragging && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD) {
            clearTimeout(_s.longPressTimer);
            _s.isDragging = true;
            _galleryContainer?.classList.add('active');
        }
        if (_s.isDragging) {
            const now = Date.now();
            const deltaTime = now - _s.lastMoveTime;
            _s.targetPos.x = dragStartTarget.x + deltaX;
            _s.targetPos.y = dragStartTarget.y + deltaY;
            if (deltaTime > 0) {
                _s.velocity.x = (currentMovePos.x - _s.lastMovePos.x) / deltaTime * 16.67;
                _s.velocity.y = (currentMovePos.y - _s.lastMovePos.y) / deltaTime * 16.67;
            }
            _s.lastMoveTime = now;
            _s.lastMovePos = currentMovePos;
            _s.justDragged = true;
        }
    };

    const onPointerUp = () => {
        clearTimeout(_s.longPressTimer);
        _s.idleTimer = setTimeout(showPlayer, IDLE_TIMEOUT);
        if (_s.isDragging) setTimeout(() => { _s.justDragged = false; }, 50);
        _s.isPressing = false;
        _s.isDragging = false;
        _galleryContainer?.classList.remove('active');
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
    };
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
}

function onGalleryItemClick(e, store) {
    if (_s.justDragged) return;
    const item = e.target.closest('.gallery-item[data-src]');
    if (item) {
        const trackSrc = item.dataset.src;
        if (!trackSrc) return;
        const trackIndex = store.playlist.findIndex(t => t.src === trackSrc);
        if (trackIndex !== -1) {
            store.setCurrentTrackIndex(trackIndex);
            store.setIsPlaying(true);
            showPlayer();
        }
    }
}

export function startAutoScroll() {
    _s.isAutoScrolling = true;
    _s.velocity = { x: 0, y: 0 };
    if (_galleryContainer) {
        _galleryContainer._pointerDownHandler && _galleryContainer.removeEventListener('mousedown', _galleryContainer._pointerDownHandler);
    }
}

export function stopAutoScroll(store) {
    _s.isAutoScrolling = false;
    if (_galleryContainer && store) {
        const handler = (e) => onPointerDown(e, store);
        _galleryContainer._pointerDownHandler = handler;
        _galleryContainer.addEventListener('mousedown', handler);
    }
}

/**
 * 初始化背景画廊 Composable
 */
export function useGallery({ galleryContainer, galleryWrapper, playerContainer, bgCanvas, bgCtx }) {
    _galleryContainer = galleryContainer;
    _galleryWrapper = galleryWrapper;
    _playerContainer = playerContainer;
    _bgCanvas = bgCanvas;
    _bgCtx = bgCtx;

    const store = usePlayerStore();

    if (_s.isInitialized) return;

    // 监听播放列表和过滤模式变化
    watch(() => [store.playlist, store.mediaFilterMode], () => {
        updateGallery(store);
    }, { deep: false });

    // 监听屏保模式
    watch(() => store.isScreensaverMode, (isActive) => {
        if (isActive) {
            startAutoScroll();
            _playerContainer?.classList.add('screensaver-active');
        } else {
            stopAutoScroll(store);
            _playerContainer?.classList.remove('screensaver-active');
        }
    });

    // 绑定事件
    const pointerDownHandler = (e) => onPointerDown(e, store);
    _galleryContainer._pointerDownHandler = pointerDownHandler;
    _galleryContainer.addEventListener('mousedown', pointerDownHandler);
    _galleryContainer.addEventListener('click', (e) => onGalleryItemClick(e, store));
    _resizeHandler = debounce(() => updateGallery(store), 250);
    window.addEventListener('resize', _resizeHandler);

    // 初始化位置
    const centerOffset = { x: (-5 * (ITEM_WIDTH + GAP)) / 2, y: (-5 * (ITEM_WIDTH + GAP)) / 2 };
    _s.currentPos = { ...centerOffset };
    _s.targetPos = { ...centerOffset };

    updateGallery(store);
    animate(store);
    _s.isInitialized = true;
}

/** 卸载时调用，停止动画帧并清理全局事件监听，防止内存泄漏 */
export function cleanupGallery() {
    if (_s.animationFrame !== null) {
        cancelAnimationFrame(_s.animationFrame);
        _s.animationFrame = null;
    }
    if (_resizeHandler) {
        window.removeEventListener('resize', _resizeHandler);
        _resizeHandler = null;
    }
    _s.isInitialized = false;
}
