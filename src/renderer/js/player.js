// js/player.js

import * as dom from './dom.js';
import * as state from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { formatTime, parseLRC } from './utils.js';
import { renderLyrics, syncLyrics, extractAndApplyGradient, showSkeleton, hideSkeleton, updatePlaylistUI, updateModeButton, showToast, drawVisualizer } from './ui.js';
import { resolvePlayableUrl } from './features/downloader.js';

let animationFrameId = null;
let skeletonTimer = null;
let nextBackgroundUpdateTime = 0;
const BACKGROUND_BEAT_MULTIPLIER = 12;

// 【新增】一个辅助函数来清空可视化画布
function clearVisualizer() {
    if (dom.audioVisualizer) {
        const ctx = dom.audioVisualizer.getContext('2d');
        ctx.clearRect(0, 0, dom.audioVisualizer.width, dom.audioVisualizer.height);
    }
}

// 【新增】用于在加载轨道时临时存储初始跳转时间
let _pendingSeekTime = 0;
export function setPendingSeek(time) { _pendingSeekTime = time > 0 ? time : 0; }
export function consumePendingSeek() {
    const time = _pendingSeekTime;
    _pendingSeekTime = 0;
    return time;
}

/**
 * [MODIFIED] 初始化 Web Audio API 上下文。
 * 仅在首次需要时创建。
 */
function setupAudioContext() {
    if (state.audioContext) return;

    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyserNode = context.createAnalyser();
        analyserNode.fftSize = 256;

        state.setAudioContext(context);
        state.setAnalyser(analyserNode);

        // 为 *当前* 的媒体元素创建一个源并连接
        const source = context.createMediaElementSource(dom.mediaPlayer);
        source.connect(analyserNode);
        // 【修改】初始连接直接到 destination
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
    // 清除播放信息并更新UI以移除高亮
    state.clearPlayingTrackInfo();
    updatePlaylistUI();
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

    state.setTemporaryPlayingTrack(track);
    updatePlaylistUI();

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
        state.clearPlayingTrackInfo();
        updatePlaylistUI();
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

    dom.albumArtContainer.style.display = 'flex';
    dom.mediaPlayer.style.display = 'none';
    dom.albumArtEl.onload = () => extractAndApplyGradient(dom.albumArtEl);
    if (dom.albumArtEl.complete) extractAndApplyGradient(dom.albumArtEl);

    // 【修改】直接设置 src 并加载，不再克隆或附加事件监听器
    setPendingSeek(0); // 临时播放在线曲目从头开始
    state.setIsPlaying(true); // 准备自动播放
    dom.mediaPlayer.src = playableSrc;
    dom.mediaPlayer.load();
}

/**
 * 加载并准备播放指定的轨道。
 * @param {number} trackIndex - 轨道在播放列表中的索引。
 * @param {object} [options={}] - 加载选项。
 * @param {boolean} [options.forcePlay=false] - 加载后是否强制播放。
 * @param {number} [options.initialTime=0] - 初始播放时间点。
 */
export async function loadTrack(trackIndex, options = {}) {
    const { forcePlay = false, initialTime = 0 } = options;

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
    } else {
        dom.albumArtContainer.style.display = 'none';
        dom.mediaPlayer.style.display = 'block';
        dom.mainView.style.background = '';
        dom.mediaPlayer.addEventListener('canplay', () => extractAndApplyGradient(dom.mediaPlayer), { once: true });
        clearVisualizer();
    }

    // 【修改】直接设置 src 并加载，事件监听由 main.js 处理
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

    // 【修改】首次播放时初始化 AudioContext 并进行连接
    if (!state.audioContext) {
        setupAudioContext();
    }

    // 确保 AudioContext 在用户交互后处于 running 状态
    if (state.audioContext && state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

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

    if(state.temporaryPlayingTrack) {
        state.clearPlayingTrackInfo();
        if (state.playlist.length === 0) {
            resetPlayerUI();
            return;
        }
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