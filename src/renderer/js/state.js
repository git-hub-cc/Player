// src/renderer/js/state.js

/**
 * @file 状态管理器 (State Manager)
 * @description
 * 这是一个可观测的状态容器，采用发布-订阅模式实现。
 * 它是整个渲染进程的“单一数据源”(Single Source of Truth)。
 *
 * 工作流程:
 * 1. UI事件或其他模块调用 `mutations` 中的方法来请求状态变更。
 * 2. `mutations` 方法更新私有的 `_state` 对象。
 * 3. 更新后，通过 `_notify` 方法通知所有订阅了该状态变化的模块。
 * 4. 其他模块（如 player.js, ui.js）通过 `subscribe` 方法监听变更，并做出响应。
 *
 * 优点:
 * - 集中管理：所有状态和变更逻辑都集中在此，易于跟踪和调试。
 * - 单向数据流：避免了模块间的循环依赖和混乱调用，代码结构更清晰。
 * - 可预测性：状态的变更总是通过 mutations 发起，行为可预测。
 */

// --- 私有状态存储 ---
const _state = {
    playlist: [],
    currentTrackIndex: -1,
    isPlaying: false,
    temporaryPlayingTrack: null,
    parsedLyrics: [],
    currentModeIndex: 0, // 0: list, 1: single, 2: shuffle
    playbackRate: 1.0,
    shortcutSettings: {},
    isRecordingShortcut: false,
    currentRecordingAction: null,
    isDraggingLyrics: false,
    isScrubbing: false,
    audioContext: null,
    analyser: null,
    currentGradientColors: null,
    isScreensaverMode: false,
    // --- 新增用于媒体控制的状态 ---
    volume: 1.0,
    isMuted: false,
    currentTime: 0,
    duration: 0,
};

// --- 私有订阅者列表 ---
const _listeners = {};

/**
 * 通知订阅者状态已发生变化。
 * @private
 * @param {string} eventName - 事件名称 (例如 'playlistChanged')。
 * @param {*} data - 传递给订阅者回调函数的数据。
 */
function _notify(eventName, data) {
    if (!_listeners[eventName]) {
        return;
    }
    _listeners[eventName].forEach(callback => {
        try {
            callback(data);
        } catch (error) {
            console.error(`Error in subscriber for event "${eventName}":`, error);
        }
    });
}


// =========================================================================
// --- 公共 API ---
// =========================================================================

/**
 * 订阅一个状态变更事件。
 * @param {string} eventName - 要订阅的事件名称。
 * @param {Function} callback - 状态变更时要执行的回调函数。
 * @returns {Function} - 一个用于取消订阅的函数。
 */
export function subscribe(eventName, callback) {
    if (typeof callback !== 'function') {
        console.error(`Invalid callback provided for event "${eventName}".`);
        return () => {}; // 返回一个无操作的函数
    }
    if (!_listeners[eventName]) {
        _listeners[eventName] = [];
    }
    _listeners[eventName].push(callback);

    // 返回一个取消订阅的函数，便于组件销毁时清理
    return () => {
        _listeners[eventName] = _listeners[eventName].filter(cb => cb !== callback);
    };
}

/**
 * 用于修改状态的方法集合。所有状态变更都必须通过调用这些方法来完成。
 */
export const mutations = {
    setPlaylist(newPlaylist) {
        if (!Array.isArray(newPlaylist)) return;
        _state.playlist = newPlaylist;
        _notify('playlistChanged', _state.playlist);
    },

    removeTrack(indexToRemove) {
        if (indexToRemove < 0 || indexToRemove >= _state.playlist.length) return;

        _state.playlist.splice(indexToRemove, 1);

        if (indexToRemove < _state.currentTrackIndex) {
            _state.currentTrackIndex--;
        }

        if (_state.playlist.length === 0) {
            _state.currentTrackIndex = -1;
        }
        // 通知播放列表和当前轨道索引可能都已改变
        _notify('playlistChanged', _state.playlist);
        _notify('currentTrackIndexChanged', _state.currentTrackIndex);
    },

    // =========================================================================
    // 【核心新增】添加一个在不中断播放的情况下向列表头部添加曲目的方法
    // =========================================================================
    /**
     * 在播放列表头部“静默”地插入一个新轨道，同时保持当前播放的轨道不变。
     * 此方法仅会触发 'playlistChanged' 通知，不会触发 'currentTrackChanged'，
     * 从而避免了不必要的播放器重载。
     * @param {object} newTrack - 要添加的新轨道对象。
     */
    prependTrackWhilePlaying(newTrack) {
        if (!newTrack || typeof newTrack !== 'object') {
            console.warn('[State] prependTrackWhilePlaying: 提供了无效的轨道对象。');
            return;
        }

        // 1. 记住当前正在播放的轨道（通过其 src 作为唯一标识）
        const currentPlayingTrack = getters.currentTrack();
        const currentSrc = currentPlayingTrack ? currentPlayingTrack.src : null;

        // 2. 将新轨道添加到播放列表的开头
        _state.playlist.unshift(newTrack);

        // 3. 重新计算当前播放轨道的索引
        if (currentSrc) {
            // 在更新后的播放列表中找到旧轨道的 newIndex
            const newCurrentIndex = _state.playlist.findIndex(track => track.src === currentSrc);
            // 更新内部状态中的索引
            _state.currentTrackIndex = newCurrentIndex;
        } else {
            // 如果之前没有歌曲在播放，但有一个有效的索引（例如索引为0的歌曲暂停中），
            // 则由于在前面插入了新歌，旧索引需要加一。
            if (_state.currentTrackIndex > -1) {
                _state.currentTrackIndex++;
            }
        }

        // 4. 只通知UI播放列表已发生变化，让UI自行重绘
        _notify('playlistChanged', _state.playlist);
    },
    // =========================================================================

    /**
     * 设置当前播放轨道的索引。
     * @param {number} index - 新的轨道索引。
     * @param {boolean} [force=false] - 是否强制触发更新通知。
     */
    setCurrentTrackIndex(index, force = false) {
        // 如果索引未变，且没有临时曲目，并且不是强制更新，则直接返回以避免不必要的操作。
        if (_state.currentTrackIndex === index && !_state.temporaryPlayingTrack && !force) {
            return;
        }
        _state.currentTrackIndex = index;
        _state.temporaryPlayingTrack = null;
        _notify('currentTrackChanged', getters.currentTrack());
    },

    setTemporaryPlayingTrack(track) {
        if (_state.temporaryPlayingTrack === track) return;
        _state.temporaryPlayingTrack = track;
        _state.currentTrackIndex = -1;
        _notify('currentTrackChanged', getters.currentTrack());
    },

    clearPlayingTrackInfo() {
        if (!_state.temporaryPlayingTrack && _state.currentTrackIndex === -1) return;
        _state.temporaryPlayingTrack = null;
        _state.currentTrackIndex = -1;
        _notify('currentTrackChanged', null);
    },

    togglePlayState() {
        mutations.setIsPlaying(!_state.isPlaying);
    },

    setIsPlaying(playing) {
        const boolPlaying = !!playing;
        if (_state.isPlaying === boolPlaying) return;
        _state.isPlaying = boolPlaying;
        _notify('isPlayingChanged', _state.isPlaying);
    },

    setParsedLyrics(lyrics) {
        _state.parsedLyrics = lyrics;
        _notify('lyricsChanged', _state.parsedLyrics);
    },

    cyclePlayMode() {
        _state.currentModeIndex = (_state.currentModeIndex + 1) % 3;
        _notify('playModeChanged', _state.currentModeIndex);
    },

    /**
     * 直接设置播放模式的索引。
     * @param {number} index - 要设置的模式索引 (0: 列表, 1: 单曲, 2: 随机)。
     */
    setCurrentModeIndex(index) {
        // 鲁棒性检查：确保索引是有效的数字且在范围内 [0, 1, 2]
        const newIndex = parseInt(index, 10);
        if (isNaN(newIndex) || newIndex < 0 || newIndex > 2) {
            console.warn(`[State] Attempted to set invalid play mode index: ${index}`);
            return;
        }
        // 如果新索引与当前索引相同，则不执行任何操作以避免不必要的通知
        if (_state.currentModeIndex === newIndex) {
            return;
        }
        _state.currentModeIndex = newIndex;
        _notify('playModeChanged', _state.currentModeIndex);
    },

    setPlaybackRate(newRate) {
        if (typeof newRate !== 'number' || newRate < 0.2 || newRate > 5.0) return;
        _state.playbackRate = newRate;
        _notify('playbackRateChanged', _state.playbackRate);
    },

    setShortcutSettings(settings) {
        _state.shortcutSettings = settings;
        _notify('shortcutSettingsChanged', _state.shortcutSettings);
    },

    setIsRecordingShortcut(isRecording) {
        _state.isRecordingShortcut = isRecording;
        _notify('isRecordingShortcutChanged', _state.isRecordingShortcut);
    },

    setCurrentRecordingAction(action) {
        _state.currentRecordingAction = action;
    },

    setIsDraggingLyrics(isDragging) {
        _state.isDraggingLyrics = isDragging;
    },

    setIsScrubbing(isScrubbing) {
        _state.isScrubbing = isScrubbing;
    },

    setAudioContext(context) {
        _state.audioContext = context;
    },

    setAnalyser(analyser) {
        _state.analyser = analyser;
    },

    setCurrentGradientColors(colors) {
        _state.currentGradientColors = colors;
        _notify('gradientColorsChanged', _state.currentGradientColors);
    },

    setScreensaverMode(value) {
        if (_state.isScreensaverMode === value) return;
        _state.isScreensaverMode = value;
        _notify('screensaverModeChanged', _state.isScreensaverMode);
    },

    // --- 媒体控制相关 mutations ---
    setVolume(newVolume) {
        const volume = Math.max(0, Math.min(1, newVolume));
        if (_state.volume === volume) return;
        _state.volume = volume;
        _notify('volumeChanged', { volume: _state.volume, isMuted: _state.isMuted });
    },

    setIsMuted(muted) {
        const boolMuted = !!muted;
        if (_state.isMuted === boolMuted) return;
        _state.isMuted = boolMuted;
        _notify('volumeChanged', { volume: _state.volume, isMuted: _state.isMuted });
    },

    setCurrentTime(time) {
        _state.currentTime = time;
        _notify('timeChanged', { currentTime: _state.currentTime, duration: _state.duration });
    },

    setDuration(duration) {
        _state.duration = duration;
        _notify('timeChanged', { currentTime: _state.currentTime, duration: _state.duration });
    },
};

/**
 * 用于安全地读取状态的方法集合。
 */
export const getters = {
    playlist: () => _state.playlist,
    currentTrackIndex: () => _state.currentTrackIndex,
    isPlaying: () => _state.isPlaying,
    temporaryPlayingTrack: () => _state.temporaryPlayingTrack,
    currentTrack: () => _state.temporaryPlayingTrack || (_state.currentTrackIndex > -1 ? _state.playlist[_state.currentTrackIndex] : null),
    parsedLyrics: () => _state.parsedLyrics,
    currentModeIndex: () => _state.currentModeIndex,
    playbackRate: () => _state.playbackRate,
    shortcutSettings: () => _state.shortcutSettings,
    isRecordingShortcut: () => _state.isRecordingShortcut,
    currentRecordingAction: () => _state.currentRecordingAction,
    isDraggingLyrics: () => _state.isDraggingLyrics,
    isScrubbing: () => _state.isScrubbing,
    audioContext: () => _state.audioContext,
    analyser: () => _state.analyser,
    currentGradientColors: () => _state.currentGradientColors,
    isScreensaverMode: () => _state.isScreensaverMode,
    volume: () => _state.volume,
    isMuted: () => _state.isMuted,
    currentTime: () => _state.currentTime,
    duration: () => _state.duration,
};