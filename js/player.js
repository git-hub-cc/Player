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

/**
 * [MODIFIED] 初始化 Web Audio API 上下文。
 * 仅创建上下文和分析器，不在此处连接音频源。
 */
function setupAudioContext() {
    if (state.audioContext) return;

    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyserNode = context.createAnalyser();
        analyserNode.fftSize = 256; // 频域数据点的数量 (必须是2的幂)

        state.setAudioContext(context);
        state.setAnalyser(analyserNode);

        // 连接操作被移至 playTrack (首次) 和 loadTrack (后续) 中，以确保连接到正确的元素
    } catch (e) {
        console.error("Web Audio API is not supported in this browser.", e);
    }
}

/**
 * [MODIFIED] 将当前的媒体元素连接到音频分析器。
 * 此函数现在更加健壮，设计为在每次播放器元素更改时调用。
 */
function connectAudioSource() {
    // 仅当上下文和播放器元素都存在时才继续
    if (!state.audioContext || !dom.mediaPlayer) return;
    try {
        // 在创建新源之前，断开任何现有源与图的连接
        if (state.audioSource) {
            state.audioSource.disconnect();
        }
        // 为 *当前* 的媒体元素创建一个新源
        const source = state.audioContext.createMediaElementSource(dom.mediaPlayer);
        source.connect(state.analyser);
        state.analyser.connect(state.audioContext.destination);
        // 存储新的源节点
        state.setAudioSource(source);
    } catch (e) {
        // 如果尝试重复连接同一个元素，或元素状态不佳，可能会发生此错误。
        // 作为警告记录，而不是关键错误。
        console.warn("Could not connect audio source:", e.message);
    }
}

/**
 * 创建一个新的 media element，替换旧的，并附加所有必要的事件监听器。
 * 这是为了解决克隆节点时事件监听器丢失的问题，并集中管理核心事件。
 */
function _recreateMediaPlayerAndAttachListeners() {
    const oldMediaPlayer = dom.mediaPlayer;
    const newMediaPlayer = oldMediaPlayer.cloneNode(true);

    newMediaPlayer.addEventListener('loadedmetadata', updateProgress);

    newMediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[state.currentModeIndex];
        if (currentMode === 'single') {
            newMediaPlayer.currentTime = 0;
            playTrack();
        } else {
            playNextTrack();
        }
    });

    oldMediaPlayer.parentNode.replaceChild(newMediaPlayer, oldMediaPlayer);
    dom.updateMediaPlayerReference(newMediaPlayer); // 更新全局 DOM 引用
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

    // 设置新的播放状态并更新UI
    state.setTemporaryPlayingTrack(track);
    updatePlaylistUI();

    // 先创建和准备好新的播放器
    _recreateMediaPlayerAndAttachListeners();

    // --- 核心修复 ---
    // 在创建新媒体元素后，如果音频上下文已存在，则立即重新连接。
    if (state.audioContext) {
        connectAudioSource();
    }
    // --- 修复结束 ---

    dom.trackTitleEl.textContent = track.title || "未知标题";
    dom.trackArtistEl.textContent = track.artist || "未知艺术家";
    const artUrl = track.albumArt || DEFAULT_ART;
    dom.albumArtEl.src = artUrl;
    dom.controlAlbumArtEl.src = artUrl;

    // 在设置 src 之前附加错误处理
    dom.mediaPlayer.onerror = (e) => {
        console.error("临时媒体加载错误:", e);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放在线媒体";
        showToast(`播放失败，媒体资源可能已失效`, 'error');
        state.clearPlayingTrackInfo();
        updatePlaylistUI();
    };
    dom.mediaPlayer.oncanplay = () => { hideSkeleton(); playTrack(); };

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

    // 先创建和准备好新的播放器
    _recreateMediaPlayerAndAttachListeners();

    // --- 核心修复 ---
    // 在创建新媒体元素后，如果音频上下文已存在，则立即重新连接。
    if (state.audioContext) {
        connectAudioSource();
    }
    // --- 修复结束 ---

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
                if (result.success) {
                    lrcText = result.data;
                } else {
                    throw new Error(result.error);
                }
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

    let loadedOnce = false;

    dom.mediaPlayer.onerror = (e) => {
        console.error("媒体加载错误:", e);
        if (skeletonTimer) clearTimeout(skeletonTimer);
        hideSkeleton();
        dom.trackTitleEl.textContent = "错误";
        dom.trackArtistEl.textContent = "无法播放此媒体";
        dom.mainView.style.background = '';
    };

    dom.mediaPlayer.oncanplay = () => {
        if (!loadedOnce) {
            hideSkeleton();
            updateProgress();
            if (initialTime > 0) dom.mediaPlayer.currentTime = initialTime;
            if (state.isPlaying) playTrack();
            loadedOnce = true;
        }
    };

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

    // 【新增】调用音频可视化绘制函数
    if (state.isPlaying && state.analyser && ((state.playlist[state.currentTrackIndex] && state.playlist[state.currentTrackIndex].type === 'audio') || (state.temporaryPlayingTrack && state.temporaryPlayingTrack.type === 'audio'))) {
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

    // [MODIFIED] 在首次播放时初始化 AudioContext 并进行首次连接
    if (!state.audioContext) {
        setupAudioContext();
        // 首次设置后，我们需要连接*当前*的播放器
        connectAudioSource();
    }

    // 确保 AudioContext 在用户交互后处于 running 状态
    if (state.audioContext && state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

    // [REMOVED] 检查过时元素的逻辑不再需要，因为它已由轨道加载函数处理

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

    // 如果正在播放临时曲目，切歌将恢复到播放列表
    if(state.temporaryPlayingTrack) {
        state.clearPlayingTrackInfo();
        // 清除后如果播放列表为空，则重置；否则加载当前索引
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