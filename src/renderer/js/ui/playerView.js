// src/renderer/js/ui/playerView.js

/**
 * @file 主播放器视图模块
 * @description 负责将核心播放状态同步到主播放器界面，包括轨道信息、进度条、播放控制按钮等。
 */

import * as dom from '../dom.js';
import { getters, subscribe } from '../state.js';
import { PLAY_MODES, DEFAULT_ART } from '../config.js';
import { formatTime } from '../utils.js';

/**
 * 根据当前轨道信息更新UI（标题、歌手、封面图）。
 * @param {object|null} track - 当前轨道对象，或 null。
 */
function updateTrackInfoUI(track) {
    if (dom.trackTitleEl) {
        dom.trackTitleEl.textContent = track?.title || '选择媒体';
    }
    if (dom.trackArtistEl) {
        dom.trackArtistEl.textContent = track?.artist || '开始播放';
    }
    const artUrl = track?.albumArt || DEFAULT_ART;
    if (dom.albumArtEl) {
        dom.albumArtEl.src = artUrl;
    }
    if (dom.controlAlbumArtEl) {
        dom.controlAlbumArtEl.src = artUrl;
    }
}

/**
 * 更新播放列表中当前活动项的高亮状态。
 */
function updatePlaylistActiveItemUI() {
    // 移除旧的高亮
    dom.playlistEl?.querySelector('.active')?.classList.remove('active');
    dom.searchResultsList?.querySelector('.active')?.classList.remove('active');

    const track = getters.currentTrack();
    if (!track) return;

    // 根据是临时曲目还是列表曲目，在高亮不同的列表
    const item = getters.temporaryPlayingTrack()
        ? dom.searchResultsList?.querySelector(`[data-src="${track.originalSrc || track.src}"]`)
        : dom.playlistEl?.querySelector(`[data-index="${getters.currentTrackIndex()}"]`);

    item?.classList.add('active');
}

/**
 * 将播放器UI重置到初始或空状态。
 */
function resetPlayerUI() {
    updateTrackInfoUI(null);
    onTimeChanged({ currentTime: 0, duration: 0 }); // 重置时间显示

    // 重置视觉元素
    dom.playerContainer?.classList.remove('video-mode');
    if (dom.albumArtContainer) dom.albumArtContainer.style.display = 'flex';
    if (dom.mediaPlayer) dom.mediaPlayer.style.display = 'none';
    if (dom.audioVisualizer) dom.audioVisualizer.style.display = 'block';
}

// --- 状态订阅处理函数 ---

/** 当播放状态改变时，更新UI */
function onIsPlayingChanged(isPlaying) {
    if (dom.playPauseBtn) {
        dom.playPauseBtn.classList.toggle('playing', isPlaying);
        dom.playPauseBtn.title = isPlaying ? '暂停' : '播放';
    }
}

/** 当当前轨道改变时，更新整个播放器视图 */
function onCurrentTrackChanged(track) {
    updateTrackInfoUI(track);
    updatePlaylistActiveItemUI();

    if (track) {
        const isVideo = track.type === 'video';
        dom.playerContainer?.classList.toggle('video-mode', isVideo);
        if (dom.albumArtContainer) dom.albumArtContainer.style.display = isVideo ? 'none' : 'flex';
        if (dom.mediaPlayer) dom.mediaPlayer.style.display = isVideo ? 'block' : 'none';
        if (dom.audioVisualizer) dom.audioVisualizer.style.display = isVideo ? 'none' : 'block';
    } else {
        resetPlayerUI();
    }
}

/** 当播放时间更新时，更新进度条 */
function onTimeChanged({ currentTime, duration }) {
    if (getters.isScrubbing()) return; // 拖动进度条时不更新

    if (dom.currentTimeEl) dom.currentTimeEl.textContent = formatTime(currentTime);
    if (dom.durationEl) dom.durationEl.textContent = formatTime(duration);

    const progress = (duration > 0) ? (currentTime / duration) * 100 : 0;
    if (dom.progressBar) {
        dom.progressBar.value = progress;
        dom.progressBar.style.setProperty('--value-percent', `${progress}%`);
    }
}

/** 当音量或静音状态改变时，更新音量条UI */
function onVolumeChanged({ volume, isMuted }) {
    const isEffectivelyMuted = isMuted || volume === 0;
    const volumePercent = isEffectivelyMuted ? 0 : volume * 100;

    if (dom.volumeBar) {
        dom.volumeBar.value = isEffectivelyMuted ? 0 : volume;
        dom.volumeBar.style.setProperty('--value-percent', `${volumePercent}%`);
    }
    dom.volumeBtn?.classList.toggle('muted', isEffectivelyMuted);
}

/** 当播放模式改变时，更新模式按钮的图标和标题 */
function onPlayModeChanged(modeIndex) {
    if (!dom.modeBtn) return;
    const currentMode = PLAY_MODES[modeIndex];
    // 重置类名，只保留必要的 'control-btn'
    dom.modeBtn.className = 'control-btn';
    dom.modeBtn.classList.add(`mode-${currentMode}`);
    const titles = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };
    dom.modeBtn.title = titles[currentMode];
}


/**
 * 初始化主播放器视图模块。
 */
export function init() {
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('timeChanged', onTimeChanged);
    subscribe('volumeChanged', onVolumeChanged);
    subscribe('playModeChanged', onPlayModeChanged);

    // 初始化UI以反映初始状态
    onPlayModeChanged(getters.currentModeIndex());
    onVolumeChanged({ volume: getters.volume(), isMuted: getters.isMuted() });
    onCurrentTrackChanged(getters.currentTrack()); // 确保初始轨道信息正确显示

    console.log("Player View UI module initialized.");
}