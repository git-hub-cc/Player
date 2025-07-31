// js/features/background-gallery.js

import * as dom from '../dom.js';
import { DEFAULT_ART } from '../config.js';
import { loadTrack } from '../player.js';
import { getTemplate } from '../utils.js';

// --- 配置项 ---
const ITEM_WIDTH = 280;
const ITEM_ASPECT_RATIO = 1;
const ITEM_HEIGHT = ITEM_WIDTH / ITEM_ASPECT_RATIO;
const GAP = 30;
const RENDER_BUFFER = 1;
const LONG_PRESS_DURATION = 300;
const FRICTION = 0.92;
const IDLE_TIMEOUT = 3000;
const DRAG_THRESHOLD = 5;

// --- 状态变量 ---
const state = {
    isInitialized: false,
    isPressing: false,
    isDragging: false,
    justDragged: false,
    longPressTimer: null,
    startPos: { x: 0, y: 0 },
    currentPos: { x: 0, y: 0 },
    targetPos: { x: 0, y: 0 },
    lastUpdatePos: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    lastMoveTime: 0,
    lastMovePos: { x: 0, y: 0 },
    animationFrame: null,
    playlistData: [],
    renderedCells: new Map(),
    idleTimer: null,
};

// --- 播放器显隐控制 ---
function showPlayer() {
    clearTimeout(state.idleTimer);
    dom.playerContainer.classList.remove('hidden-by-gallery');
}

function hidePlayer() {
    clearTimeout(state.idleTimer);
    dom.playerContainer.classList.add('hidden-by-gallery');
}

// --- 核心：虚拟化渲染 ---
function updateGallery() {
    state.lastUpdatePos = { ...state.targetPos };
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const fullItemWidth = ITEM_WIDTH + GAP;
    const fullItemHeight = ITEM_HEIGHT + GAP;

    const startCol = Math.floor(-state.targetPos.x / fullItemWidth) - RENDER_BUFFER;
    const endCol = Math.floor((-state.targetPos.x + viewportWidth) / fullItemWidth) + RENDER_BUFFER;
    const startRow = Math.floor(-state.targetPos.y / fullItemHeight) - RENDER_BUFFER;
    const endRow = Math.floor((-state.targetPos.y + viewportHeight) / fullItemHeight) + RENDER_BUFFER;

    for (const [cellId, element] of state.renderedCells.entries()) {
        const [row, col] = cellId.split(',').map(Number);
        if (row < startRow || row > endRow || col < startCol || col > endCol) {
            element.remove();
            state.renderedCells.delete(cellId);
        }
    }

    const fragment = document.createDocumentFragment();

    for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
            const cellId = `${row},${col}`;
            if (!state.renderedCells.has(cellId)) {
                const itemNode = getTemplate('template-gallery-item');
                const item = itemNode.querySelector('.gallery-item');
                if (!item) continue;

                const x = col * fullItemWidth + GAP;
                const y = row * fullItemHeight + GAP;
                item.style.setProperty('--x', `${x}px`);
                item.style.setProperty('--y', `${y}px`);

                const hash = Math.abs(row * 31 + col * 37);
                const trackIndex = hash % state.playlistData.length;
                const track = state.playlistData[trackIndex];
                item.dataset.index = trackIndex;

                const artUrl = track.albumArt || DEFAULT_ART;
                const artElement = item.querySelector('.gallery-item-art');
                artElement.alt = track.title;
                item.querySelector('.gallery-item-title').textContent = track.title || '未知标题';
                item.querySelector('.gallery-item-artist').textContent = track.artist || '未知艺术家';

                artElement.onload = () => {
                    try {
                        const canvas = dom.bgCanvas;
                        const ctx = dom.bgCtx;
                        const size = 50;
                        canvas.width = size;
                        canvas.height = size;
                        ctx.drawImage(artElement, 0, 0, size, size);
                        const p = ctx.getImageData(1, 1, 1, 1).data;
                        const borderColor = `rgb(${p[0]}, ${p[1]}, ${p[2]})`;
                        item.style.setProperty('--gallery-item-border-color', borderColor);
                    } catch (e) {
                        console.warn("Could not extract border color for gallery item.", e);
                        item.style.setProperty('--gallery-item-border-color', 'var(--highlight-bg)');
                    }
                };
                artElement.onerror = () => {
                    item.style.setProperty('--gallery-item-border-color', 'var(--highlight-bg)');
                };
                artElement.src = artUrl;
                if (artElement.complete && artElement.naturalWidth > 0) {
                    artElement.onload();
                }

                fragment.appendChild(item);
                requestAnimationFrame(() => item.classList.add('visible'));
                state.renderedCells.set(cellId, item);
            }
        }
    }
    dom.galleryWrapper.appendChild(fragment);
}

function animate() {
    state.currentPos.x += (state.targetPos.x - state.currentPos.x) * 0.1;
    state.currentPos.y += (state.targetPos.y - state.currentPos.y) * 0.1;

    if (!state.isDragging && (Math.abs(state.velocity.x) > 0.01 || Math.abs(state.velocity.y) > 0.01)) {
        state.velocity.x *= FRICTION;
        state.velocity.y *= FRICTION;
        state.targetPos.x += state.velocity.x;
        state.targetPos.y += state.velocity.y;
    }

    dom.galleryWrapper.style.transform = `translate(${state.currentPos.x}px, ${state.currentPos.y}px)`;
    const movedDistance = Math.hypot(state.targetPos.x - state.lastUpdatePos.x, state.targetPos.y - state.lastUpdatePos.y);
    if (movedDistance > ITEM_WIDTH / 2) {
        updateGallery();
    }
    state.animationFrame = requestAnimationFrame(animate);
}

function onPointerDown(e) {
    e.preventDefault();
    hidePlayer();
    state.isPressing = true;
    state.justDragged = false;
    state.startPos = { x: e.clientX, y: e.clientY };
    const dragStartTarget = { ...state.targetPos };
    state.velocity = { x: 0, y: 0 };
    state.lastMoveTime = Date.now();
    state.lastMovePos = { ...state.startPos };

    state.longPressTimer = setTimeout(() => {
        state.isDragging = true;
        dom.galleryContainer.classList.add('active');
    }, LONG_PRESS_DURATION);

    const onPointerMove = (e) => {
        if (!state.isPressing) return;
        e.preventDefault();
        const currentMovePos = { x: e.clientX, y: e.clientY };
        const deltaX = currentMovePos.x - state.startPos.x;
        const deltaY = currentMovePos.y - state.startPos.y;

        if (!state.isDragging && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD) {
            clearTimeout(state.longPressTimer);
            state.isDragging = true;
            dom.galleryContainer.classList.add('active');
        }

        if (state.isDragging) {
            const now = Date.now();
            const deltaTime = now - state.lastMoveTime;
            state.targetPos.x = dragStartTarget.x + deltaX;
            state.targetPos.y = dragStartTarget.y + deltaY;
            if (deltaTime > 0) {
                const speedMultiplier = 16.67;
                state.velocity.x = (currentMovePos.x - state.lastMovePos.x) / deltaTime * speedMultiplier;
                state.velocity.y = (currentMovePos.y - state.lastMovePos.y) / deltaTime * speedMultiplier;
            }
            state.lastMoveTime = now;
            state.lastMovePos = currentMovePos;
            state.justDragged = true;
        }
    };

    const onPointerUp = () => {
        clearTimeout(state.longPressTimer);
        state.idleTimer = setTimeout(showPlayer, IDLE_TIMEOUT);
        if (state.isDragging) setTimeout(() => { state.justDragged = false; }, 50);
        state.isPressing = false;
        state.isDragging = false;
        dom.galleryContainer.classList.remove('active');
        window.removeEventListener('mousemove', onPointerMove);
        window.removeEventListener('mouseup', onPointerUp);
    };

    window.addEventListener('mousemove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp, { passive: false });
}

function onGalleryItemClick(e) {
    if (state.justDragged) return;
    const item = e.target.closest('.gallery-item');
    if (!item) return;

    const trackIndex = parseInt(item.dataset.index, 10);
    if (!isNaN(trackIndex)) {
        // 【修改】点击画廊项时，强制播放
        loadTrack(trackIndex, { forcePlay: true });
        showPlayer();
    }
}

export function init(data) {
    if (state.isInitialized || !data || data.length === 0) return;
    state.playlistData = data;
    dom.galleryContainer.addEventListener('mousedown', onPointerDown);
    dom.galleryContainer.addEventListener('click', onGalleryItemClick);

    const centerOffset = {
        x: (-5 * (ITEM_WIDTH + GAP)) / 2,
        y: (-5 * (ITEM_HEIGHT + GAP)) / 2,
    };
    state.currentPos = { ...centerOffset };
    state.targetPos = { ...centerOffset };

    updateGallery();
    animate();
    state.isInitialized = true;
}