// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, extractAndApplyGradient, showSkeleton, hideSkeleton, updatePlaylistUI, updateModeButton, showToast, triggerGlitchEffect } from './ui.js';

// --- requestAnimationFrame ---
let animationFrameId = null;
let skeletonTimer = null;

export async function loadTrack(trackIndex, options = {}) {
    const { fromHistory = false, forcePlay = false } = options;

    if (skeletonTimer) {
        clearTimeout(skeletonTimer);
        skeletonTimer = null;
    }

    if (state.playlist.length === 0) return;

    if (forcePlay) {
        state.setIsPlaying(true);
    }

    state.setCurrentTrackIndex(trackIndex);
    const track = state.playlist[trackIndex];

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";
    const artUrl = track.albumArt || DEFAULT_ART;
    dom.albumArtEl.src = artUrl;
    dom.controlAlbumArtEl.src = artUrl;

    let lyricsToParse = (track.lyrics || '')
        .replace(/\[/g, '\n[')
        .replace(/\n{2,}/g, '\n')
        .replace(/^\n/, '');
    state.setParsedLyrics(parseLRC(lyricsToParse));
    renderLyrics();
    updatePlaylistUI();

    let loadedOnce = false;
    const handleMediaReady = () => {
        if (!loadedOnce) {
            hideSkeleton();
            updateProgress();
            if (state.isPlaying) {
                playTrack();
            }
            loadedOnce = true;
        }
    };

    const handleError = (e) => {
        console.error("媒体加载错误:", e);
        if (skeletonTimer) clearTimeout(skeletonTimer);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放此媒体";
        dom.mainView.style.background = '';
    };

    dom.mediaPlayer.oncanplay = null;
    dom.mediaPlayer.onloadedmetadata = null;
    dom.albumArtEl.onload = null;
    dom.mediaPlayer.onerror = handleError;

    if (track.type === 'audio') {
        dom.albumArtContainer.style.display = 'flex';
        dom.mediaPlayer.style.display = 'none';
        dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
        if (dom.albumArtEl.complete && dom.albumArtEl.naturalWidth > 0) {
            extractAndApplyGradient(dom.albumArtEl);
        } else {
            dom.mainView.style.background = '';
        }
    } else { // 'video'
        dom.albumArtContainer.style.display = 'none';
        dom.mediaPlayer.style.display = 'block';
        dom.mainView.style.background = '';
        dom.mediaPlayer.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
    }

    dom.mediaPlayer.src = track.src;
    dom.mediaPlayer.load();
    dom.mediaPlayer.oncanplay = handleMediaReady;
    dom.mediaPlayer.onloadedmetadata = updateProgress;

    if (!fromHistory) {
        const newUrl = `#track=${trackIndex + 1}`;
        if (window.location.hash !== newUrl || (history.state && history.state.trackIndex !== trackIndex)) {
            history.pushState({ trackIndex: trackIndex }, track.title || '', newUrl);
        }
    }
}

function runAnimationFrame() {
    updateProgress();
    animationFrameId = requestAnimationFrame(runAnimationFrame);
}

export function playTrack() {
    if (state.playlist.length === 0 || !dom.mediaPlayer.src) return;
    const playPromise = dom.mediaPlayer.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            state.setIsPlaying(true);
            dom.playPauseBtn.classList.add('playing');
            dom.playPauseBtn.title = '暂停';
            if (animationFrameId === null) {
                runAnimationFrame();
            }
        }).catch(e => {
            if (e.name !== 'AbortError') console.error("播放失败:", e);
        });
    }
}

export function pauseTrack() {
    dom.mediaPlayer.pause();
    state.setIsPlaying(false);
    dom.playPauseBtn.classList.remove('playing');
    dom.playPauseBtn.title = '播放';
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
}

export const togglePlayPause = () => state.isPlaying ? pauseTrack() : playTrack();

function changeTrack(direction) {
    if (state.playlist.length <= 1) return;

    triggerGlitchEffect(3000);
    clearTimeout(skeletonTimer);
    skeletonTimer = setTimeout(() => {
        showSkeleton();
    }, 3000);

    setTimeout(() => {
        let newIndex;
        if (direction === 1) { // 下一首
            const currentMode = PLAY_MODES[state.currentModeIndex];
            if (currentMode === 'shuffle') {
                do {
                    newIndex = Math.floor(Math.random() * state.playlist.length);
                } while (newIndex === state.currentTrackIndex);
            } else {
                newIndex = (state.currentTrackIndex + 1) % state.playlist.length;
            }
        } else { // 上一首
            newIndex = (state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length;
        }
        loadTrack(newIndex, { forcePlay: true });
    }, 150);
}

export function playNextTrack() {
    changeTrack(1);
}

export function playPrevTrack() {
    changeTrack(-1);
}

export function updateProgress() {
    // 【关键修复】如果用户正在拖动进度条，则不执行此函数，以防止UI冲突
    if (state.isScrubbing) return;

    const { duration, currentTime } = dom.mediaPlayer;
    let progressPercent = 0;

    if (!isNaN(duration) && duration > 0) {
        progressPercent = (currentTime / duration) * 100;
        dom.progressBar.value = progressPercent;
        dom.durationEl.textContent = formatTime(duration);
    } else {
        dom.progressBar.value = 0;
        dom.durationEl.textContent = "0:00";
    }

    dom.progressBar.style.setProperty('--value-percent', `${progressPercent}%`);
    dom.currentTimeEl.textContent = formatTime(currentTime);
    syncLyrics(currentTime);
}

export function cyclePlayMode() {
    const oldIndex = state.currentModeIndex;
    const newModeIndex = (state.currentModeIndex + 1) % PLAY_MODES.length;
    state.setCurrentModeIndex(newModeIndex);
    updateModeButton();
    if (oldIndex !== newModeIndex && dom.mediaPlayer.src) {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        let title = '';
        if (currentMode === 'list') title = '列表循环';
        else if (currentMode === 'single') title = '单曲循环';
        else if (currentMode === 'shuffle') title = '随机播放';
        showToast(`播放模式: ${title}`);
    }
}