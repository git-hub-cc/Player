// js/ui.js
import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES } from './config.js';
import { getTemplate } from './utils.js';

let toastTimeout;
let lastActiveLyricIndex = -1;

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

    const fragment = document.createDocumentFragment();
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
    const allLyricLines = dom.lyricsList.querySelectorAll('p');
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
            const listWrapper = document.getElementById('lyrics-list-wrapper');
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
    const fragment = document.createDocumentFragment();
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
    document.querySelectorAll('.playlist-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.index) === state.currentTrackIndex);
    });
}

export function filterPlaylist() {
    const query = dom.playlistSearchInput.value.toLowerCase().replace(/\s/g, '');
    const playlistItems = dom.playlistEl.querySelectorAll('.playlist-item');
    let hasVisibleItems = false;
    const noResultsEl = document.getElementById('playlist-no-results');

    if (!query) {
        playlistItems.forEach(item => { item.style.display = 'flex'; });
        if (noResultsEl) noResultsEl.style.display = 'none';
        return;
    }
    state.playlist.forEach((track, index) => {
        const title = track.title || '';
        const artist = track.artist || '';
        const pinyin = track.pinyin || '';
        const initials = track.initials || '';
        const isMatch = title.toLowerCase().includes(query) || artist.toLowerCase().includes(query) || pinyin.includes(query) || initials.includes(query);
        if (playlistItems[index]) {
            playlistItems[index].style.display = isMatch ? 'flex' : 'none';
            if (isMatch) hasVisibleItems = true;
        }
    });
    if (noResultsEl) noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
}

export function toggleLyricsPanel() { dom.lyricsContainer.classList.toggle('active'); }
export function togglePlaylistPanel() { dom.playlistPanel.classList.toggle('active'); }
export function toggleInfoPanel() { dom.infoPanel.classList.toggle('active'); }
export function toggleShortcutPanel() { dom.shortcutPanel.classList.toggle('active'); }

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
    showToast(`播放模式: ${title}`);
}

const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
export function extractAndApplyGradient(sourceElement) {
    if (!sourceElement || (sourceElement.tagName === 'IMG' && (!sourceElement.complete || sourceElement.naturalWidth === 0)) || (sourceElement.tagName === 'VIDEO' && sourceElement.readyState < 2)) {
        dom.mainView.style.background = '';
        return;
    }
    try {
        const w = bgCanvas.width = 100;
        const h = bgCanvas.height = 100;
        bgCtx.drawImage(sourceElement, 0, 0, w, h);
        const p1 = bgCtx.getImageData(1, 1, 1, 1).data;
        const p2 = bgCtx.getImageData(w - 2, 1, 1, 1).data;
        const p3 = bgCtx.getImageData(1, h - 2, 1, 1).data;
        const p4 = bgCtx.getImageData(w - 2, h - 2, 1, 1).data;
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

export function toggleImmersiveMode() {
    const isCurrentlyImmersive = dom.playerContainer.classList.contains('immersive-mode');
    if (!isCurrentlyImmersive) {
        dom.playerContainer.classList.add('immersive-mode');
        dom.immersiveBtn.title = "退出沉浸模式";
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                dom.playerContainer.classList.remove('immersive-mode');
                dom.immersiveBtn.title = "沉浸模式";
            });
        }
    } else {
        dom.playerContainer.classList.remove('immersive-mode');
        dom.immersiveBtn.title = "沉浸模式";
        if (document.fullscreenElement) document.exitFullscreen();
    }
}

export function handleFullscreenChange() {
    const isInFullscreen = !!document.fullscreenElement;
    if (!isInFullscreen && dom.playerContainer.classList.contains('immersive-mode')) {
        dom.playerContainer.classList.remove('immersive-mode');
        dom.immersiveBtn.title = "沉浸模式";
    }
}

export function hideContextMenu() {
    if (dom.contextMenu) dom.contextMenu.style.display = 'none';
}

export function renderContextMenu() {
    const menuList = dom.contextMenu.querySelector('ul');
    if (!menuList) return;
    menuList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const actionId in state.shortcutSettings) {
        const setting = state.shortcutSettings[actionId];
        const li = document.createElement('li');
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