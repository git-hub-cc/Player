// js/ui.js
import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { getTemplate, formatTime, rgbToHsl, hslToRgb } from './utils.js';
import { playTrack, pauseTrack } from './player.js';

let toastTimeout;
let lastActiveLyricIndex = -1;
let glitchAnimationId;

// --- 面板管理 ---
const allSidePanels = [dom.playlistPanel, dom.infoPanel, dom.shortcutPanel, dom.downloadPanel];

let visualizerDataArray = null;
let visualizerBufferLength = 0;

export function closeActivePanels() {
    allSidePanels.forEach(panel => {
        if (panel) panel.classList.remove('active');
    });
}

function manageSidePanel(panelToToggle) {
    if (!panelToToggle) return;
    const isCurrentlyActive = panelToToggle.classList.contains('active');
    closeActivePanels();
    if (!isCurrentlyActive) {
        panelToToggle.classList.add('active');
    }
}

// =========================================================================
// 【新增】切换空状态视图的函数
// =========================================================================
export function toggleEmptyState(isEmpty) {
    if (isEmpty) {
        // 显示空状态
        dom.mainView.classList.add('is-empty');

        // 【优化】禁用底部控制栏
        dom.playerControls.classList.add('disabled');

        // 重置背景为默认渐变
        dom.mainView.style.background = 'linear-gradient(145deg, #2a2a2a, #121212)';
        state.setCurrentGradientColors(null);

        // 清空播放信息
        dom.trackTitleEl.textContent = '等待播放';
        // 【修改】将提示文案改为通用描述
        dom.trackArtistEl.textContent = '请添加媒体资源';
        dom.currentTimeEl.textContent = '0:00';
        dom.durationEl.textContent = '0:00';
        dom.progressBar.value = 0;
        dom.progressBar.style.setProperty('--value-percent', '0%');
    } else {
        // 隐藏空状态，恢复正常
        dom.mainView.classList.remove('is-empty');
        dom.playerControls.classList.remove('disabled');
    }
}
// =========================================================================

export function drawVisualizer() {
    if (!state.analyser || !dom.audioVisualizer || !dom.albumArtContainer) return;

    // 首次调用时初始化数据数组
    if (!visualizerDataArray) {
        visualizerBufferLength = state.analyser.frequencyBinCount;
        visualizerDataArray = new Uint8Array(visualizerBufferLength);
    }

    state.analyser.getByteFrequencyData(visualizerDataArray);

    const canvas = dom.audioVisualizer;
    const ctx = canvas.getContext('2d');

    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }

    const { width: canvasWidth, height: canvasHeight } = canvas;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const albumArtSize = dom.albumArtContainer.offsetWidth;
    if (albumArtSize === 0) return;

    const centerX = canvasWidth / 2;
    const centerY = canvasHeight / 2;
    const halfSize = albumArtSize / 2;

    const barWidth = 3;
    const maxBarHeight = 100;
    const numBars = 64;

    // --- 实时动态色彩计算 ---
    let startColor, endColor;
    if (state.currentGradientColors && state.currentGradientColors.length > 0) {
        const baseRgb = state.currentGradientColors[1];
        const baseHsl = rgbToHsl(baseRgb[0], baseRgb[1], baseRgb[2]);

        const newHue = (baseHsl.h + 30) % 360;
        const newSat = Math.min(baseHsl.s + 0.15, 1.0);
        const newLight = Math.min(baseHsl.l + 0.2, 0.85);

        const newRgb = hslToRgb(newHue, newSat, newLight);

        startColor = `rgba(${newRgb[0]}, ${newRgb[1]}, ${newRgb[2]}, 0.3)`;
        endColor = `rgba(${newRgb[0]}, ${newRgb[1]}, ${newRgb[2]}, 0.8)`;
    } else {
        startColor = 'rgba(29, 185, 84, 0.2)';
        endColor = 'rgba(29, 185, 84, 0.8)';
    }
    // --- 动态色彩计算结束 ---

    ctx.lineWidth = barWidth;
    ctx.lineCap = 'round';

    const halfPerimeter = albumArtSize * 2;
    const step = halfPerimeter / numBars;

    for (let i = 0; i < numBars; i++) {
        const dataIndex = Math.floor((numBars - 1 - i) * (visualizerBufferLength * 0.75) / numBars);
        const barHeight = Math.pow(visualizerDataArray[dataIndex] / 255, 2.5) * maxBarHeight;

        if (barHeight < 1) continue;

        const p = i * step;
        let x, y, dx, dy;

        if (p < halfSize) { // 底部边缘 (右半)
            x = centerX + p; y = centerY + halfSize; dx = 0; dy = 1;
        } else if (p < halfSize + albumArtSize) { // 右侧边缘
            x = centerX + halfSize; y = centerY + halfSize - (p - halfSize); dx = 1; dy = 0;
        } else { // 顶部边缘 (右半)
            x = centerX + halfSize - (p - (halfSize + albumArtSize)); y = centerY - halfSize; dx = 0; dy = -1;
        }

        const startX = x, startY = y;
        const endX = x + dx * barHeight, endY = y + dy * barHeight;

        let gradient = ctx.createLinearGradient(startX, startY, endX, endY);
        gradient.addColorStop(0, startColor);
        gradient.addColorStop(1, endColor);
        ctx.strokeStyle = gradient;

        // 绘制右侧
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        // 绘制左侧镜像
        const mStartX = 2 * centerX - x, mStartY = y;
        const mEndX = 2 * centerX - endX, mEndY = endY;

        gradient = ctx.createLinearGradient(mStartX, mStartY, mEndX, mEndY);
        gradient.addColorStop(0, startColor);
        gradient.addColorStop(1, endColor);
        ctx.strokeStyle = gradient;

        ctx.beginPath();
        ctx.moveTo(mStartX, mStartY);
        ctx.lineTo(mEndX, mEndY);
        ctx.stroke();
    }
}

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
                bar.setAttribute('x', (i / numBars) * 100 + (Math.random() - 0.5) * 5 + '%');
                bar.setAttribute('y', (100 - (Math.random() * 40 + 5)) / 2 + '%');
                bar.setAttribute('width', (Math.random() * 2 + 1) + '%');
                bar.setAttribute('height', (Math.random() * 40 + 5) + '%');
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

export function syncLyrics(currentTime) {
    if (state.isDraggingLyrics || state.parsedLyrics.length === 0) return;
    const allLyricLines = dom.getLyricLines();
    const listWrapper = dom.lyricsListWrapper;
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
                activeLineElement.classList.remove('particlized');
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
}

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
    dom.playlistEl.querySelectorAll('.playlist-item.active').forEach(item => item.classList.remove('active'));
    if (dom.searchResultsList) {
        dom.searchResultsList.querySelectorAll('.playlist-item.active').forEach(item => item.classList.remove('active'));
    }

    if (state.temporaryPlayingTrack) {
        const srcToFind = state.temporaryPlayingTrack.originalSrc || state.temporaryPlayingTrack.src;
        if (srcToFind && dom.searchResultsList) {
            const activeItem = dom.searchResultsList.querySelector(`.playlist-item[data-src="${srcToFind}"]`);
            if (activeItem) {
                activeItem.classList.add('active');
            }
        }
    } else if (state.currentTrackIndex > -1) {
        const activeItem = dom.playlistEl.querySelector(`.playlist-item[data-index="${state.currentTrackIndex}"]`);
        if (activeItem) {
            activeItem.classList.add('active');
        }
    }
}


export function filterPlaylist() {
    const query = dom.playlistSearchInput.value.toLowerCase().replace(/\s/g, '');
    const playlistItems = dom.getAllPlaylistItems();
    let hasVisibleItems = false;
    const noResultsEl = dom.playlistEl.querySelector('#playlist-no-results');
    state.playlist.forEach((track, index) => {
        const item = playlistItems[index];
        if (!item) return;
        const isMatch = !query ||
            (track.title || '').toLowerCase().includes(query) ||
            (track.artist || '').toLowerCase().includes(query) ||
            (track.pinyin || '').includes(query) ||
            (track.initials || '').includes(query);
        item.classList.toggle('hidden', !isMatch);
        if (isMatch) hasVisibleItems = true;
    });
    if (noResultsEl) {
        noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
    }
}

export function toggleLyricsPanel() { dom.lyricsContainer.classList.toggle('active'); }
export function togglePlaylistPanel() { manageSidePanel(dom.playlistPanel); }
export function toggleInfoPanel() { manageSidePanel(dom.infoPanel); }
export function toggleShortcutPanel() { manageSidePanel(dom.shortcutPanel); }
export function toggleDownloadPanel() { manageSidePanel(dom.downloadPanel); }

export function showToast(message, type = 'info') {
    clearTimeout(toastTimeout);
    dom.toastEl.textContent = message;
    dom.toastEl.className = 'toast show';
    if (type === 'error') dom.toastEl.classList.add('error');
    else if (type === 'success') dom.toastEl.classList.add('success');
    toastTimeout = setTimeout(() => {
        dom.toastEl.classList.remove('show');
    }, 3000);
}

export function showConfirmationModal(message) {
    return new Promise((resolve, reject) => {
        dom.confirmationMessage.textContent = message;
        dom.confirmationModal.classList.add('visible');
        const cleanupAndResolve = () => {
            dom.confirmationModal.classList.remove('visible');
            removeListeners();
            resolve();
        };
        const cleanupAndReject = () => {
            dom.confirmationModal.classList.remove('visible');
            removeListeners();
            reject();
        };
        const onConfirm = () => cleanupAndResolve();
        const onCancel = () => cleanupAndReject();
        const onOverlayClick = (e) => { if (e.target === dom.confirmationModal) onCancel(); };
        const onEscKey = (e) => { if (e.key === 'Escape') onCancel(); };
        const removeListeners = () => {
            dom.confirmBtn.removeEventListener('click', onConfirm);
            dom.cancelBtn.removeEventListener('click', onCancel);
            dom.confirmationModal.removeEventListener('click', onOverlayClick);
            window.removeEventListener('keydown', onEscKey);
        };
        dom.confirmBtn.addEventListener('click', onConfirm, { once: true });
        dom.cancelBtn.addEventListener('click', onCancel, { once: true });
        dom.confirmationModal.addEventListener('click', onOverlayClick);
        window.addEventListener('keydown', onEscKey);
    });
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
    const titles = { 'list': '列表循环', 'single': '单曲循环', 'shuffle': '随机播放' };
    dom.modeBtn.title = titles[currentMode];
}

export function extractAndApplyGradient(sourceElement) {
    if (!sourceElement || (sourceElement.tagName === 'IMG' && (!sourceElement.complete || sourceElement.naturalWidth === 0)) || (sourceElement.tagName === 'VIDEO' && sourceElement.readyState < 2)) {
        dom.mainView.style.background = '';
        state.setCurrentGradientColors(null); // 【修改】重置颜色状态
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
        dom.mainView.style.background = `linear-gradient(145deg, rgba(${p1[0]}, ${p1[1]}, ${p1[2]}, 0.8), rgba(${p2[0]}, ${p2[1]}, ${p2[2]}, 0.7) 45%, rgba(${p3[0]}, ${p3[1]}, ${p3[2]}, 0.7) 55%, rgba(${p4[0]}, ${p4[1]}, ${p4[2]}, 0.8)), #121212`;

        // 【修改】保存提取的颜色以供可视化使用
        state.setCurrentGradientColors([[p1[0], p1[1], p1[2]], [p4[0], p4[1], p4[2]]]);
    } catch (e) {
        console.error("Error extracting colors:", e);
        dom.mainView.style.background = '';
        state.setCurrentGradientColors(null); // 【修改】重置颜色状态
    }
}

export function hideContextMenu() { if (dom.contextMenu) dom.contextMenu.style.display = 'none'; }

export function renderContextMenu(context = {}) {
    const menuList = dom.getContextMenuList();
    if (!menuList) return;
    menuList.innerHTML = '';
    const fragment = dom.createFragment();
    if (context.type === 'playlist-item' && typeof context.index !== 'undefined') {
        const deleteLi = dom.createListItem();
        deleteLi.textContent = '删除';
        deleteLi.dataset.action = 'delete-track';
        deleteLi.dataset.index = context.index;
        fragment.appendChild(deleteLi);
    }
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

export function clearSearchResults() {
    if (dom.searchResultsList) {
        dom.searchResultsList.innerHTML = '';
    }
}

function createResultItem(track, index, isCached = false) {
    const itemNode = getTemplate('template-search-result-item');
    const itemEl = itemNode.querySelector('.playlist-item');
    itemEl.dataset.index = index;
    itemEl.dataset.src = track.originalSrc || track.src;
    itemEl.querySelector('.playlist-icon').textContent = track.type === 'video' ? '🎬' : '🎵';
    itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
    itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';
    const downloadBtn = itemEl.querySelector('.playlist-download-btn');
    downloadBtn.classList.toggle('cached', isCached);
    return itemNode;
}

export function renderSearchResults(tracks) {
    clearSearchResults();
    const fragment = dom.createFragment();
    tracks.forEach((track, index) => {
        const isAlreadyInPlaylist = state.playlist.some(pTrack =>
            pTrack.title === track.title && pTrack.artist === track.artist && !pTrack.src.startsWith('http')
        );
        fragment.appendChild(createResultItem(track, index, isAlreadyInPlaylist));
    });
    dom.searchResultsList.appendChild(fragment);
}

export function updateSearchResultItemStatus(itemElement, status) {
    if (!itemElement) return;
    const downloadBtn = itemElement.querySelector('.playlist-download-btn');
    if (!downloadBtn) return;
    downloadBtn.classList.remove('downloading', 'cached');
    if (status === 'downloading') {
        downloadBtn.classList.add('downloading');
    } else if (status === 'cached') {
        downloadBtn.classList.add('cached');
    }
}

export function renderPaginationControls(currentPage, totalPages) {
    const container = dom.paginationControls;
    container.innerHTML = '';

    if (totalPages <= 1) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';

    const prevBtn = document.createElement('button');
    prevBtn.id = 'prev-page-btn';
    prevBtn.className = 'pagination-btn';
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path></svg>';
    prevBtn.title = '上一页';
    prevBtn.disabled = currentPage <= 1;

    const pageInfo = document.createElement('span');
    pageInfo.className = 'page-info';
    pageInfo.textContent = `${currentPage} / ${totalPages}`;

    const nextBtn = document.createElement('button');
    nextBtn.id = 'next-page-btn';
    nextBtn.className = 'pagination-btn';
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>';
    nextBtn.title = '下一页';
    nextBtn.disabled = currentPage >= totalPages;

    container.appendChild(prevBtn);
    container.appendChild(pageInfo);
    container.appendChild(nextBtn);
}

let wasPlayingBeforeDrag = false;
let dragStartY = 0;
let initialTranslateY = 0;
let targetTimeOnDragEnd = 0;

function onLyricsDragStart(e) {
    if (state.parsedLyrics.length === 0 || e.button !== 0) return;
    e.preventDefault();
    state.setIsDraggingLyrics(true);
    wasPlayingBeforeDrag = state.isPlaying;
    if (wasPlayingBeforeDrag) pauseTrack();
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
    const newTranslateY = initialTranslateY + (e.clientY - dragStartY);
    dom.lyricsList.style.transform = `translateY(${newTranslateY}px)`;
    const wrapperRect = dom.lyricsListWrapper.getBoundingClientRect();
    const centerLineY = wrapperRect.top + wrapperRect.height / 2;
    let closestLineIndex = -1;
    let minDistance = Infinity;
    dom.getLyricLines().forEach((line, index) => {
        const lineRect = line.getBoundingClientRect();
        const distance = Math.abs((lineRect.top + lineRect.height / 2) - centerLineY);
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
    if (targetTimeOnDragEnd >= 0) {
        dom.mediaPlayer.currentTime = targetTimeOnDragEnd;
    }
    if (wasPlayingBeforeDrag) playTrack();
    syncLyrics(dom.mediaPlayer.currentTime);
}

export function setupLyricsDragHandler() {
    dom.lyricsListWrapper.addEventListener('mousedown', onLyricsDragStart);
}