// src/renderer/js/player.js

/**
 * @file 媒体播放控制器 (Media Controller)
 * @description
 * 职责极其纯粹的模块：订阅状态，并根据状态控制 `<video>` 元素。
 * 它不关心URL如何解析，也不关心UI如何展示，只负责播放这个动作本身。
 */

import * as dom from './dom.js';
import { getters, mutations, subscribe } from './state.js';
import { PLAY_MODES } from './config.js';
import { parseLRC } from './utils.js';

// --- 模块私有变量 ---
let audioContextInitialized = false;
let skeletonTimer = null;

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
        console.error("AudioContext setup failed:", e);
    }
}

/**
 * 加载一个已经完全准备好的轨道对象。
 * @private
 * @param {object} track - 包含可直接播放的 `src` 的轨道对象。
 */
async function _loadTrack(track) {
    if (!track || !track.src) {
        dom.mediaPlayer.removeAttribute('src');
        mutations.setParsedLyrics([]);
        mutations.setDuration(0);
        mutations.setIsPlaying(false);
        return;
    }

    dom.mediaPlayer.playbackRate = getters.playbackRate();
    dom.mediaPlayer.currentTime = 0;

    // 加载歌词
    try {
        let lrcText = '';
        if (track.lyrics) {
            if (track.lyrics.startsWith('data:')) {
                lrcText = decodeURIComponent(track.lyrics.substring('data:text/plain,'.length));
            } else if (track.lyrics.startsWith('media://')) {
                const result = await window.electronAPI.getLrcContent(decodeURIComponent(track.lyrics.substring('media://'.length)));
                if (result.success) lrcText = result.data;
            }
        } else if (track.lyricId && track.source) { // 临时在线歌曲
            const result = await window.electronAPI.getOnlineLyric(track.lyricId, track.source);
            if (result.success) lrcText = result.data;
        }
        mutations.setParsedLyrics(parseLRC(lrcText));
    } catch (error) {
        console.error("Failed to load lyrics:", error);
        mutations.setParsedLyrics([]);
    }

    dom.mediaPlayer.src = track.src;
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
                console.error("Playback failed:", e);
                mutations.setIsPlaying(false);
            }
        });
    } else {
        dom.mediaPlayer.pause();
    }
}

function onCurrentTrackChanged(track) {
    clearTimeout(skeletonTimer);
    if (track) {
        skeletonTimer = setTimeout(() => _notify('showSkeleton'), 300);
        _loadTrack(track);
    } else {
        _loadTrack(null);
    }
}

function onPlaybackRateChanged(rate) {
    dom.mediaPlayer.playbackRate = rate;
}

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
    clearTimeout(skeletonTimer);
    _notify('hideSkeleton');
    if (getters.isPlaying()) {
        onIsPlayingChanged(true);
    }
}

async function onMediaEnded() {
    if (PLAY_MODES[getters.currentModeIndex()] === 'single') {
        dom.mediaPlayer.currentTime = 0;
        mutations.setIsPlaying(true);
    } else {
        // 使用命令模式触发下一首
        const { NextTrackCommand } = await import('./features/shortcuts.js');
        new NextTrackCommand().execute();
    }
}

function onMediaError() {
    clearTimeout(skeletonTimer);
    _notify('hideSkeleton');
    if (!dom.mediaPlayer.getAttribute('src')) return;
    const track = getters.currentTrack();
    _notify('showToast', { message: `播放失败: ${track?.title || '未知'}`, type: 'error' });
}


// --- 公共 API ---

export function init() {
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('playbackRateChanged', onPlaybackRateChanged);
    subscribe('volumeChanged', onVolumeChanged);

    dom.mediaPlayer.addEventListener('timeupdate', onMediaTimeUpdate);
    dom.mediaPlayer.addEventListener('loadedmetadata', () => mutations.setDuration(dom.mediaPlayer.duration));
    dom.mediaPlayer.addEventListener('canplay', onMediaCanPlay);
    dom.mediaPlayer.addEventListener('ended', onMediaEnded);
    dom.mediaPlayer.addEventListener('error', onMediaError);

    window.addEventListener('seekTo', (e) => {
        const time = e.detail;
        if (!isNaN(dom.mediaPlayer.duration)) {
            dom.mediaPlayer.currentTime = Math.max(0, Math.min(dom.mediaPlayer.duration, time));
            mutations.setCurrentTime(dom.mediaPlayer.currentTime);
        }
    });

    console.log("Player Controller initialized.");
}

function _notify(eventName, data) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: data }));
}