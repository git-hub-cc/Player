// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, extractAndApplyGradient, showSkeleton, hideSkeleton, updatePlaylistUI, updateModeButton, showToast, triggerGlitchEffect } from './ui.js';
import { resolvePlayableUrl } from './features/downloader.js';

let animationFrameId = null;
let skeletonTimer = null;
let nextBackgroundUpdateTime = 0;
const BACKGROUND_BEAT_MULTIPLIER = 12;

export function resetBackgroundBeatTimer() {
    nextBackgroundUpdateTime = 0;
}

export function resetPlayerUI() {
    pauseTrack();
    dom.mediaPlayer.src = '';
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
}

/**
 * 播放一个临时的、不属于下载列表的在线曲目。
 * @param {object} track - 要播放的曲目对象。
 */
export async function playTemporaryTrack(track) {
    if (!track) return;
    showSkeleton();
    pauseTrack();
    resetBackgroundBeatTimer();
    state.setCurrentColorPaletteIndex(0);

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";
    const artUrl = track.albumArt || DEFAULT_ART;
    dom.albumArtEl.src = artUrl;
    dom.controlAlbumArtEl.src = artUrl;

    let playableSrc;
    try {
        playableSrc = await resolvePlayableUrl(track);
    } catch (error) {
        console.error(`无法获取临时曲目 '${track.title}' 的播放链接:`, error);
        showToast(`无法播放在线曲目: "${track.title}"`, 'error');
        hideSkeleton();
        return;
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

    // 【修改】正确地克隆、替换并更新 DOM 引用
    const oldMediaPlayer = dom.mediaPlayer;
    const newMediaPlayer = oldMediaPlayer.cloneNode(true);
    oldMediaPlayer.parentNode.replaceChild(newMediaPlayer, oldMediaPlayer);
    dom.updateMediaPlayerReference(newMediaPlayer); // 使用 setter 更新模块内的引用

    dom.mediaPlayer.onerror = (e) => {
        console.error("临时媒体加载错误:", e);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放在线媒体";
        showToast(`播放失败，媒体资源可能已失效`, 'error');
    };
    dom.mediaPlayer.oncanplay = () => { hideSkeleton(); playTrack(); };
    dom.mediaPlayer.onloadedmetadata = updateProgress;
    dom.mediaPlayer.addEventListener('ended', () => playNextTrack());

    dom.albumArtContainer.style.display = 'flex';
    dom.mediaPlayer.style.display = 'none';
    dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
    if (dom.albumArtEl.complete) extractAndApplyGradient(dom.albumArtEl);

    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

/**
 * 加载并准备播放指定的轨道。
 * @param {number} trackIndex - 轨道在播放列表中的索引。
 * @param {object} [options={}] - 加载选项。
 * @param {boolean} [options.forcePlay=false] - 加载后是否强制播放。
 */
export async function loadTrack(trackIndex, options = {}) {
    const { forcePlay = false } = options;

    resetBackgroundBeatTimer();
    state.setCurrentColorPaletteIndex(0);
    if (skeletonTimer) clearTimeout(skeletonTimer);
    if (state.playlist.length === 0) { resetPlayerUI(); return; }
    if (forcePlay) state.setIsPlaying(true);

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
            const lrcText = track.lyrics.startsWith('data:text/plain,')
                ? decodeURIComponent(track.lyrics.substring('data:text/plain,'.length))
                : await (await fetch(track.lyrics)).text();
            state.setParsedLyrics(parseLRC(lrcText));
        } catch (error) { console.error(`无法从路径加载歌词 '${track.lyrics}':`, error); }
    }
    renderLyrics();
    updatePlaylistUI();

    let loadedOnce = false;
    const handleMediaReady = () => {
        if (!loadedOnce) {
            hideSkeleton();
            updateProgress();
            if (state.isPlaying) playTrack();
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

    // 【修改】正确地克隆、替换并更新 DOM 引用
    const oldMediaPlayer = dom.mediaPlayer;
    const newMediaPlayer = oldMediaPlayer.cloneNode(true);
    oldMediaPlayer.parentNode.replaceChild(newMediaPlayer, oldMediaPlayer);
    dom.updateMediaPlayerReference(newMediaPlayer); // 使用 setter 更新模块内的引用

    dom.mediaPlayer.onerror = handleError;
    dom.mediaPlayer.oncanplay = handleMediaReady;
    dom.mediaPlayer.onloadedmetadata = updateProgress;
    dom.mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        if (currentMode === 'single') { dom.mediaPlayer.currentTime = 0; playTrack(); }
        else { playNextTrack(); }
    });


    if (track.type === 'audio') {
        dom.albumArtContainer.style.display = 'flex';
        dom.mediaPlayer.style.display = 'none';
        dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
        if (dom.albumArtEl.complete && dom.albumArtEl.naturalWidth > 0) {
            extractAndApplyGradient(dom.albumArtEl);
        } else { dom.mainView.style.background = ''; }
    } else {
        dom.albumArtContainer.style.display = 'none';
        dom.mediaPlayer.style.display = 'block';
        dom.mainView.style.background = '';
        dom.mediaPlayer.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
    }

    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

function runAnimationFrame() {
    updateProgress();
    const now = performance.now();
    const currentTrack = state.playlist[state.currentTrackIndex];
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
    // 【修改】确保即使在 dom.mediaPlayer 为 null 或 undefined 时也不会抛出错误
    if (!dom.mediaPlayer || !dom.mediaPlayer.src || (state.playlist.length === 0 && !dom.mediaPlayer.src.startsWith('http'))) return;
    const playPromise = dom.mediaPlayer.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            state.setIsPlaying(true);
            dom.playPauseBtn.classList.add('playing');
            dom.playPauseBtn.title = '暂停';
            if (nextBackgroundUpdateTime === 0) nextBackgroundUpdateTime = performance.now();
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
    if (state.playlist.length <= 1) return;
    triggerGlitchEffect(3000);
    clearTimeout(skeletonTimer);
    skeletonTimer = setTimeout(() => showSkeleton(), 3000);

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