// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, extractAndApplyGradient, showSkeleton, hideSkeleton, updatePlaylistUI, updateModeButton, showToast, triggerGlitchEffect } from './ui.js';
import { requestTrackCache, resolvePlayableUrl } from './features/downloader.js'; // [修改] 引入 resolvePlayableUrl

// --- Module-level variables ---
let animationFrameId = null;
let skeletonTimer = null;

// --- Background Update Timer ---
let nextBackgroundUpdateTime = 0;
const FALLBACK_INTERVAL = 1000;
const BACKGROUND_BEAT_MULTIPLIER = 12;

export function resetBackgroundBeatTimer() {
    nextBackgroundUpdateTime = 0;
}

/**
 * [新增] 重置播放器UI到初始状态。
 */
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
}


/**
 * [新增] 播放一个临时的、不属于下载列表的曲目。
 * @param {object} track - 要播放的曲目对象。
 */
export async function playTemporaryTrack(track) {
    if (!track) return;
    showSkeleton();

    // 暂停当前播放，并重置UI，但不更改下载列表的索引
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
            let lrcText;
            if (track.lyrics.startsWith('data:text/plain,')) {
                lrcText = track.lyrics.substring('data:text/plain,'.length);
            } else {
                const response = await fetch(track.lyrics);
                if (!response.ok) throw new Error(`请求歌词失败: ${response.status}`);
                lrcText = await response.text();
            }
            state.setParsedLyrics(parseLRC(lrcText));
        } catch (error) {
            console.error(`无法加载临时歌词:`, error);
        }
    }
    renderLyrics();

    const handleError = (e) => {
        console.error("临时媒体加载错误:", e);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放在线媒体";
    };

    dom.mediaPlayer.onerror = handleError;
    dom.mediaPlayer.oncanplay = () => {
        hideSkeleton();
        playTrack();
    };
    dom.mediaPlayer.onloadedmetadata = updateProgress;

    // 根据类型显示封面或视频
    if (track.type === 'audio') {
        dom.albumArtContainer.style.display = 'flex';
        dom.mediaPlayer.style.display = 'none';
        dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
        if (dom.albumArtEl.complete) extractAndApplyGradient(dom.albumArtEl);
    } else {
        dom.albumArtContainer.style.display = 'none';
        dom.mediaPlayer.style.display = 'block';
        dom.mediaPlayer.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
    }

    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

/**
 * [修改] 加载并准备播放指定的轨道。
 * @param {number} trackIndex - 要加载的轨道在播放列表中的索引。
 * @param {object} [options={}] - 加载选项。
 * @param {boolean} [options.fromHistory=false] - 是否由浏览器历史记录导航触发。
 * @param {boolean} [options.forcePlay=false] - 加载后是否强制开始播放。
 */
export async function loadTrack(trackIndex, options = {}) {
    const { fromHistory = false, forcePlay = false } = options;

    resetBackgroundBeatTimer();
    state.setCurrentColorPaletteIndex(0);

    if (skeletonTimer) {
        clearTimeout(skeletonTimer);
        skeletonTimer = null;
    }

    if (state.playlist.length === 0) {
        resetPlayerUI();
        return;
    };

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

    // --- [核心修改] 使用 resolvePlayableUrl 获取真实播放链接 ---
    let playableSrc = track.src;
    try {
        // 在设置 src 之前，先解析出真实的播放地址
        playableSrc = await resolvePlayableUrl(track);
    } catch (error) {
        console.error(`无法获取 '${track.title}' 的播放链接:`, error);
        showToast(`无法播放 "${track.title}"`, 'error');
        // 播放失败后自动播放下一首
        setTimeout(() => playNextTrack(), 1000);
        return;
    }
    // -----------------------------------------------------------

    state.setParsedLyrics([]);
    renderLyrics();

    if (track.lyrics) {
        try {
            let lrcText;
            if (track.lyrics.startsWith('data:text/plain,')) {
                lrcText = track.lyrics.substring('data:text/plain,'.length);
            } else {
                const response = await fetch(track.lyrics);
                if (!response.ok) {
                    throw new Error(`请求歌词失败: ${response.status} ${response.statusText}`);
                }
                lrcText = await response.text();
            }
            state.setParsedLyrics(parseLRC(lrcText));
        } catch (error) {
            console.error(`无法从路径加载歌词 '${track.lyrics}':`, error);
        }
    }
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

    // [修改] 设置解析后的 src
    dom.mediaPlayer.src = playableSrc;
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

/**
 * 动画主循环，用于更新进度条、同步歌词和背景。
 */
function runAnimationFrame() {
    updateProgress();

    const now = performance.now();
    const currentTrack = state.playlist[state.currentTrackIndex];

    // 合并音频和视频的节拍同步背景更新逻辑
    if (state.isPlaying && currentTrack && dom.mediaPlayer.readyState > 1 && currentTrack.beatInterval > 0) {
        if (nextBackgroundUpdateTime === 0) {
            nextBackgroundUpdateTime = now;
        }

        if (now >= nextBackgroundUpdateTime) {
            // 根据媒体类型选择不同的背景更新方式
            if (currentTrack.type === 'video') {
                // 视频：从当前帧提取颜色
                extractAndApplyGradient(dom.mediaPlayer);
            } else if (currentTrack.type === 'audio' && currentTrack.colorPalettes && currentTrack.colorPalettes.length > 0) {
                // 音频：从预设的调色板中循环切换颜色
                const palettes = currentTrack.colorPalettes;
                const currentPalette = palettes[state.currentColorPaletteIndex];

                const gradient = `linear-gradient(145deg, ${currentPalette[0]}, ${currentPalette[1]})`;
                dom.mainView.style.background = gradient;

                // 更新到下一个颜色组合
                const nextIndex = (state.currentColorPaletteIndex + 1) % palettes.length;
                state.setCurrentColorPaletteIndex(nextIndex);
            }

            const interval = currentTrack.beatInterval * 1000;
            const updateInterval = interval * BACKGROUND_BEAT_MULTIPLIER;
            nextBackgroundUpdateTime += updateInterval;

            // 健壮性：如果浏览器标签页被挂起，进行校准以防闪烁
            if (nextBackgroundUpdateTime < now) {
                nextBackgroundUpdateTime = now + updateInterval;
            }
        }
    }

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
            if (nextBackgroundUpdateTime === 0) {
                nextBackgroundUpdateTime = performance.now();
            }
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
        const currentMode = PLAY_MODES[state.currentModeIndex];

        if (direction === 1) { // 下一首
            if (currentMode === 'shuffle') {
                do {
                    newIndex = Math.floor(Math.random() * state.playlist.length);
                } while (state.playlist.length > 1 && newIndex === state.currentTrackIndex);
            } else {
                newIndex = (state.currentTrackIndex + 1) % state.playlist.length;
            }
        } else { // 上一首 (随机模式下上一首也是随机)
            if (currentMode === 'shuffle') {
                do {
                    newIndex = Math.floor(Math.random() * state.playlist.length);
                } while (state.playlist.length > 1 && newIndex === state.currentTrackIndex);
            } else {
                newIndex = (state.currentTrackIndex - 1 + state.playlist.length) % state.playlist.length;
            }
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