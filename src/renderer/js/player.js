// src/renderer/js/player.js

/**
 * @file 媒体播放控制器 (Media Controller)
 * @description
 * 订阅状态，并根据状态控制 `<video>` 元素。现在包含处理VIP歌曲试听与无缝切换的逻辑。
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
 * 包含VIP歌曲处理逻辑。
 */
async function _loadTrack(track) {
    // 1. 重置播放器和相关状态
    mutations.setParsedLyrics([]);
    mutations.setDuration(0);
    mutations.setVideoRotation(0);

    if (!track || !track.src) {
        dom.mediaPlayer.removeAttribute('src');
        mutations.setIsPlaying(false);
        return;
    }

    // 2. 立即设置媒体参数（适用于试听和正式播放）
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
            } else if (track.id && track.source) {
                const result = await window.electronAPI.getOnlineLyric(track);
                if (result.success) lrcText = result.data;
            }
            if (lrcText) mutations.setParsedLyrics(parseLRC(lrcText));
        } catch (error) {
            console.warn("[Player] 加载歌词失败 (非致命错误):", error);
            mutations.setParsedLyrics([]);
        }
    })();

    // 4. 开始加载媒体
    dom.mediaPlayer.load();

    // =========================================================================
    // 【核心新增】VIP歌曲无缝切换逻辑
    // =========================================================================
    if (track.isVip && track.originalTrackInfo) {
        console.log(`[Player] 检测到VIP歌曲 "${track.title}"，正在播放试听并后台获取正式URL...`);
        try {
            // 在后台请求正式的URL
            const result = await window.electronAPI.getVipMusicUrl(track.originalTrackInfo);
            if (result.success && result.url) {
                console.log(`[Player] 成功获取VIP歌曲 "${track.title}" 的正式URL。`);
                const fullUrl = result.url;

                // 确保试听仍在播放，且轨道未被切换
                if (getters.isPlaying() && getters.currentTrack()?.src === track.src) {
                    const currentTime = dom.mediaPlayer.currentTime;
                    console.log(`[Player] 准备无缝切换，当前试听时间: ${currentTime.toFixed(2)}s`);

                    const onCanPlayThrough = () => {
                        dom.mediaPlayer.currentTime = currentTime;
                        dom.mediaPlayer.play().catch(console.error);
                        console.log(`[Player] 无缝切换成功，已跳转到 ${currentTime.toFixed(2)}s`);
                        dom.mediaPlayer.removeEventListener('canplaythrough', onCanPlayThrough);
                    };

                    dom.mediaPlayer.addEventListener('canplaythrough', onCanPlayThrough);
                    dom.mediaPlayer.src = fullUrl;
                    dom.mediaPlayer.load(); // 重新加载新源
                }
            } else {
                console.warn(`[Player] 获取 "${track.title}" 的正式URL失败: ${result.error}`);
            }
        } catch (error) {
            console.error(`[Player] 请求VIP歌曲URL时发生异常:`, error);
        }
    }
    // =========================================================================
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

function onCurrentTrackChanged(track) { _loadTrack(track || null); }
function onPlaybackRateChanged(rate) { dom.mediaPlayer.playbackRate = rate; }
function onVideoRotationChanged(deg) { dom.mediaPlayer.style.transform = `rotate(${deg}deg)`; }
function onVolumeChanged({ volume, isMuted }) { dom.mediaPlayer.volume = volume; dom.mediaPlayer.muted = isMuted; }

// --- 媒体元素事件处理 ---
function onMediaTimeUpdate() { if (!getters.isScrubbing()) mutations.setCurrentTime(dom.mediaPlayer.currentTime); }
function onMediaCanPlay() { if (getters.isPlaying()) onIsPlayingChanged(true); }
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
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `播放失败: ${track?.title || '未知'}`, type: 'error' } }));
    }
}

// --- 公共 API ---
export function init() {
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('playbackRateChanged', onPlaybackRateChanged);
    subscribe('volumeChanged', onVolumeChanged);
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