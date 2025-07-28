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

// --- 优化点 1: 播放列表过滤 ---
// 使用 CSS class 控制显隐，避免直接操作 style 导致的性能问题
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

        const isMatch = !query || // 如果查询为空，则全部匹配
            title.toLowerCase().includes(query) ||
            artist.toLowerCase().includes(query) ||
            pinyin.includes(query) ||
            initials.includes(query);

        // 使用 classList.toggle 的第二个参数，更简洁高效
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

// --- 优化点 2: 统一状态管理 ---
// 此函数现在仅负责更新UI，不再显示Toast，因为Toast由state.js中的setter触发
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

export function toggleImmersiveMode() {
    const isCurrentlyImmersive = dom.playerContainer.classList.contains('immersive-mode');
    if (!isCurrentlyImmersive) {
        dom.playerContainer.classList.add('immersive-mode');
        dom.immersiveBtn.title = "退出沉浸模式";
        if (dom.docElement.requestFullscreen) {
            dom.docElement.requestFullscreen().catch(err => {
                console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                dom.playerContainer.classList.remove('immersive-mode');
                dom.immersiveBtn.title = "沉浸模式";
            });
        }
    } else {
        dom.playerContainer.classList.remove('immersive-mode');
        dom.immersiveBtn.title = "沉浸模式";
        if (dom.getFullscreenElement()) dom.exitFullscreen();
    }
}

export function handleFullscreenChange() {
    const isInFullscreen = !!dom.getFullscreenElement();
    if (!isInFullscreen && dom.playerContainer.classList.contains('immersive-mode')) {
        dom.playerContainer.classList.remove('immersive-mode');
        dom.immersiveBtn.title = "沉浸模式";
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