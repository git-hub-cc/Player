// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, extractAndApplyGradient, showSkeleton, hideSkeleton, updatePlaylistUI, updateModeButton, showToast, drawVisualizer, showSpeedFeedback } from './ui.js';
import { resolvePlayableUrl } from './features/downloader.js';

let animationFrameId = null;
let skeletonTimer = null;
let nextBackgroundUpdateTime = 0;
const BACKGROUND_BEAT_MULTIPLIER = 12;

// =========================================================================
// 【新增】用于长按快进时的原始播放速率备份
// =========================================================================
let originalPlaybackRate = 1.0;
// =========================================================================

function clearVisualizer() {
    if (dom.audioVisualizer) {
        const ctx = dom.audioVisualizer.getContext('2d');
        ctx.clearRect(0, 0, dom.audioVisualizer.width, dom.audioVisualizer.height);
    }
}

let _pendingSeekTime = 0;
export function setPendingSeek(time) { _pendingSeekTime = time > 0 ? time : 0; }
export function consumePendingSeek() {
    const time = _pendingSeekTime;
    _pendingSeekTime = 0;
    return time;
}

function setupAudioContext() {
    if (state.audioContext) return;

    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyserNode = context.createAnalyser();
        analyserNode.fftSize = 256;

        state.setAudioContext(context);
        state.setAnalyser(analyserNode);

        const source = context.createMediaElementSource(dom.mediaPlayer);
        source.connect(analyserNode);
        analyserNode.connect(context.destination);
        state.setAudioSource(source);
        console.log("AudioContext and visualizer source connected.");
    } catch (e) {
        console.error("Web Audio API is not supported in this browser.", e);
    }
}

export function resetBackgroundBeatTimer() {
    nextBackgroundUpdateTime = 0;
}

export function resetPlayerUI() {
    pauseTrack();
    if (dom.mediaPlayer) dom.mediaPlayer.src = '';
    dom.trackTitleEl.textContent = '选择媒体';
    dom.trackArtistEl.textContent = '开始播放';
    dom.albumArtEl.src = DEFAULT_ART;
    dom.controlAlbumArtEl.src = DEFAULT_ART;
    dom.currentTimeEl.textContent = '0:00';
    dom.durationEl.textContent = '0:00';
    dom.progressBar.value = 0;
    dom.progressBar.style.setProperty('--value-percent', '0%');
    dom.mainView.style.background = '';
    state.setParsedLyrics([]);
    renderLyrics();
    hideSkeleton();
    clearVisualizer();
    state.clearPlayingTrackInfo();
    updatePlaylistUI();
    dom.playerContainer.classList.remove('video-mode');
}

export async function playTemporaryTrack(track) {
    if (!track) return;
    showSkeleton();
    pauseTrack();
    resetBackgroundBeatTimer();
    state.setCurrentColorPaletteIndex(0);

    // 【新增】应用当前设置的播放速率
    dom.mediaPlayer.playbackRate = state.playbackRate;

    state.setTemporaryPlayingTrack(track);
    updatePlaylistUI();

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";

    dom.albumArtEl.src = DEFAULT_ART;
    dom.controlAlbumArtEl.src = DEFAULT_ART;
    dom.mainView.style.background = '';

    let playableSrc, albumArtUrl;
    try {
        const resolvedData = await resolvePlayableUrl(track);
        playableSrc = resolvedData.playableSrc;
        albumArtUrl = resolvedData.albumArtUrl;
    } catch (error) {
        console.error(`无法获取临时曲目 '${track.title}' 的播放链接:`, error);
        showToast(`无法播放在线曲目: "${track.title}"`, 'error');
        hideSkeleton();
        state.clearPlayingTrackInfo();
        updatePlaylistUI();
        return;
    }

    if (albumArtUrl) {
        dom.albumArtEl.src = albumArtUrl;
        dom.controlAlbumArtEl.src = albumArtUrl;
        dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
        if (dom.albumArtEl.complete) extractAndApplyGradient(dom.albumArtEl);
    }

    state.setParsedLyrics([]);
    if (track.lyrics) {
        try {
            const lrcText = track.lyrics.startsWith('data:text/plain,')
                ? decodeURIComponent(track.lyrics.substring('data:text/plain,'.length))
                : await (await fetch(track.lyrics)).text();
            state.setParsedLyrics(parseLRC(lrcText));
        } catch (error) { console.error(`无法加载临时歌词:`, error); }
    }
    renderLyrics();

    dom.albumArtContainer.style.display = 'flex';
    dom.mediaPlayer.style.display = 'none';

    dom.playerContainer.classList.remove('video-mode');

    setPendingSeek(0);
    state.setIsPlaying(true);
    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

export async function loadTrack(trackIndex, options = {}) {
    const { forcePlay = false, initialTime = 0 } = options;

    resetBackgroundBeatTimer();
    state.setCurrentColorPaletteIndex(0);
    if (skeletonTimer) clearTimeout(skeletonTimer);
    if (state.playlist.length === 0) { resetPlayerUI(); return; }
    if (forcePlay) state.setIsPlaying(true);

    // 【新增】应用当前设置的播放速率
    dom.mediaPlayer.playbackRate = state.playbackRate;

    state.setCurrentTrackIndex(trackIndex);
    const track = state.playlist[trackIndex];

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";
    const artUrl = track.albumArt || DEFAULT_ART;
    dom.albumArtEl.src = artUrl;
    dom.controlAlbumArtEl.src = artUrl;

    const playableSrc = track.src;

    state.setParsedLyrics([]);
    renderLyrics();

    if (track.lyrics) {
        try {
            let lrcText = '';
            if (track.lyrics.startsWith('data:text/plain,')) {
                lrcText = decodeURIComponent(track.lyrics.substring('data:text/plain,'.length));
            } else if (track.lyrics.startsWith('media://')) {
                const relativePath = track.lyrics.substring('media://'.length);
                const result = await window.electronAPI.getLrcContent(relativePath);
                if (result.success) lrcText = result.data; else throw new Error(result.error);
            } else if (track.lyrics.startsWith('http')) {
                const response = await fetch(track.lyrics);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                lrcText = await response.text();
            }
            if (lrcText) state.setParsedLyrics(parseLRC(lrcText));
        } catch (error) {
            console.error(`无法从路径加载歌词 '${track.lyrics}':`, error);
        }
    }
    renderLyrics();
    updatePlaylistUI();

    if (track.type === 'audio') {
        dom.albumArtContainer.style.display = 'flex';
        dom.mediaPlayer.style.display = 'none';
        dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
        if (dom.albumArtEl.complete && dom.albumArtEl.naturalWidth > 0) {
            extractAndApplyGradient(dom.albumArtEl);
        } else { dom.mainView.style.background = ''; }
        dom.playerContainer.classList.remove('video-mode');
    } else {
        dom.albumArtContainer.style.display = 'none';
        dom.mediaPlayer.style.display = 'block';
        dom.mainView.style.background = '';
        dom.mediaPlayer.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
        clearVisualizer();
        dom.playerContainer.classList.add('video-mode');
    }

    setPendingSeek(initialTime);
    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

function runAnimationFrame() {
    updateProgress();
    const currentTrackForVisualizer = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex];
    if (state.isPlaying && state.analyser && currentTrackForVisualizer && currentTrackForVisualizer.type === 'audio') {
        drawVisualizer();
    }
    const now = performance.now();
    const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex];
    if (state.isPlaying && currentTrack && dom.mediaPlayer.readyState > 1 && currentTrack.beatInterval > 0) {
        if (nextBackgroundUpdateTime === 0) nextBackgroundUpdateTime = now;
        if (now >= nextBackgroundUpdateTime) {
            if (currentTrack.type === 'video') {
                extractAndApplyGradient(dom.mediaPlayer);
            } else if (currentTrack.type === 'audio' && currentTrack.colorPalettes?.length > 0) {
                const palettes = currentTrack.colorPalettes;
                const currentPalette = palettes[state.currentColorPaletteIndex];
                dom.mainView.style.background = `linear-gradient(145deg, ${currentPalette[0]}, ${currentPalette[1]})`;
                state.setCurrentColorPaletteIndex((state.currentColorPaletteIndex + 1) % palettes.length);
            }
            const updateInterval = currentTrack.beatInterval * 1000 * BACKGROUND_BEAT_MULTIPLIER;
            nextBackgroundUpdateTime += updateInterval;
            if (nextBackgroundUpdateTime < now) nextBackgroundUpdateTime = now + updateInterval;
        }
    }
    animationFrameId = requestAnimationFrame(runAnimationFrame);
}

export function playTrack() {
    if (!dom.mediaPlayer || !dom.mediaPlayer.src) return;
    if (!state.audioContext) setupAudioContext();
    if (state.audioContext && state.audioContext.state === 'suspended') state.audioContext.resume();

    const playPromise = dom.mediaPlayer.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            state.setIsPlaying(true);
            dom.playPauseBtn.classList.add('playing');
            dom.playPauseBtn.title = '暂停';
            const currentTrack = state.temporaryPlayingTrack || state.playlist[state.currentTrackIndex];
            if (currentTrack && currentTrack.beatInterval && nextBackgroundUpdateTime === 0) {
                nextBackgroundUpdateTime = performance.now();
            }
            if (animationFrameId === null) runAnimationFrame();
        }).catch(e => {
            if (e.name !== 'AbortError') console.error("播放失败:", e);
        });
    }
}

export function pauseTrack() {
    if (dom.mediaPlayer) dom.mediaPlayer.pause();
    state.setIsPlaying(false);
    dom.playPauseBtn.classList.remove('playing');
    dom.playPauseBtn.title = '播放';
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
}

export const togglePlayPause = () => state.isPlaying ? pauseTrack() : playTrack();

function changeTrack(direction) {
    if (state.playlist.length <= 1 && !state.temporaryPlayingTrack) return;
    if (state.temporaryPlayingTrack) {
        state.clearPlayingTrackInfo();
        if (state.playlist.length === 0) { resetPlayerUI(); return; }
    }
    clearTimeout(skeletonTimer);
    skeletonTimer = setTimeout(() => showSkeleton(), 300);
    setTimeout(() => {
        let newIndex;
        const currentMode = PLAY_MODES[state.currentModeIndex];
        const playlistLength = state.playlist.length;
        if (direction === 1) { // Next
            if (currentMode === 'shuffle') {
                do { newIndex = Math.floor(Math.random() * playlistLength); } while (playlistLength > 1 && newIndex === state.currentTrackIndex);
            } else { newIndex = (state.currentTrackIndex + 1) % playlistLength; }
        } else { // Previous
            if (currentMode === 'shuffle') {
                do { newIndex = Math.floor(Math.random() * playlistLength); } while (playlistLength > 1 && newIndex === state.currentTrackIndex);
            } else { newIndex = (state.currentTrackIndex - 1 + playlistLength) % playlistLength; }
        }
        loadTrack(newIndex, { forcePlay: true });
    }, 150);
}

export function playNextTrack() { changeTrack(1); }
export function playPrevTrack() { changeTrack(-1); }

export function updateProgress() {
    if (state.isScrubbing || !dom.mediaPlayer) return;
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
    const currentMode = PLAY_MODES[state.currentModeIndex];
    const titles = { 'list': '列表循环', 'single': '单曲循环', 'shuffle': '随机播放' };
    showToast(`播放模式: ${titles[currentMode]}`);
}

// =========================================================================
// 【修改】处理时间跳转和倍速播放的函数
// =========================================================================
/**
 * 跳转到媒体的指定秒数。
 * @param {number} seconds - 要跳转的秒数（正为快进，负为快退）。
 */
export function seek(seconds) {
    if (!dom.mediaPlayer || isNaN(dom.mediaPlayer.duration)) return;
    const newTime = dom.mediaPlayer.currentTime + seconds;
    // 确保时间不会超出范围 [0, duration]
    dom.mediaPlayer.currentTime = Math.max(0, Math.min(dom.mediaPlayer.duration, newTime));
    updateProgress(); // 立即更新UI
}

/**
 * 临时设置播放速率（用于长按快进）。
 * @param {number} rate - 新的播放速率。
 */
export function setTemporaryPlaybackRate(rate) {
    if (!dom.mediaPlayer) return;
    originalPlaybackRate = dom.mediaPlayer.playbackRate; // 保存当前速率
    dom.mediaPlayer.playbackRate = rate;
}

/**
 * 恢复到长按前的播放速率。
 */
export function restorePlaybackRate() {
    if (!dom.mediaPlayer) return;
    dom.mediaPlayer.playbackRate = originalPlaybackRate;
}

/**
 * 增加播放速度。
 */
export function increaseSpeed() {
    if (!dom.mediaPlayer) return;
    const currentRate = dom.mediaPlayer.playbackRate;
    // 使用 toFixed 避免浮点数精度问题
    let newRate = parseFloat((currentRate + 0.1).toFixed(1));
    // 限制最大速度为 2.0x
    newRate = Math.min(newRate, 2.0);
    dom.mediaPlayer.playbackRate = newRate;
    state.setPlaybackRate(newRate);
    showSpeedFeedback();
}

/**
 * 降低播放速度。
 */
export function decreaseSpeed() {
    if (!dom.mediaPlayer) return;
    const currentRate = dom.mediaPlayer.playbackRate;
    let newRate = parseFloat((currentRate - 0.1).toFixed(1));
    // 限制最小速度为 0.5x
    newRate = Math.max(newRate, 0.5);
    dom.mediaPlayer.playbackRate = newRate;
    state.setPlaybackRate(newRate);
    showSpeedFeedback();
}
// =========================================================================