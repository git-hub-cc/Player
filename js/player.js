// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, updatePlaylistUI, extractAndApplyGradient, showSkeleton, hideSkeleton, updateModeButton, updateVolumeBarVisual } from './ui.js';

export async function loadTrack(trackIndex) {
    if (state.playlist.length === 0) return;
    showSkeleton();
    state.setCurrentTrackIndex(trackIndex);
    const track = state.playlist[trackIndex];

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";
    const artUrl = track.albumArt || DEFAULT_ART;
    dom.albumArtEl.src = artUrl;
    dom.controlAlbumArtEl.src = artUrl;

    state.setParsedLyrics(parseLRC(track.lyrics || ''));
    renderLyrics();
    updatePlaylistUI();

    let loadedOnce = false;
    const handleMediaReady = () => {
        if (!loadedOnce) {
            hideSkeleton();
            updateProgress();
            if (state.isPlaying) {
                dom.mediaPlayer.play().catch(e => {
                    if (e.name !== 'AbortError') console.error("播放失败:", e);
                });
            }
            loadedOnce = true;
        }
    };

    dom.mediaPlayer.oncanplay = null;
    dom.mediaPlayer.onloadedmetadata = null;
    dom.albumArtEl.onload = null;
    dom.mediaPlayer.onerror = (e) => {
        console.error("媒体加载错误:", e);
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放此媒体";
        hideSkeleton();
        dom.mainView.style.background = ''; // Reset background on error
    };

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

    if (state.isPlaying) {
        dom.mediaPlayer.play().catch(e => { /* Ignore */ });
    }
}

function playTrack() {
    if (state.playlist.length === 0 || !dom.mediaPlayer.src) return;
    const playPromise = dom.mediaPlayer.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            state.setIsPlaying(true);
            dom.playPauseBtn.classList.add('playing');
            dom.playPauseBtn.title = '暂停';
        }).catch(e => {
            if (e.name !== 'AbortError') console.error("播放失败:", e);
            state.setIsPlaying(false);
            dom.playPauseBtn.classList.remove('playing');
            dom.playPauseBtn.title = '播放';
        });
    }
}

function pauseTrack() {
    dom.mediaPlayer.pause();
    state.setIsPlaying(false);
    dom.playPauseBtn.classList.remove('playing');
    dom.playPauseBtn.title = '播放';
}

export const togglePlayPause = () => state.isPlaying ? pauseTrack() : playTrack();

function changeTrack(direction) {
    if (state.playlist.length === 0) return;
    const newIndex = (state.currentTrackIndex + direction + state.playlist.length) % state.playlist.length;
    loadTrack(newIndex);
}

export function playNextTrack() {
    if (state.playlist.length === 0) return;
    const currentMode = PLAY_MODES[state.currentModeIndex];
    if (currentMode === 'shuffle') {
        let nextIndex;
        if (state.playlist.length === 1) {
            nextIndex = 0;
        } else {
            do {
                nextIndex = Math.floor(Math.random() * state.playlist.length);
            } while (nextIndex === state.currentTrackIndex);
        }
        loadTrack(nextIndex);
    } else {
        changeTrack(1);
    }
}

export function playPrevTrack() {
    changeTrack(-1);
}

export function updateProgress() {
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
    const newModeIndex = (state.currentModeIndex + 1) % PLAY_MODES.length;
    state.setCurrentModeIndex(newModeIndex);
    updateModeButton();
}