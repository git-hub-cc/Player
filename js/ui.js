// js/ui.js
import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { getTemplate } from './utils.js';

let toastTimeout;
let lastActiveLyricIndex = -1;
let glitchAnimationId;

// --- 【重写】故障效果函数 ---
/**
 * 触发一个持续、逐渐减弱的“故障”效果。
 * @param {number} duration - 效果持续的总毫秒数。
 */
export function triggerGlitchEffect(duration = 800) { // 默认值可以设小一点，但外部调用会传入3000
    if (!dom.mainView || !dom.glitchOverlay || !dom.feTurbulence) return;

    cancelAnimationFrame(glitchAnimationId);

    let startTime = null;

    const primaryColor = getComputedStyle(dom.docElement).getPropertyValue('--primary-color').trim();
    const whiteColor = '#FFFFFF';

    const animateGlitch = (currentTime) => {
        if (!startTime) startTime = currentTime;
        const elapsedTime = currentTime - startTime;

        if (elapsedTime >= duration) {
            // 动画结束，清理现场
            dom.mainView.classList.remove('glitching');
            dom.glitchOverlay.classList.remove('active');
            dom.glitchLinesGroup.innerHTML = '';
            dom.glitchSpotifyShapesGroup.innerHTML = '';
            dom.feDisplacementMap.setAttribute('scale', '0');
            dom.feOffsetR.setAttribute('dx', '0');
            dom.feOffsetB.setAttribute('dx', '0');
            return;
        }

        // --- 动画核心逻辑 ---
        const progress = elapsedTime / duration; // 动画进度，从 0.0 到 1.0

        // 1. 随机化滤镜种子以保持动态
        dom.feTurbulence.setAttribute('seed', Math.random() * 200);

        // 2. 位移强度：从一个较高的值（如80）随时间衰减到0。使用平方函数使衰减更自然。
        const displacementIntensity = Math.pow(1 - progress, 2) * 80;
        dom.feDisplacementMap.setAttribute('scale', String(displacementIntensity));

        // 3. 色差分离：同样从一个较高的值随时间衰减，并带有随机抖动。
        const aberrationAmount = Math.pow(1 - progress, 3) * 30 * (Math.random() - 0.5);
        dom.feOffsetR.setAttribute('dx', String(aberrationAmount));
        dom.feOffsetB.setAttribute('dx', String(-aberrationAmount));

        // 4. 动态生成并渲染Spotify波形条和扫描线
        dom.glitchLinesGroup.innerHTML = '';
        dom.glitchSpotifyShapesGroup.innerHTML = '';

        // 生成波形条：出现的概率和不透明度随时间降低
        // (progress < 0.7) 让它在后半段完全消失，更干净利落
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
                // 不透明度也随时间减弱
                bar.setAttribute('opacity', (Math.random() * 0.5 + 0.3) * (1 - progress));
                dom.glitchSpotifyShapesGroup.appendChild(bar);
            }
        }

        // 生成扫描线：出现的概率、高度和不透明度都随时间降低
        if (Math.random() > progress * 0.5) {
            const numLines = Math.floor(Math.random() * 4) + 1;
            for (let i = 0; i < numLines; i++) {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                line.setAttribute('x', '0');
                line.setAttribute('y', Math.random() * 100 + '%');
                line.setAttribute('width', '100%');
                // 线条高度随时间变细
                line.setAttribute('height', (Math.random() * 3 + 1) * (1 - progress) + 'px');
                line.setAttribute('fill', whiteColor);
                // 不透明度随时间减弱
                line.setAttribute('opacity', (Math.random() * 0.2) * (1 - progress));
                dom.glitchLinesGroup.appendChild(line);
            }
        }

        glitchAnimationId = requestAnimationFrame(animateGlitch);
    };

    // 启动动画
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
        lineNode.querySelector('p').textContent = line.text || '...';
        fragment.appendChild(lineNode);
    });
    dom.lyricsList.appendChild(fragment);
    lastActiveLyricIndex = -1;
}

export function syncLyrics(currentTime) {
    if (state.parsedLyrics.length === 0) return;
    const allLyricLines = dom.getLyricLines();
    const activeIndex = state.parsedLyrics.findIndex((line, i) => {
        const nextLine = state.parsedLyrics[i + 1];
        return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
    });
    if (activeIndex !== -1 && activeIndex !== lastActiveLyricIndex) {
        if (lastActiveLyricIndex !== -1 && allLyricLines[lastActiveLyricIndex]) {
            allLyricLines[lastActiveLyricIndex].classList.remove('active');
        }
        const activeLineElement = allLyricLines[activeIndex];
        if (activeLineElement) {
            activeLineElement.classList.add('active');
            const listWrapper = dom.lyricsListWrapper;
            const listHeight = listWrapper.clientHeight;
            const lineTop = activeLineElement.offsetTop;
            const lineHeight = activeLineElement.clientHeight;
            const translateY = listHeight / 2 - lineTop - lineHeight / 2;
            dom.lyricsList.style.transform = `translateY(${translateY}px)`;
        }
        lastActiveLyricIndex = activeIndex;
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
    dom.galleryView.classList.toggle('active');
    if (dom.galleryView.classList.contains('active')) {
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