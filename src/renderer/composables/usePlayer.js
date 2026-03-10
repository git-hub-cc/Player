// src/renderer/composables/usePlayer.js
/**
 * @file 媒体播放控制器 Composable
 * @description 封装所有 HTMLMediaElement 操作，监听 Pinia store 状态变化来控制播放。
 * 在 App.vue 的 onMounted 中调用一次以初始化。
 */

import { watch } from 'vue';
import { usePlayerStore } from '../stores/playerStore.js';
import { PLAY_MODES } from '../js/config.js';
import { parseLRC } from '../js/utils.js';

let audioContextInitialized = false;
let progressUpdateThrottleTimer = null;
let _mediaEl = null; // 对 <video> 元素的引用
let _seekToHandler = null; // 保存监听引用以便卸载时清理

function _setupAudioContext(playerStore) {
    if (audioContextInitialized) return;
    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        const source = context.createMediaElementSource(_mediaEl);
        source.connect(analyser).connect(context.destination);
        playerStore.setAudioContext(context);
        playerStore.setAnalyser(analyser);
        audioContextInitialized = true;
    } catch (e) {
        console.error('AudioContext 初始化失败:', e);
    }
}

async function _loadTrack(track, playerStore) {
    playerStore.setParsedLyrics([]);
    playerStore.setDuration(0);
    playerStore.setVideoRotation(0);

    if (!track || !track.src) {
        _mediaEl.removeAttribute('src');
        playerStore.setIsPlaying(false);
        return;
    }

    _mediaEl.playbackRate = playerStore.playbackRate;
    _mediaEl.src = track.src;

    if (track.type === 'video' && track.lastPosition > 0) {
        const onMetadataLoaded = () => {
            if (track.lastPosition < _mediaEl.duration) {
                _mediaEl.currentTime = track.lastPosition;
            }
            _mediaEl.removeEventListener('loadedmetadata', onMetadataLoaded);
        };
        _mediaEl.addEventListener('loadedmetadata', onMetadataLoaded);
    } else {
        _mediaEl.currentTime = 0;
    }

    // 异步加载歌词
    (async () => {
        try {
            let lrcText = '';
            if (track.lyrics) {
                if (track.lyrics.startsWith('data:')) {
                    lrcText = decodeURIComponent(track.lyrics.substring('data:text/plain,'.length));
                } else if (track.lyrics.startsWith('media://')) {
                    const result = await window.electronAPI.getLrcContent(
                        decodeURIComponent(track.lyrics.substring('media://'.length))
                    );
                    if (result.success) lrcText = result.data;
                }
            } else if (track.id && track.source) {
                const result = await window.electronAPI.getOnlineLyric(track);
                if (result.success) lrcText = result.data;
            }
            if (lrcText) playerStore.setParsedLyrics(parseLRC(lrcText));
        } catch {
            playerStore.setParsedLyrics([]);
        }
    })();

    _mediaEl.load();

    // VIP 歌曲无缝切换
    if (track.isVip && track.originalTrackInfo) {
        try {
            const result = await window.electronAPI.getVipMusicUrl(track.originalTrackInfo);
            if (result.success && result.url) {
                const fullUrl = result.url;
                if (playerStore.isPlaying && playerStore.currentTrack?.src === track.src) {
                    const currentTime = _mediaEl.currentTime;
                    const onCanPlayThrough = () => {
                        _mediaEl.currentTime = currentTime;
                        _mediaEl.play().catch(console.error);
                        _mediaEl.removeEventListener('canplaythrough', onCanPlayThrough);
                    };
                    _mediaEl.addEventListener('canplaythrough', onCanPlayThrough);
                    _mediaEl.src = fullUrl;
                    _mediaEl.load();
                }
            }
        } catch (error) {
            console.error('[Player] 请求VIP歌曲URL时异常:', error);
        }
    }
}

/**
 * 初始化播放器 Composable
 * @param {HTMLVideoElement} mediaEl - 视频元素
 */
export function usePlayer(mediaEl) {
    _mediaEl = mediaEl;
    const playerStore = usePlayerStore();

    // 监听播放状态
    watch(() => playerStore.isPlaying, (isPlaying) => {
        if (isPlaying) {
            if (!_mediaEl.src) return;
            if (!audioContextInitialized) _setupAudioContext(playerStore);
            playerStore.audioContext?.resume();
            _mediaEl.play().catch(e => {
                if (e.name !== 'AbortError') {
                    console.error('播放失败:', e);
                    playerStore.setIsPlaying(false);
                }
            });
        } else {
            _mediaEl.pause();
        }
    });

    // 监听当前曲目变化
    watch(() => playerStore.currentTrack, (track) => {
        _loadTrack(track || null, playerStore);
    });

    // 监听倍速变化
    watch(() => playerStore.playbackRate, (rate) => {
        _mediaEl.playbackRate = rate;
    });

    // 监听视频旋转
    watch(() => playerStore.videoRotation, (deg) => {
        _mediaEl.style.transform = `rotate(${deg}deg)`;
    });

    // 监听音量变化
    watch(() => [playerStore.volume, playerStore.isMuted], ([volume, isMuted]) => {
        _mediaEl.volume = volume;
        _mediaEl.muted = isMuted;
    });

    // 媒体元素事件
    _mediaEl.addEventListener('timeupdate', () => {
        if (playerStore.isScrubbing) return;
        playerStore.setCurrentTime(_mediaEl.currentTime);

        if (!progressUpdateThrottleTimer) {
            progressUpdateThrottleTimer = setTimeout(() => {
                const track = playerStore.currentTrack;
                const trackIndex = playerStore.currentTrackIndex;
                if (track && track.type === 'video' && trackIndex !== -1) {
                    playerStore.updateTrackProgress({
                        index: trackIndex,
                        currentTime: _mediaEl.currentTime,
                        duration: _mediaEl.duration
                    });
                }
                progressUpdateThrottleTimer = null;
            }, 1000);
        }
    });

    _mediaEl.addEventListener('loadedmetadata', () => {
        playerStore.setDuration(_mediaEl.duration);
    });

    _mediaEl.addEventListener('canplay', () => {
        if (playerStore.isPlaying) {
            if (!audioContextInitialized) _setupAudioContext(playerStore);
            playerStore.audioContext?.resume();
            _mediaEl.play().catch(e => {
                if (e.name !== 'AbortError') playerStore.setIsPlaying(false);
            });
        }
    });

    _mediaEl.addEventListener('ended', async () => {
        const track = playerStore.currentTrack;
        const trackIndex = playerStore.currentTrackIndex;
        if (track && track.type === 'video' && trackIndex !== -1) {
            playerStore.updateTrackProgress({ index: trackIndex, currentTime: 0, duration: _mediaEl.duration });
        }

        if (PLAY_MODES[playerStore.currentModeIndex] === 'single') {
            _mediaEl.currentTime = 0;
            playerStore.setIsPlaying(true);
        } else {
            const { NextTrackCommand } = await import('../js/features/shortcuts.js');
            new NextTrackCommand().execute();
        }
    });

    _mediaEl.addEventListener('error', () => {
        if (!_mediaEl.getAttribute('src')) return;
        const track = playerStore.currentTrack;
        if (_mediaEl.error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: `播放失败: ${track?.title || '未知'}`, type: 'error' }
            }));
        }
    });

    // 支持 seekTo 全局事件
    _seekToHandler = (e) => {
        const time = e.detail;
        if (_mediaEl && !isNaN(_mediaEl.duration)) {
            _mediaEl.currentTime = Math.max(0, Math.min(_mediaEl.duration, time));
        }
    };
    window.addEventListener('seekTo', _seekToHandler);

    // 暴露 mediaEl 引用，供其他逻辑使用（如 deleteTrack 等待 emptied 事件）
    return { mediaEl: _mediaEl };
}

/** 获取当前媒体元素（供 mediaService 等模块使用） */
export function getMediaElement() { return _mediaEl; }

/** 卸载时调用，清理全局事件监听，防止内存泄漏 */
export function cleanupPlayer() {
    if (_seekToHandler) {
        window.removeEventListener('seekTo', _seekToHandler);
        _seekToHandler = null;
    }
    if (progressUpdateThrottleTimer) {
        clearTimeout(progressUpdateThrottleTimer);
        progressUpdateThrottleTimer = null;
    }
}
