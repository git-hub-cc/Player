<template>
  <footer class="player-controls">
    <!-- 曲目信息 -->
    <div class="track-info">
      <img id="control-album-art" :src="albumArt" alt="Album Art" crossorigin="anonymous" draggable="false">
      <div class="track-details">
        <div id="track-title">{{ title }}</div>
        <div id="track-artist">{{ artist }}</div>
      </div>
    </div>

    <!-- 主控制区 -->
    <div class="main-controls">
      <div class="control-buttons">
        <button id="mobile-lyrics-btn" class="control-btn mobile-only-btn" title="显示/隐藏歌词"
          @click="uiStore.toggleLyricsPanel()">
          <span v-html="icons.ICON_MOBILE_LYRICS"></span>
        </button>
        <button id="prev-btn" class="control-btn" title="上一首" @click="prevTrack">
          <span v-html="icons.ICON_PREV"></span>
        </button>
        <button id="play-pause-btn" class="control-btn play-btn" :class="{ playing: playerStore.isPlaying }"
          :title="playerStore.isPlaying ? '暂停' : '播放'" @click="playerStore.togglePlayState()">
          <span v-html="icons.ICON_PLAY"></span>
          <span v-html="icons.ICON_PAUSE"></span>
        </button>
        <button id="next-btn" class="control-btn" title="下一首" @click="nextTrack">
          <span v-html="icons.ICON_NEXT"></span>
        </button>
        <button id="mobile-playlist-btn" class="control-btn mobile-only-btn" title="媒体库"
          @click="uiStore.togglePanel('playlist')">
          <span v-html="icons.ICON_MOBILE_PLAYLIST"></span>
        </button>
      </div>

      <!-- 进度条 -->
      <div class="progress-container">
        <span id="current-time">{{ formatTime(playerStore.currentTime) }}</span>
        <input type="range" id="progress-bar" class="progress-bar" min="0" max="100"
          :value="progressPercent" :style="{ '--value-percent': progressPercent + '%' }"
          @mousedown="playerStore.setIsScrubbing(true)"
          @change="onProgressChange">
        <span id="duration">{{ formatTime(playerStore.duration) }}</span>
      </div>
    </div>

    <!-- 侧边控制 -->
    <div class="side-controls">
      <!-- 更多选项 -->
      <div class="more-options-container">
        <button id="more-options-btn" class="control-btn" title="更多选项"
          @click.stop="uiStore.toggleMoreOptionsMenu()">
          <span v-html="icons.ICON_MORE_OPTIONS"></span>
        </button>
        <div id="more-options-menu" class="more-options-menu"
          :class="{ visible: uiStore.isMoreOptionsMenuVisible }">
          <ul>
            <li id="shortcut-btn" @click="openShortcut">
              <span v-html="icons.ICON_KEYBOARD"></span>
              <span>快捷键设置</span>
            </li>
            <li id="settings-btn" @click="openSettings">
              <span v-html="icons.ICON_SETTINGS" style="width: 18px; height: 18px;"></span>
              <span>系统设置</span>
            </li>
            <li id="info-btn" @click="openInfo">
              <span v-html="icons.ICON_INFO"></span>
              <span>关于项目</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- 播放模式 -->
      <button id="mode-btn" class="control-btn" :class="`mode-${currentModeName}`"
        :title="modeTitles[currentModeName]" @click="playerStore.cyclePlayMode()">
        <span v-html="icons.ICON_LIST_LOOP"></span>
        <span v-html="icons.ICON_SINGLE_LOOP"></span>
        <span v-html="icons.ICON_SHUFFLE"></span>
      </button>

      <button id="lyrics-btn" class="control-btn" title="显示/隐藏歌词"
        @click="uiStore.toggleLyricsPanel()">
        <span v-html="icons.ICON_LYRICS"></span>
      </button>
      <button id="fullscreen-btn" class="control-btn" title="全屏" @click="toggleFullscreen">
        <span v-html="icons.ICON_FULLSCREEN_ENTER"></span>
        <span v-html="icons.ICON_FULLSCREEN_EXIT"></span>
      </button>
      <button id="download-panel-btn" class="control-btn" title="添加资源"
        @click="uiStore.togglePanel('download')">
        <span v-html="icons.ICON_ADD"></span>
      </button>
      <button id="playlist-btn" class="control-btn" title="媒体库"
        @click="uiStore.togglePanel('playlist')">
        <span v-html="icons.ICON_PLAYLIST"></span>
      </button>

      <!-- 音量 -->
      <div class="volume-container">
        <button id="volume-btn" class="control-btn" :class="{ muted: isEffectivelyMuted }"
          title="静音" @click="toggleMute">
          <span v-html="icons.ICON_VOLUME"></span>
          <span v-html="icons.ICON_MUTE"></span>
        </button>
        <input type="range" id="volume-bar" class="volume-bar" min="0" max="1" step="0.01"
          :value="volumeBarValue" :style="{ '--value-percent': volumePercent + '%' }"
          @input="onVolumeChange">
      </div>
    </div>
  </footer>
</template>

<script setup>
import { computed } from 'vue';
import * as icons from '../../js/icons.js';
import { usePlayerStore } from '../../stores/playerStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { PLAY_MODES, DEFAULT_ART } from '../../js/config.js';
import { formatTime } from '../../js/utils.js';
import { NextTrackCommand, PrevTrackCommand } from '../../js/features/shortcuts.js';

const playerStore = usePlayerStore();
const uiStore = useUiStore();

const title = computed(() => playerStore.currentTrack?.title || '选择媒体');
const artist = computed(() => playerStore.currentTrack?.artist || '开始播放');
const albumArt = computed(() => playerStore.currentTrack?.albumArt || DEFAULT_ART);

const progressPercent = computed(() => {
  const { currentTime, duration } = playerStore;
  return duration > 0 ? (currentTime / duration) * 100 : 0;
});

const currentModeName = computed(() => PLAY_MODES[playerStore.currentModeIndex]);
const modeTitles = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };

const isEffectivelyMuted = computed(() => playerStore.isMuted || playerStore.volume === 0);
const volumeBarValue = computed(() => isEffectivelyMuted.value ? 0 : playerStore.volume);
const volumePercent = computed(() => isEffectivelyMuted.value ? 0 : playerStore.volume * 100);

function onProgressChange(e) {
  const duration = playerStore.duration;
  if (!isNaN(duration) && duration > 0) {
    window.dispatchEvent(new CustomEvent('seekTo', { detail: (e.target.value / 100) * duration }));
  }
  playerStore.setIsScrubbing(false);
}

function onVolumeChange(e) {
  const newVolume = parseFloat(e.target.value);
  playerStore.setVolume(newVolume);
  playerStore.setIsMuted(newVolume === 0);
}

function toggleMute() {
  playerStore.setIsMuted(!playerStore.isMuted);
}

function toggleFullscreen() {
  const mediaEl = document.getElementById('media-player');
  if (!document.fullscreenElement) mediaEl?.requestFullscreen().catch(console.error);
  else document.exitFullscreen();
}

function prevTrack() { new PrevTrackCommand().execute(); }
function nextTrack() { new NextTrackCommand().execute(); }

function openShortcut() {
  uiStore.togglePanel('shortcut');
  uiStore.isMoreOptionsMenuVisible = false;
}
function openSettings() {
  uiStore.togglePanel('settings');
  uiStore.isMoreOptionsMenuVisible = false;
}
function openInfo() {
  uiStore.togglePanel('info');
  uiStore.isMoreOptionsMenuVisible = false;
}
</script>
