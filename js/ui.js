// js/ui.js
import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { getTemplate, formatTime } from './utils.js';
import { playTrack, pauseTrack } from './player.js';

let toastTimeout;
let lastActiveLyricIndex = -1;
let glitchAnimationId;

// --- 粒子系统变量 ---
let particleCanvas;
let particleCtx;
let particles = [];
let particleAnimationId;

/**
 * 设置粒子效果的Canvas
 */
export function setupParticleCanvas() {
    particleCanvas = document.createElement('canvas');
    particleCtx = particleCanvas.getContext('2d', { willReadFrequently: true });
    particleCanvas.id = 'particle-canvas';
    dom.mainView.appendChild(particleCanvas);
}

/**
 * 粒子动画循环
 */
function animateParticles() {
    if (!particleCanvas || !particleCtx) return;

    if (particleCanvas.width !== dom.mainView.offsetWidth || particleCanvas.height !== dom.mainView.offsetHeight) {
        particleCanvas.width = dom.mainView.offsetWidth;
        particleCanvas.height = dom.mainView.offsetHeight;
    }

    particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        p.vx *= 0.97;
        p.vy += 0.15;
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.015;

        if (p.alpha <= 0) {
            particles.splice(i, 1);
        } else {
            particleCtx.fillStyle = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${p.alpha})`;
            particleCtx.fillRect(p.x, p.y, p.size, p.size);
        }
    }

    if (particles.length > 0) {
        particleAnimationId = requestAnimationFrame(animateParticles);
    } else {
        particleAnimationId = null;
    }
}

/**
 * 【重写】从HTML元素创建粒子，使其在容器顶部中心产生
 * @param {HTMLElement} element - 要为其创建粒子的歌词P元素
 * @param {DOMRect} wrapperRect - #lyrics-list-wrapper 的位置和尺寸
 */
function createParticlesFromElement(element, wrapperRect) {
    if (!element || !particleCanvas || !particleCtx || element.dataset.particlized === 'true' || !wrapperRect) {
        return;
    }
    element.dataset.particlized = 'true';

    const mainViewRect = dom.mainView.getBoundingClientRect();

    particleCanvas.width = dom.mainView.offsetWidth;
    particleCanvas.height = dom.mainView.offsetHeight;

    const computedStyle = window.getComputedStyle(element);
    const font = `${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;
    const color = computedStyle.color;
    const text = element.textContent;

    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');

    // 我们只需要渲染一行文本的高度即可
    const lineHeight = parseFloat(computedStyle.lineHeight);
    tempCanvas.width = wrapperRect.width;
    tempCanvas.height = lineHeight;

    tempCtx.font = font;
    tempCtx.fillStyle = color;
    tempCtx.textBaseline = 'middle';
    tempCtx.textAlign = 'center'; // 文字居中
    tempCtx.fillText(text, tempCanvas.width / 2, tempCanvas.height / 2);

    // 只读取这一行渲染出的像素
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
    const density = 2;

    // 计算粒子产生的Y坐标基线：容器顶部
    const startY = wrapperRect.top - mainViewRect.top;

    for (let y = 0; y < tempCanvas.height; y += density) {
        for (let x = 0; x < tempCanvas.width; x += density) {
            const index = (y * tempCanvas.width + x) * 4;
            const alpha = imageData[index + 3];

            if (alpha > 128) {
                const r = imageData[index];
                const g = imageData[index + 1];
                const b = imageData[index + 2];

                particles.push({
                    // X坐标相对于容器中心散开
                    x: (wrapperRect.left - mainViewRect.left) + x,
                    // Y坐标从容器顶部开始
                    y: startY + y,
                    vx: (Math.random() - 0.5) * 4,
                    vy: (Math.random() - 0.5) * 3 - 1, // 轻微向上弹跳
                    alpha: Math.random() * 0.6 + 0.4,
                    size: Math.random() * 1.5 + 1,
                    color: { r, g, b }
                });
            }
        }
    }

    element.classList.add('particles-active');

    if (!particleAnimationId) {
        animateParticles();
    }
}


// --- 重写故障效果函数 (代码保持不变) ---
export function triggerGlitchEffect(duration = 800) {
    if (!dom.mainView || !dom.glitchOverlay || !dom.feTurbulence) return;
    cancelAnimationFrame(glitchAnimationId);
    let startTime = null;
    const primaryColor = getComputedStyle(dom.docElement).getPropertyValue('--primary-color').trim();
    const whiteColor = '#FFFFFF';
    const animateGlitch = (currentTime) => {
        if (!startTime) startTime = currentTime;
        const elapsedTime = currentTime - startTime;
        if (elapsedTime >= duration) {
            dom.mainView.classList.remove('glitching');
            dom.glitchOverlay.classList.remove('active');
            dom.glitchLinesGroup.innerHTML = '';
            dom.glitchSpotifyShapesGroup.innerHTML = '';
            dom.feDisplacementMap.setAttribute('scale', '0');
            dom.feOffsetR.setAttribute('dx', '0');
            dom.feOffsetB.setAttribute('dx', '0');
            return;
        }
        const progress = elapsedTime / duration;
        dom.feTurbulence.setAttribute('seed', Math.random() * 200);
        const displacementIntensity = Math.pow(1 - progress, 2) * 80;
        dom.feDisplacementMap.setAttribute('scale', String(displacementIntensity));
        const aberrationAmount = Math.pow(1 - progress, 3) * 30 * (Math.random() - 0.5);
        dom.feOffsetR.setAttribute('dx', String(aberrationAmount));
        dom.feOffsetB.setAttribute('dx', String(-aberrationAmount));
        dom.glitchLinesGroup.innerHTML = '';
        dom.glitchSpotifyShapesGroup.innerHTML = '';
        if (progress < 0.7 && Math.random() > progress * 1.2) {
            const numBars = Math.floor(Math.random() * 15) + 5;
            for (let i = 0; i < numBars; i++) {
                const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const barWidth = (Math.random() * 2 + 1) + '%';
                const barHeight = (Math.random() * 40 + 5) + '%';
                const barX = (i / numBars) * 100 + (Math.random() - 0.5) * 5 + '%';
                const barY = (100 - parseFloat(barHeight)) / 2 + '%';
                bar.setAttribute('x', barX);
                bar.setAttribute('y', barY);
                bar.setAttribute('width', barWidth);
                bar.setAttribute('height', barHeight);
                bar.setAttribute('fill', primaryColor);
                bar.setAttribute('opacity', (Math.random() * 0.5 + 0.3) * (1 - progress));
                dom.glitchSpotifyShapesGroup.appendChild(bar);
            }
        }
        if (Math.random() > progress * 0.5) {
            const numLines = Math.floor(Math.random() * 4) + 1;
            for (let i = 0; i < numLines; i++) {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                line.setAttribute('x', '0');
                line.setAttribute('y', Math.random() * 100 + '%');
                line.setAttribute('width', '100%');
                line.setAttribute('height', (Math.random() * 3 + 1) * (1 - progress) + 'px');
                line.setAttribute('fill', whiteColor);
                line.setAttribute('opacity', (Math.random() * 0.2) * (1 - progress));
                dom.glitchLinesGroup.appendChild(line);
            }
        }
        glitchAnimationId = requestAnimationFrame(animateGlitch);
    };
    dom.mainView.classList.add('glitching');
    dom.glitchOverlay.classList.add('active');
    glitchAnimationId = requestAnimationFrame(animateGlitch);
}


export function showSkeleton() {
    dom.playerContainer.classList.add('loading');
    dom.skeletonOverlay.classList.add('active');
}
export function hideSkeleton() {
    dom.skeletonOverlay.classList.remove('active');
    dom.playerContainer.classList.remove('loading');
}

export function renderLyrics() {
    dom.lyricsList.innerHTML = '';
    dom.lyricsList.style.transform = 'translateY(0)';

    if (state.parsedLyrics.length === 0) {
        dom.lyricsList.appendChild(getTemplate('template-no-lyrics'));
        return;
    }

    const fragment = dom.createFragment();
    state.parsedLyrics.forEach(line => {
        const lineNode = getTemplate('template-lyric-line');
        const p = lineNode.querySelector('p');
        p.textContent = line.text || '...';
        fragment.appendChild(lineNode);
    });
    dom.lyricsList.appendChild(fragment);
    lastActiveLyricIndex = -1;
}

// =================================================================
// =================== FUNÇÃO CORRIGIDA ABAIXO =====================
// =================================================================
export function syncLyrics(currentTime) {
    if (state.isDraggingLyrics) return;
    if (state.parsedLyrics.length === 0) return;

    const allLyricLines = dom.getLyricLines();
    const listWrapper = dom.lyricsListWrapper;
    const wrapperRect = listWrapper.getBoundingClientRect(); // 获取一次即可

    const activeIndex = state.parsedLyrics.findIndex((line, i) => {
        const nextLine = state.parsedLyrics[i + 1];
        return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });

    if (activeIndex !== -1) {
        if (activeIndex !== lastActiveLyricIndex) {
            if (lastActiveLyricIndex !== -1 && allLyricLines[lastActiveLyricIndex]) {
                allLyricLines[lastActiveLyricIndex].classList.remove('active');
            }
            const activeLineElement = allLyricLines[activeIndex];
            if (activeLineElement) {
                // Ao se tornar ativa, garantimos que a linha não seja uma partícula
                activeLineElement.classList.remove('particles-active');
                activeLineElement.dataset.particlized = 'false';
                activeLineElement.classList.add('active');
            }
            lastActiveLyricIndex = activeIndex;
        }

        const activeLineElement = allLyricLines[activeIndex];
        if (activeLineElement) {
            const listHeight = listWrapper.clientHeight;
            const lineTop = activeLineElement.offsetTop;
            const lineHeight = activeLineElement.clientHeight;
            const translateY = listHeight / 2 - lineTop - lineHeight / 2;
            dom.lyricsList.style.transform = `translateY(${translateY}px)`;
        }
    }

    // --- 【LÓGICA DE PARTÍCULAS CORRIGIDA】 ---
    allLyricLines.forEach((line) => {
        const lineRect = line.getBoundingClientRect();

        // CONDIÇÃO 1: A linha de letra rolou para FORA da tela (no topo)
        // E ainda não foi transformada em partículas.
        if (lineRect.bottom < wrapperRect.top && line.dataset.particlized !== 'true') {
            createParticlesFromElement(line, wrapperRect);

            // CONDIÇÃO 2: A linha de letra está DENTRO da tela
            // E ela havia sido transformada em partículas anteriormente.
        } else if (lineRect.bottom >= wrapperRect.top && line.dataset.particlized === 'true') {
            // Reverte o estado, tornando a letra visível novamente.
            line.dataset.particlized = 'false';
            line.classList.remove('particles-active');
        }
    });
}
// =================================================================
// =================== FIM DA FUNÇÃO CORRIGIDA =====================
// =================================================================


export function renderPlaylist() {
    dom.playlistEl.innerHTML = '';
    const fragment = dom.createFragment();
    state.playlist.forEach((track, index) => {
        const itemNode = getTemplate('template-playlist-item');
        const itemEl = itemNode.querySelector('.playlist-item');
        itemEl.dataset.index = index;
        itemEl.querySelector('.playlist-icon').textContent = track.type === 'video' ? '🎬' : '🎵';
        itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
        itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';
        fragment.appendChild(itemNode);
    });
    fragment.appendChild(getTemplate('template-playlist-no-results'));
    dom.playlistEl.appendChild(fragment);
}

export function updatePlaylistUI() {
    dom.getAllPlaylistItems().forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.index) === state.currentTrackIndex);
    });
}

export function filterPlaylist() {
    const query = dom.playlistSearchInput.value.toLowerCase().replace(/\s/g, '');
    const playlistItems = dom.getAllPlaylistItems();
    let hasVisibleItems = false;
    const noResultsEl = dom.playlistNoResultsEl;

    state.playlist.forEach((track, index) => {
        const item = playlistItems[index];
        if (!item) return;

        const title = track.title || '';
        const artist = track.artist || '';
        const pinyin = track.pinyin || '';
        const initials = track.initials || '';

        const isMatch = !query ||
            title.toLowerCase().includes(query) ||
            artist.toLowerCase().includes(query) ||
            pinyin.includes(query) ||
            initials.includes(query);

        item.classList.toggle('hidden', !isMatch);
        if (isMatch) hasVisibleItems = true;
    });

    if (noResultsEl) {
        noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
    }
}


export function toggleLyricsPanel() { dom.lyricsContainer.classList.toggle('active'); }
export function togglePlaylistPanel() { dom.playlistPanel.classList.toggle('active'); }
export function toggleInfoPanel() { dom.infoPanel.classList.toggle('active'); }
export function toggleShortcutPanel() { dom.shortcutPanel.classList.toggle('active'); }

export function toggleGalleryView() {
    dom.galleryContainer.classList.toggle('active');
    if (dom.galleryContainer.classList.contains('active')) {
        hideContextMenu();
    }
}

export function showToast(message) {
    clearTimeout(toastTimeout);
    dom.toastEl.textContent = message;
    dom.toastEl.classList.add('show');
    toastTimeout = setTimeout(() => {
        dom.toastEl.classList.remove('show');
    }, 3000);
}

export function updateVolumeBarVisual(volume, isMuted) {
    const volumePercent = isMuted ? 0 : volume * 100;
    dom.volumeBar.value = isMuted ? 0 : volume;
    dom.volumeBar.style.setProperty('--value-percent', `${volumePercent}%`);
    dom.volumeBtn.classList.toggle('muted', isMuted || volume === 0);
}

export function updateModeButton() {
    const currentMode = PLAY_MODES[state.currentModeIndex];
    dom.modeBtn.className = 'control-btn';
    dom.modeBtn.classList.add(`mode-${currentMode}`);
    let title = '';
    if (currentMode === 'list') title = '列表循环';
    else if (currentMode === 'single') title = '单曲循环';
    else if (currentMode === 'shuffle') title = '随机播放';
    dom.modeBtn.title = title;
}

export function extractAndApplyGradient(sourceElement) {
    if (!sourceElement || (sourceElement.tagName === 'IMG' && (!sourceElement.complete || sourceElement.naturalWidth === 0)) || (sourceElement.tagName === 'VIDEO' && sourceElement.readyState < 2)) {
        dom.mainView.style.background = '';
        return;
    }
    try {
        const w = dom.bgCanvas.width = 100;
        const h = dom.bgCanvas.height = 100;
        dom.bgCtx.drawImage(sourceElement, 0, 0, w, h);
        const p1 = dom.bgCtx.getImageData(1, 1, 1, 1).data;
        const p2 = dom.bgCtx.getImageData(w - 2, 1, 1, 1).data;
        const p3 = dom.bgCtx.getImageData(1, h - 2, 1, 1).data;
        const p4 = dom.bgCtx.getImageData(w - 2, h - 2, 1, 1).data;
        const color1 = `rgba(${p1[0]}, ${p1[1]}, ${p1[2]}, 0.8)`;
        const color2 = `rgba(${p2[0]}, ${p2[1]}, ${p2[2]}, 0.7)`;
        const color3 = `rgba(${p3[0]}, ${p3[1]}, ${p3[2]}, 0.7)`;
        const color4 = `rgba(${p4[0]}, ${p4[1]}, ${p4[2]}, 0.8)`;
        dom.mainView.style.background = `linear-gradient(145deg, ${color1}, ${color2} 45%, ${color3} 55%, ${color4}), #121212`;
    } catch (e) {
        console.error("Error extracting colors:", e);
        dom.mainView.style.background = '';
    }
}

export function hideContextMenu() {
    if (dom.contextMenu) dom.contextMenu.style.display = 'none';
}

export function renderContextMenu() {
    const menuList = dom.getContextMenuList();
    if (!menuList) return;
    menuList.innerHTML = '';
    const fragment = dom.createFragment();
    for (const actionId in state.shortcutSettings) {
        const setting = state.shortcutSettings[actionId];
        const li = dom.createListItem();
        li.textContent = setting.label;
        li.dataset.action = actionId;
        fragment.appendChild(li);
    }
    menuList.appendChild(fragment);
}

export function normalizePosition(mouseX, mouseY) {
    const { innerWidth: windowWidth, innerHeight: windowHeight } = window;
    const menu = dom.contextMenu;
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    let normalizedX = mouseX;
    let normalizedY = mouseY;
    if (mouseX + menuWidth > windowWidth) normalizedX = windowWidth - menuWidth - 5;
    if (mouseY + menuHeight > windowHeight) normalizedY = windowHeight - menuHeight - 5;
    return { normalizedX, normalizedY };
}

// --- 【新增】歌词拖拽功能 ---

let wasPlayingBeforeDrag = false;
let dragStartY = 0;
let initialTranslateY = 0;
let targetTimeOnDragEnd = 0;

function onLyricsDragStart(e) {
    if (state.parsedLyrics.length === 0) return;
    // 只响应鼠标左键
    if (e.button !== 0) return;

    e.preventDefault();
    state.setIsDraggingLyrics(true);

    wasPlayingBeforeDrag = state.isPlaying;
    if (wasPlayingBeforeDrag) {
        pauseTrack();
    }

    dom.lyricsList.classList.add('dragging');
    dom.lyricsDragIndicator.classList.add('active');

    dragStartY = e.clientY;
    const currentTransform = dom.lyricsList.style.transform;
    initialTranslateY = currentTransform ? parseFloat(currentTransform.match(/-?[\d.]+/)[0]) : 0;

    window.addEventListener('mousemove', onLyricsDragMove);
    window.addEventListener('mouseup', onLyricsDragEnd);
}

function onLyricsDragMove(e) {
    if (!state.isDraggingLyrics) return;
    e.preventDefault();

    const deltaY = e.clientY - dragStartY;
    const newTranslateY = initialTranslateY + deltaY;
    dom.lyricsList.style.transform = `translateY(${newTranslateY}px)`;

    // 找到中心线对应的歌词
    const wrapperRect = dom.lyricsListWrapper.getBoundingClientRect();
    const centerLineY = wrapperRect.top + wrapperRect.height / 2;

    let closestLineIndex = -1;
    let minDistance = Infinity;

    dom.getLyricLines().forEach((line, index) => {
        const lineRect = line.getBoundingClientRect();
        const lineCenterY = lineRect.top + lineRect.height / 2;
        const distance = Math.abs(centerLineY - lineCenterY);

        if (distance < minDistance) {
            minDistance = distance;
            closestLineIndex = index;
        }
    });

    if (closestLineIndex !== -1 && state.parsedLyrics[closestLineIndex]) {
        targetTimeOnDragEnd = state.parsedLyrics[closestLineIndex].time;
        dom.lyricsDragTime.textContent = formatTime(targetTimeOnDragEnd);
    }
}

function onLyricsDragEnd(e) {
    if (!state.isDraggingLyrics) return;
    e.preventDefault();

    state.setIsDraggingLyrics(false);
    dom.lyricsList.classList.remove('dragging');
    dom.lyricsDragIndicator.classList.remove('active');

    window.removeEventListener('mousemove', onLyricsDragMove);
    window.removeEventListener('mouseup', onLyricsDragEnd);

    // 应用新的播放时间
    if (targetTimeOnDragEnd >= 0) {
        dom.mediaPlayer.currentTime = targetTimeOnDragEnd;
    }

    if (wasPlayingBeforeDrag) {
        playTrack();
    }
    // 强制调用一次 syncLyrics 来校准位置
    syncLyrics(dom.mediaPlayer.currentTime);
}

export function setupLyricsDragHandler() {
    dom.lyricsListWrapper.addEventListener('mousedown', onLyricsDragStart);
}