// src/renderer/stores/playerStore.js
/**
 * @file Pinia 播放器状态 Store
 * @description 替代原 state.js，管理所有播放器核心状态。
 * 非 Vue 模块（player.js）通过直接导入此 store 并调用 actions 来更新状态。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { FILTER_MODES } from '../js/config.js';

export const usePlayerStore = defineStore('player', () => {
    // =========================================================================
    // State
    // =========================================================================
    const playlist = ref([]);
    const currentTrackIndex = ref(-1);
    const isPlaying = ref(false);
    const temporaryPlayingTrack = ref(null);
    const parsedLyrics = ref([]);
    const currentModeIndex = ref(0);
    const playbackRate = ref(1.0);
    const videoRotation = ref(0);
    const shortcutSettings = ref({});
    const isRecordingShortcut = ref(false);
    const currentRecordingAction = ref(null);
    const isDraggingLyrics = ref(false);
    const isScrubbing = ref(false);
    const audioContext = ref(null);
    const analyser = ref(null);
    const currentGradientColors = ref(null);
    const isScreensaverMode = ref(false);
    const volume = ref(1.0);
    const isMuted = ref(false);
    const currentTime = ref(0);
    const duration = ref(0);
    const mediaFilterMode = ref(FILTER_MODES.ALL);

    // =========================================================================
    // Getters
    // =========================================================================
    const currentTrack = computed(() =>
        temporaryPlayingTrack.value ||
        (currentTrackIndex.value > -1 ? playlist.value[currentTrackIndex.value] : null)
    );

    const filteredPlaylist = computed(() => {
        const mode = mediaFilterMode.value;
        const list = playlist.value;
        if (mode === FILTER_MODES.AUDIO) return list.filter(t => t.type !== 'video');
        if (mode === FILTER_MODES.VIDEO) return list.filter(t => t.type === 'video');
        return list;
    });

    // =========================================================================
    // Actions
    // =========================================================================
    function setPlaylist(newPlaylist) {
        if (!Array.isArray(newPlaylist)) return;
        playlist.value = newPlaylist;
    }

    function updateTrackProgress({ index, currentTime: ct, duration: dur }) {
        if (index >= 0 && index < playlist.value.length) {
            const track = playlist.value[index];
            if (track.lastPosition !== ct) track.lastPosition = ct;
            if (track.totalDuration !== dur) track.totalDuration = dur;
        }
    }

    function removeTrack(indexToRemove) {
        if (indexToRemove < 0 || indexToRemove >= playlist.value.length) return;
        playlist.value.splice(indexToRemove, 1);
        if (indexToRemove < currentTrackIndex.value) currentTrackIndex.value--;
        if (playlist.value.length === 0) currentTrackIndex.value = -1;
    }

    function prependTrackWhilePlaying(newTrack) {
        if (!newTrack || typeof newTrack !== 'object') return;
        const currentSrc = currentTrack.value?.src || null;
        playlist.value.unshift(newTrack);
        if (currentSrc) {
            currentTrackIndex.value = playlist.value.findIndex(t => t.src === currentSrc);
        } else if (currentTrackIndex.value > -1) {
            currentTrackIndex.value++;
        }
    }

    function setCurrentTrackIndex(index, force = false) {
        if (currentTrackIndex.value === index && !temporaryPlayingTrack.value && !force) return;
        currentTrackIndex.value = index;
        temporaryPlayingTrack.value = null;
    }

    function setTemporaryPlayingTrack(track) {
        if (temporaryPlayingTrack.value === track) return;
        temporaryPlayingTrack.value = track;
        currentTrackIndex.value = -1;
    }

    function clearPlayingTrackInfo() {
        temporaryPlayingTrack.value = null;
        currentTrackIndex.value = -1;
    }

    function togglePlayState() { setIsPlaying(!isPlaying.value); }

    function setIsPlaying(playing) {
        isPlaying.value = !!playing;
    }

    function setParsedLyrics(lyrics) { parsedLyrics.value = lyrics; }

    function cyclePlayMode() {
        currentModeIndex.value = (currentModeIndex.value + 1) % 3;
    }

    function setCurrentModeIndex(index) {
        const newIndex = parseInt(index, 10);
        if (isNaN(newIndex) || newIndex < 0 || newIndex > 2) return;
        currentModeIndex.value = newIndex;
    }

    function setPlaybackRate(rate) {
        if (typeof rate !== 'number' || rate < 0.2 || rate > 5.0) return;
        playbackRate.value = rate;
    }

    function setVideoRotation(rotation) {
        let normalized = rotation % 360;
        if (normalized < 0) normalized += 360;
        videoRotation.value = normalized;
    }

    function setShortcutSettings(settings) { shortcutSettings.value = settings; }
    function setIsRecordingShortcut(v) { isRecordingShortcut.value = v; }
    function setCurrentRecordingAction(action) { currentRecordingAction.value = action; }
    function setIsDraggingLyrics(v) { isDraggingLyrics.value = v; }
    function setIsScrubbing(v) { isScrubbing.value = v; }
    function setAudioContext(ctx) { audioContext.value = ctx; }
    function setAnalyser(a) { analyser.value = a; }
    function setCurrentGradientColors(colors) { currentGradientColors.value = colors; }

    function setScreensaverMode(value) { isScreensaverMode.value = value; }

    function setVolume(newVolume) {
        volume.value = Math.max(0, Math.min(1, newVolume));
    }

    function setIsMuted(muted) { isMuted.value = !!muted; }

    function setCurrentTime(time) { currentTime.value = time; }

    function setDuration(dur) { duration.value = dur; }

    function setMediaFilterMode(mode) {
        if (!Object.values(FILTER_MODES).includes(mode)) return;
        mediaFilterMode.value = mode;
    }

    return {
        // state
        playlist, currentTrackIndex, isPlaying, temporaryPlayingTrack,
        parsedLyrics, currentModeIndex, playbackRate, videoRotation,
        shortcutSettings, isRecordingShortcut, currentRecordingAction,
        isDraggingLyrics, isScrubbing, audioContext, analyser,
        currentGradientColors, isScreensaverMode, volume, isMuted,
        currentTime, duration, mediaFilterMode,
        // getters
        currentTrack, filteredPlaylist,
        // actions
        setPlaylist, updateTrackProgress, removeTrack, prependTrackWhilePlaying,
        setCurrentTrackIndex, setTemporaryPlayingTrack, clearPlayingTrackInfo,
        togglePlayState, setIsPlaying, setParsedLyrics, cyclePlayMode,
        setCurrentModeIndex, setPlaybackRate, setVideoRotation,
        setShortcutSettings, setIsRecordingShortcut, setCurrentRecordingAction,
        setIsDraggingLyrics, setIsScrubbing, setAudioContext, setAnalyser,
        setCurrentGradientColors, setScreensaverMode, setVolume, setIsMuted,
        setCurrentTime, setDuration, setMediaFilterMode,
    };
});
