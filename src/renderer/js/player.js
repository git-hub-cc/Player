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
let progressUpdateThrottleTimer = null; // 用于节流进度更新

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
 * 包含VIP歌曲处理逻辑和视频进度恢复逻辑。
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

    // 2. 立即设置媒体参数
    dom.mediaPlayer.playbackRate = getters.playbackRate();
    dom.mediaPlayer.src = track.src;

    // =========================================================================
    // 【核心修改】恢复视频播放进度
    // =========================================================================
    // 如果是视频，并且有有效的播放记录，则准备跳转
    if (track.type === 'video' && track.lastPosition > 0) {
        // 定义一个一次性事件监听器，在媒体元数据加载完毕后执行跳转
        const onMetadataLoaded = () => {
            // 安全检查：确保跳转位置在视频总时长内
            if (track.lastPosition < dom.mediaPlayer.duration) {
                dom.mediaPlayer.currentTime = track.lastPosition;
            }
            dom.mediaPlayer.removeEventListener('loadedmetadata', onMetadataLoaded);
        };
        dom.mediaPlayer.addEventListener('loadedmetadata', onMetadataLoaded);
    } else {
        // 如果不是视频或没有进度，确保从头开始
        dom.mediaPlayer.currentTime = 0;
    }
    // =========================================================================

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

    // 5. VIP歌曲无缝切换逻辑
    if (track.isVip && track.originalTrackInfo) {
        console.log(`[Player] 检测到VIP歌曲 "${track.title}"，正在播放试听并后台获取正式URL...`);
        try {
            const result = await window.electronAPI.getVipMusicUrl(track.originalTrackInfo);
            if (result.success && result.url) {
                console.log(`[Player] 成功获取VIP歌曲 "${track.title}" 的正式URL。`);
                const fullUrl = result.url;
                if (getters.isPlaying() && getters.currentTrack()?.src === track.src) {
                    const currentTime = dom.mediaPlayer.currentTime;
                    const onCanPlayThrough = () => {
                        dom.mediaPlayer.currentTime = currentTime;
                        dom.mediaPlayer.play().catch(console.error);
                        dom.mediaPlayer.removeEventListener('canplaythrough', onCanPlayThrough);
                    };
                    dom.mediaPlayer.addEventListener('canplaythrough', onCanPlayThrough);
                    dom.mediaPlayer.src = fullUrl;
                    dom.mediaPlayer.load();
                }
            } else {
                console.warn(`[Player] 获取 "${track.title}" 的正式URL失败: ${result.error}`);
            }
        } catch (error) {
            console.error(`[Player] 请求VIP歌曲URL时发生异常:`, error);
        }
    }
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
function onMediaTimeUpdate() {
    if (getters.isScrubbing()) return;
    const currentTime = dom.mediaPlayer.currentTime;
    mutations.setCurrentTime(currentTime);

    // =========================================================================
    // 【核心修改】节流更新视频播放进度
    // =========================================================================
    // 使用节流防止过于频繁地调用 mutation
    if (!progressUpdateThrottleTimer) {
        progressUpdateThrottleTimer = setTimeout(() => {
            const track = getters.currentTrack();
            const trackIndex = getters.currentTrackIndex();
            // 仅当播放的是列表中的视频时才更新
            if (track && track.type === 'video' && trackIndex !== -1) {
                mutations.updateTrackProgress({
                    index: trackIndex,
                    currentTime: dom.mediaPlayer.currentTime,
                    duration: dom.mediaPlayer.duration
                });
            }
            progressUpdateThrottleTimer = null;
        }, 1000); // 每秒更新一次进度
    }
    // =========================================================================
}

function onMediaCanPlay() { if (getters.isPlaying()) onIsPlayingChanged(true); }
async function onMediaEnded() {
    // =========================================================================
    // 【核心修改】视频播放结束后，将进度重置为0
    // =========================================================================
    const track = getters.currentTrack();
    const trackIndex = getters.currentTrackIndex();
    if (track && track.type === 'video' && trackIndex !== -1) {
        mutations.updateTrackProgress({
            index: trackIndex,
            currentTime: 0, // 播放结束，重置位置
            duration: dom.mediaPlayer.duration
        });
    }
    // =========================================================================

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