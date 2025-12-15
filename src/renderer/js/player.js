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

// 标记 AudioContext 是否已初始化，避免重复创建
let audioContextInitialized = false;
// 用于在加载慢时显示骨架屏的计时器
let skeletonTimer = null;

// --- 辅助函数 ---

/**
 * 设置并初始化 Web Audio API 上下文，用于音频可视化。
 * @private
 */
function _setupAudioContext() {
    if (audioContextInitialized) return;
    try {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256; // 设置FFT大小，影响可视化精度
        const source = context.createMediaElementSource(dom.mediaPlayer);
        // 连接节点：源 -> 分析器 -> 输出设备
        source.connect(analyser).connect(context.destination);
        // 将实例存入全局状态
        mutations.setAudioContext(context);
        mutations.setAnalyser(analyser);
        audioContextInitialized = true;
    } catch (e) {
        console.error("音频上下文 (AudioContext) 初始化失败:", e);
    }
}

/**
 * 加载一个已经完全准备好的轨道对象到媒体播放器。
 * @private
 * @param {object | null} track - 包含可直接播放的 `src` 的轨道对象，或 null 以清空播放器。
 */
async function _loadTrack(track) {
    if (!track || !track.src) {
        dom.mediaPlayer.removeAttribute('src'); // 清空播放器源
        mutations.setParsedLyrics([]);
        mutations.setDuration(0);
        mutations.setIsPlaying(false);
        return;
    }

    // 应用当前状态到媒体元素
    dom.mediaPlayer.playbackRate = getters.playbackRate();
    dom.mediaPlayer.currentTime = 0;

    // 异步加载歌词
    try {
        let lrcText = '';
        if (track.lyrics) {
            // 处理 Base64 Data URL 格式的歌词
            if (track.lyrics.startsWith('data:')) {
                lrcText = decodeURIComponent(track.lyrics.substring('data:text/plain,'.length));
                // 处理自定义 `media://` 协议的本地歌词
            } else if (track.lyrics.startsWith('media://')) {
                const result = await window.electronAPI.getLrcContent(decodeURIComponent(track.lyrics.substring('media://'.length)));
                if (result.success) lrcText = result.data;
            }
            // 如果是临时在线歌曲，则通过IPC获取在线歌词
        } else if (track.lyricId && track.source) {
            const result = await window.electronAPI.getOnlineLyric(track.lyricId, track.source);
            if (result.success) lrcText = result.data;
        }
        mutations.setParsedLyrics(parseLRC(lrcText));
    } catch (error) {
        console.error("加载歌词失败:", error);
        mutations.setParsedLyrics([]); // 即使失败也清空旧歌词
    }

    // 设置媒体源并加载
    dom.mediaPlayer.src = track.src;
    dom.mediaPlayer.load();
}


// --- 状态订阅处理函数 ---

/**
 * 响应 isPlaying 状态的变更，控制媒体的播放与暂停。
 * @param {boolean} isPlaying - 新的播放状态。
 */
function onIsPlayingChanged(isPlaying) {
    if (isPlaying) {
        // 确保有可播放的源
        if (!dom.mediaPlayer.src) return;
        // 首次播放时初始化 AudioContext
        if (!audioContextInitialized) _setupAudioContext();
        // 恢复音频上下文（某些浏览器在非用户交互后会暂停）
        getters.audioContext()?.resume();
        // 播放媒体，并捕获可能的错误
        dom.mediaPlayer.play().catch(e => {
            // 忽略由用户快速切换曲目等操作引起的中断错误
            if (e.name !== 'AbortError') {
                console.error("播放失败:", e);
                mutations.setIsPlaying(false); // 播放失败时，将状态同步回去
            }
        });
    } else {
        dom.mediaPlayer.pause();
    }
}

/**
 * 响应 currentTrack 状态的变更，加载新轨道。
 * @param {object | null} track - 新的当前轨道对象。
 */
function onCurrentTrackChanged(track) {
    clearTimeout(skeletonTimer); // 清除上一个轨道的骨架屏计时器
    if (track) {
        // 延迟显示骨架屏，如果加载很快则不会闪烁
        skeletonTimer = setTimeout(() => _notify('showSkeleton'), 300);
        _loadTrack(track);
    } else {
        _loadTrack(null); // 如果没有轨道，则清空播放器
    }
}

/**
 * 响应 playbackRate 状态的变更，更新播放速率。
 * @param {number} rate - 新的播放速率。
 */
function onPlaybackRateChanged(rate) {
    dom.mediaPlayer.playbackRate = rate;
}

/**
 * 响应音量或静音状态的变更。
 * @param {object} volumeState - 包含 volume 和 isMuted 的对象。
 */
function onVolumeChanged({ volume, isMuted }) {
    dom.mediaPlayer.volume = volume;
    dom.mediaPlayer.muted = isMuted;
}


// --- 媒体元素事件处理 ---

/**
 * 当媒体播放时间更新时触发，用于同步UI。
 */
function onMediaTimeUpdate() {
    // 如果用户正在拖动进度条，则不更新状态，以用户操作为准
    if (!getters.isScrubbing()) {
        mutations.setCurrentTime(dom.mediaPlayer.currentTime);
    }
}

/**
 * 当媒体可以开始播放时触发。
 */
function onMediaCanPlay() {
    clearTimeout(skeletonTimer); // 媒体已加载，隐藏骨架屏
    _notify('hideSkeleton');
    // 如果状态为播放，则确保媒体开始播放
    if (getters.isPlaying()) {
        onIsPlayingChanged(true);
    }
}

/**
 * 当媒体播放结束时触发。
 */
async function onMediaEnded() {
    // 单曲循环模式：重置时间并继续播放
    if (PLAY_MODES[getters.currentModeIndex()] === 'single') {
        dom.mediaPlayer.currentTime = 0;
        mutations.setIsPlaying(true);
    } else {
        // 其他模式：使用命令模式触发下一首
        const { NextTrackCommand } = await import('./features/shortcuts.js');
        new NextTrackCommand().execute();
    }
}

/**
 * 当媒体加载或播放出错时触发。
 */
function onMediaError() {
    clearTimeout(skeletonTimer); // 隐藏骨架屏
    _notify('hideSkeleton');
    // 如果没有设置src，则忽略错误（例如在清空播放器时）
    if (!dom.mediaPlayer.getAttribute('src')) return;
    const track = getters.currentTrack();
    _notify('showToast', { message: `播放失败: ${track?.title || '未知'}`, type: 'error' });
}


// --- 公共 API ---

/**
 * 初始化媒体播放控制器模块。
 */
export function init() {
    // 订阅所有相关的状态变更
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('playbackRateChanged', onPlaybackRateChanged);
    subscribe('volumeChanged', onVolumeChanged);

    // 绑定媒体元素的DOM事件
    dom.mediaPlayer.addEventListener('timeupdate', onMediaTimeUpdate);
    dom.mediaPlayer.addEventListener('loadedmetadata', () => mutations.setDuration(dom.mediaPlayer.duration));
    dom.mediaPlayer.addEventListener('canplay', onMediaCanPlay);
    dom.mediaPlayer.addEventListener('ended', onMediaEnded);
    dom.mediaPlayer.addEventListener('error', onMediaError);

    // 监听全局自定义的 `seekTo` 事件
    window.addEventListener('seekTo', (e) => {
        const time = e.detail;
        if (!isNaN(dom.mediaPlayer.duration)) {
            // 跳转到指定时间，并确保不超出范围
            dom.mediaPlayer.currentTime = Math.max(0, Math.min(dom.mediaPlayer.duration, time));
            // 【核心修复】移除此处的 mutations.setCurrentTime() 调用。
            // 媒体元素的 currentTime 改变后会自动触发 'timeupdate' 事件，
            // 由 onMediaTimeUpdate 统一处理状态同步，从而避免无限循环。
        }
    });

    console.log("媒体播放控制器 (Player Controller) 已初始化。");
}

/**
 * 向其他模块发送通知的辅助函数。
 * @param {string} eventName - 自定义事件的名称。
 * @param {any} data - 传递给事件监听器的数据。
 * @private
 */
function _notify(eventName, data) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: data }));
}