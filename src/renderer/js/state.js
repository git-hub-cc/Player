// src/renderer/js/state.js

/**
 * @file 状态管理器 (State Manager)
 * @description
 * 渲染进程的“单一数据源”。
 */

// --- 私有状态存储 ---
const _state = {
    playlist: [],
    currentTrackIndex: -1,
    isPlaying: false,
    temporaryPlayingTrack: null,
    parsedLyrics: [],
    currentModeIndex: 0,
    playbackRate: 1.0,
    // =========================================================================
    // 【核心新增】视频旋转角度状态
    // =========================================================================
    videoRotation: 0,
    // =========================================================================
    shortcutSettings: {},
    isRecordingShortcut: false,
    currentRecordingAction: null,
    isDraggingLyrics: false,
    isScrubbing: false,
    audioContext: null,
    analyser: null,
    currentGradientColors: null,
    isScreensaverMode: false,
    volume: 1.0,
    isMuted: false,
    currentTime: 0,
    duration: 0,
};

// --- 私有订阅者列表 ---
const _listeners = {};

/**
 * 通知订阅者状态已发生变化。
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

export function subscribe(eventName, callback) {
    if (typeof callback !== 'function') {
        console.error(`Invalid callback provided for event "${eventName}".`);
        return () => {};
    }
    if (!_listeners[eventName]) {
        _listeners[eventName] = [];
    }
    _listeners[eventName].push(callback);
    return () => {
        _listeners[eventName] = _listeners[eventName].filter(cb => cb !== callback);
    };
}

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
        _notify('playlistChanged', _state.playlist);
        _notify('currentTrackIndexChanged', _state.currentTrackIndex);
    },

    prependTrackWhilePlaying(newTrack) {
        if (!newTrack || typeof newTrack !== 'object') return;
        const currentPlayingTrack = getters.currentTrack();
        const currentSrc = currentPlayingTrack ? currentPlayingTrack.src : null;
        _state.playlist.unshift(newTrack);
        if (currentSrc) {
            const newCurrentIndex = _state.playlist.findIndex(track => track.src === currentSrc);
            _state.currentTrackIndex = newCurrentIndex;
        } else {
            if (_state.currentTrackIndex > -1) {
                _state.currentTrackIndex++;
            }
        }
        _notify('playlistChanged', _state.playlist);
    },

    setCurrentTrackIndex(index, force = false) {
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

    setCurrentModeIndex(index) {
        const newIndex = parseInt(index, 10);
        if (isNaN(newIndex) || newIndex < 0 || newIndex > 2) return;
        if (_state.currentModeIndex === newIndex) return;
        _state.currentModeIndex = newIndex;
        _notify('playModeChanged', _state.currentModeIndex);
    },

    setPlaybackRate(newRate) {
        if (typeof newRate !== 'number' || newRate < 0.2 || newRate > 5.0) return;
        _state.playbackRate = newRate;
        _notify('playbackRateChanged', _state.playbackRate);
    },

    // =========================================================================
    // 【核心新增】设置视频旋转角度的方法
    // =========================================================================
    setVideoRotation(rotation) {
        // 规范化角度到 0-360 之间
        let normalized = rotation % 360;
        if (normalized < 0) normalized += 360;

        if (_state.videoRotation === normalized) return;
        _state.videoRotation = normalized;
        _notify('videoRotationChanged', _state.videoRotation);
    },
    // =========================================================================

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

export const getters = {
    playlist: () => _state.playlist,
    currentTrackIndex: () => _state.currentTrackIndex,
    isPlaying: () => _state.isPlaying,
    temporaryPlayingTrack: () => _state.temporaryPlayingTrack,
    currentTrack: () => _state.temporaryPlayingTrack || (_state.currentTrackIndex > -1 ? _state.playlist[_state.currentTrackIndex] : null),
    parsedLyrics: () => _state.parsedLyrics,
    currentModeIndex: () => _state.currentModeIndex,
    playbackRate: () => _state.playbackRate,
    // 【核心新增】获取视频旋转角度
    videoRotation: () => _state.videoRotation,
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