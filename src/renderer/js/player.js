// src/renderer/js/player.js

/**
 * @file 媒体播放控制器 (Media Controller)
 * @description
 * 职责极其纯粹的模块：订阅状态，并根据状态控制 `<video>` 元素。
 */

import * as dom from './dom.js';
import { getters, mutations, subscribe } from './state.js';
import { PLAY_MODES } from './config.js';
import { parseLRC } from './utils.js';

// --- 模块私有变量 ---
let audioContextInitialized = false;

// --- 辅助函数 ---

function _setupAudioContext() {
    if (audioContextInitialized) return;
    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        const source = context.createMediaElementSource(dom.mediaPlayer);
        source.connect(analyser).connect(context.destination);
        mutations.setAudioContext(context);
        mutations.setAnalyser(analyser);
        audioContextInitialized = true;
    } catch (e) {
        console.error("音频上下文 (AudioContext) 初始化失败:", e);
    }
}

/**
 * 加载一个已经完全准备好的轨道对象到媒体播放器。
 */
async function _loadTrack(track) {
    // 1. 重置播放器和歌词状态
    mutations.setParsedLyrics([]);
    mutations.setDuration(0);

    // =========================================================================
    // 【核心修改】加载新轨道时，重置视频旋转角度为 0
    // 确保上一部视频的旋转状态不会影响到下一部视频
    // =========================================================================
    mutations.setVideoRotation(0);
    // =========================================================================

    if (!track || !track.src) {
        dom.mediaPlayer.removeAttribute('src');
        mutations.setIsPlaying(false);
        return;
    }

    // 2. 立即设置媒体参数
    dom.mediaPlayer.playbackRate = getters.playbackRate();
    dom.mediaPlayer.currentTime = 0;
    dom.mediaPlayer.src = track.src;

    // 3. 异步加载歌词 (非阻塞)
    (async () => {
        try {
            let lrcText = '';
            if (track.lyrics) {
                if (track.lyrics.startsWith('data:')) {
                    lrcText = decodeURIComponent(track.lyrics.substring('data:text/plain,'.length));
                } else if (track.lyrics.startsWith('media://')) {
                    const result = await window.electronAPI.getLrcContent(decodeURIComponent(track.lyrics.substring('media://'.length)));
                    if (result.success) lrcText = result.data;
                }
            } else if (track.lyricId && track.source) {
                const result = await window.electronAPI.getOnlineLyric(track.lyricId, track.source);
                if (result.success) lrcText = result.data;
            }

            if (lrcText) {
                mutations.setParsedLyrics(parseLRC(lrcText));
            }
        } catch (error) {
            console.warn("[Player] 加载歌词失败 (非致命错误):", error);
            mutations.setParsedLyrics([]);
        }
    })();

    // 5. 开始加载音频
    dom.mediaPlayer.load();
}


// --- 状态订阅处理函数 ---

function onIsPlayingChanged(isPlaying) {
    if (isPlaying) {
        if (!dom.mediaPlayer.src) return;
        if (!audioContextInitialized) _setupAudioContext();
        getters.audioContext()?.resume();
        dom.mediaPlayer.play().catch(e => {
            if (e.name !== 'AbortError') {
                console.error("播放失败:", e);
                mutations.setIsPlaying(false);
            }
        });
    } else {
        dom.mediaPlayer.pause();
    }
}

function onCurrentTrackChanged(track) {
    _loadTrack(track || null);
}

function onPlaybackRateChanged(rate) {
    dom.mediaPlayer.playbackRate = rate;
}

// =========================================================================
// 【核心新增】响应视频旋转角度变化
// =========================================================================
function onVideoRotationChanged(deg) {
    // 应用 CSS transform 旋转
    if (dom.mediaPlayer) {
        dom.mediaPlayer.style.transform = `rotate(${deg}deg)`;

        // 可选优化：旋转 90 或 270 度时，视频可能会看起来很小
        // 这里仅做简单的旋转，保证功能 Robust，不进行复杂的缩放计算
    }
}
// =========================================================================

function onVolumeChanged({ volume, isMuted }) {
    dom.mediaPlayer.volume = volume;
    dom.mediaPlayer.muted = isMuted;
}


// --- 媒体元素事件处理 ---

function onMediaTimeUpdate() {
    if (!getters.isScrubbing()) {
        mutations.setCurrentTime(dom.mediaPlayer.currentTime);
    }
}

function onMediaCanPlay() {
    if (getters.isPlaying()) {
        onIsPlayingChanged(true);
    }
}

async function onMediaEnded() {
    if (PLAY_MODES[getters.currentModeIndex()] === 'single') {
        dom.mediaPlayer.currentTime = 0;
        mutations.setIsPlaying(true);
    } else {
        const shortcutsModule = await import('./features/shortcuts.js');
        new shortcutsModule.NextTrackCommand().execute();
    }
}

function onMediaError() {
    if (!dom.mediaPlayer.getAttribute('src')) return;
    const track = getters.currentTrack();
    if (dom.mediaPlayer.error) {
        _notify('showToast', { message: `播放失败: ${track?.title || '未知'}`, type: 'error' });
    }
}


// --- 公共 API ---

export function init() {
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('playbackRateChanged', onPlaybackRateChanged);
    subscribe('volumeChanged', onVolumeChanged);
    // 订阅旋转变化
    subscribe('videoRotationChanged', onVideoRotationChanged);

    dom.mediaPlayer.addEventListener('timeupdate', onMediaTimeUpdate);
    dom.mediaPlayer.addEventListener('loadedmetadata', () => mutations.setDuration(dom.mediaPlayer.duration));
    dom.mediaPlayer.addEventListener('canplay', onMediaCanPlay);
    dom.mediaPlayer.addEventListener('ended', onMediaEnded);
    dom.mediaPlayer.addEventListener('error', onMediaError);

    window.addEventListener('seekTo', (e) => {
        const time = e.detail;
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.mediaPlayer.currentTime = Math.max(0, Math.min(dom.mediaPlayer.duration, time));
        }
    });

    console.log("媒体播放控制器 (Player Controller) 已初始化。");
}

function _notify(eventName, data) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: data }));
}