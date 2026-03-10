<template>
  <div class="container" ref="appRootRef">
    <!-- 背景画廊 -->
    <Gallery ref="galleryRef" />

    <!-- 窗口拖拽手柄 -->
    <div id="window-drag-handle" title="按住拖动窗口">
      <svg viewBox="0 0 24 24">
        <path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z" />
      </svg>
    </div>

    <!-- 主播放区域 -->
    <div class="player-container" :class="playerContainerClass" ref="playerContainerRef">
      <!-- 拖拽覆盖层 -->
      <DragOverlay ref="dragOverlayRef" />

      <!-- 主内容区 -->
      <main class="main-view" ref="mainViewRef" :class="{ 'main-view-fullscreen': uiStore.isMainViewFullscreen }"
        @dblclick="onMainViewDblClick">
        <div class="media-visualizer">
          <!-- 视频元素 -->
          <video id="media-player" ref="mediaPlayerRef" playsinline crossorigin="anonymous"
            :style="{ display: isVideoMode ? 'block' : 'none' }"></video>
          <!-- 音频可视化 canvas -->
          <canvas id="audio-visualizer" ref="audioVisualizerRef"
            :style="{ display: isVideoMode ? 'none' : 'block' }"></canvas>
          <!-- 专辑封面 -->
          <div class="album-art-container" ref="albumArtContainerRef"
            :style="{ display: isVideoMode ? 'none' : 'flex' }">
            <img id="album-art" ref="albumArtRef" :src="currentAlbumArt" alt="Album Art"
              crossorigin="anonymous" draggable="false">
          </div>
        </div>

        <!-- 空状态 -->
        <div id="empty-state-view" class="empty-state-view" v-show="uiStore.showEmptyState">
          <div class="empty-content">
            <div class="empty-icon"><img src="./assets/app.svg"></div>
            <h1>欢迎使用 Player</h1>
            <p>暂无播放内容</p>
            <div class="empty-actions">
              <button id="empty-state-search-btn" class="action-btn" @click.stop="openDownloadPanel">
                开启您的音乐之旅
              </button>
            </div>
          </div>
        </div>

        <!-- 歌词 -->
        <Lyrics />

        <!-- 快进/倍速反馈 -->
        <div id="seek-feedback" class="seek-feedback"
          :class="{ visible: uiStore.seekFeedback.visible }">{{ uiStore.seekFeedback.text }}</div>
        <div id="speed-feedback" class="speed-feedback"
          :class="{ visible: uiStore.speedFeedback.visible }">{{ uiStore.speedFeedback.text }}</div>
      </main>

      <!-- 侧边面板 -->
      <PlaylistPanel />
      <InfoPanel />
      <ShortcutPanel />
      <DownloadPanel />
      <SettingsPanel />

      <!-- 播放控制栏 -->
      <PlayerControls />

      <!-- 右键菜单 -->
      <ContextMenu />

      <!-- 模态框 -->
      <ShortcutModal />
      <ConfirmModal />
    </div>

    <!-- Toast 通知 -->
    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { usePlayerStore } from './stores/playerStore.js';
import { useUiStore } from './stores/uiStore.js';
import { DEFAULT_ART, FILTER_MODES } from './js/config.js';

// 布局组件
import PlayerControls from './components/layout/PlayerControls.vue';
// 面板组件
import PlaylistPanel from './components/panels/PlaylistPanel.vue';
import InfoPanel from './components/panels/InfoPanel.vue';
import ShortcutPanel from './components/panels/ShortcutPanel.vue';
import DownloadPanel from './components/panels/DownloadPanel.vue';
import SettingsPanel from './components/panels/SettingsPanel.vue';
// 播放器组件
import Lyrics from './components/player/Lyrics.vue';
// 画廊
import Gallery from './components/gallery/Gallery.vue';
// UI 组件
import Toast from './components/ui/Toast.vue';
import ContextMenu from './components/ui/ContextMenu.vue';
import ShortcutModal from './components/ui/ShortcutModal.vue';
import ConfirmModal from './components/ui/ConfirmModal.vue';
import DragOverlay from './components/ui/DragOverlay.vue';

// Composables
import { usePlayer, cleanupPlayer } from './composables/usePlayer.js';
import { useVisuals } from './composables/useVisuals.js';
import { useGallery, cleanupGallery } from './composables/useGallery.js';
import { useMediaService } from './composables/useMediaService.js';
import { loadShortcuts, setupShortcutListeners } from './js/features/shortcuts.js';

// Stores
const playerStore = usePlayerStore();
const uiStore = useUiStore();

// Template refs
const appRootRef = ref(null);
const mediaPlayerRef = ref(null);
const audioVisualizerRef = ref(null);
const albumArtRef = ref(null);
const albumArtContainerRef = ref(null); // 替代 document.getElementById('album-art-container')
const mainViewRef = ref(null);
const playerContainerRef = ref(null);
const galleryRef = ref(null);

// 离屏 canvas（用于颜色提取）
const bgCanvas = document.createElement('canvas');
const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });

const PLAYER_STATE_KEY = 'player_state';

// Computed
const isVideoMode = computed(() => playerStore.currentTrack?.type === 'video');
const currentAlbumArt = computed(() => playerStore.currentTrack?.albumArt || DEFAULT_ART);
const playerContainerClass = computed(() => ({
  'video-mode': isVideoMode.value,
}));

// Methods
function openDownloadPanel() {
  uiStore.togglePanel('download');
}

function onMainViewDblClick() {
  if (document.fullscreenElement || playerStore.isScreensaverMode) return;
  uiStore.toggleMainViewFullscreen();
  if (uiStore.isMainViewFullscreen) uiStore.closeActivePanels();
}

function savePlayerState() {
  const currentPlaylist = playerStore.playlist;
  if (currentPlaylist.length === 0) {
    localStorage.removeItem(PLAYER_STATE_KEY);
    return;
  }
  try {
    const stateToSave = {
      trackIndex: playerStore.currentTrackIndex,
      currentTime: playerStore.currentTime,
      volume: playerStore.volume,
      muted: playerStore.isMuted,
      modeIndex: playerStore.currentModeIndex,
      playbackRate: playerStore.playbackRate,
      mediaFilterMode: playerStore.mediaFilterMode,
      videoProgress: currentPlaylist
        .filter(t => t.type === 'video' && t.totalDuration > 0)
        .map(t => ({ src: t.src.replace('media://', ''), lastPosition: t.lastPosition, totalDuration: t.totalDuration })),
    };
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(stateToSave));
  } catch (e) {
    console.error('Failed to save player state:', e);
  }
}

function loadPlayerState() {
  const savedState = localStorage.getItem(PLAYER_STATE_KEY);
  let initialTime = 0;
  if (savedState) {
    try {
      const parsedState = JSON.parse(savedState);
      playerStore.setCurrentTrackIndex(parsedState.trackIndex || 0);
      playerStore.setCurrentModeIndex(parsedState.modeIndex || 0);
      playerStore.setVolume(parsedState.volume ?? 1.0);
      playerStore.setIsMuted(parsedState.muted ?? false);
      playerStore.setPlaybackRate(parsedState.playbackRate || 1.0);
      if (parsedState.mediaFilterMode && Object.values(FILTER_MODES).includes(parsedState.mediaFilterMode)) {
        playerStore.setMediaFilterMode(parsedState.mediaFilterMode);
      }
      initialTime = parsedState.currentTime || 0;
      if (parsedState.videoProgress) {
        window._videoProgressCache = new Map(
          parsedState.videoProgress.map(p => [p.src, { lastPosition: p.lastPosition, totalDuration: p.totalDuration }])
        );
      }
    } catch (e) {
      localStorage.removeItem(PLAYER_STATE_KEY);
    }
  }
  return initialTime;
}

// --- 事件监听 handlers（保存引用，用于 onUnmounted 清理）---
let _keydownHandler = null;

function setupDragAndDrop() {
  window.addEventListener('dragover', e => e.preventDefault(), false);
  window.addEventListener('drop', e => e.preventDefault(), false);
  let dragCounter = 0;

  const onDragEnter = () => {
    dragCounter++;
    uiStore.setDragOverlayActive(true);
  };
  const onDragLeave = () => {
    dragCounter--;
    if (dragCounter === 0) uiStore.setDragOverlayActive(false);
  };
  const onDrop = async (e) => {
    dragCounter = 0;
    uiStore.setDragOverlayActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      try {
        uiStore.showToast(`已开始处理 ${files.length} 个文件...`, 'info');
        await window.electronAPI.handleFileDrop(files);
      } catch (err) {
        uiStore.showToast(`文件处理失败: ${err.message}`, 'error');
      }
    }
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  // 返回清理函数
  return () => {
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  };
}

function setupGlobalShortcuts() {
  _keydownHandler = (e) => {
    if (e.key === 'Escape') {
      uiStore.hideContextMenu();
      uiStore.closeActivePanels();
      if (playerStore.isScreensaverMode) {
        playerStore.setScreensaverMode(false);
        window.electronAPI.toggleFullscreen(false);
      }
    }
    if (e.key === 'F11') {
      e.preventDefault();
      if (playerStore.isScreensaverMode) {
        playerStore.setScreensaverMode(false);
        window.electronAPI.toggleFullscreen(false);
      } else if (playerStore.playlist.length > 0) {
        playerStore.setScreensaverMode(true);
        window.electronAPI.toggleFullscreen(true);
      }
    }
  };
  window.addEventListener('keydown', _keydownHandler);
}


// 清理函数集合
let _cleanupDragAndDrop = null;
const _beforeUnloadHandler = () => savePlayerState();
const _showToastHandler = (e) => {
  if (e.detail?.message) uiStore.showToast(e.detail.message, e.detail.type);
};

onMounted(async () => {
  await nextTick();

  const mediaEl = mediaPlayerRef.value;

  // 初始化播放器
  usePlayer(mediaEl);

  // 初始化视觉效果（使用 Vue ref 替代 document.getElementById）
  useVisuals({
    canvasEl: audioVisualizerRef.value,
    albumArtEl: albumArtRef.value,
    bgCanvas,
    bgCtx,
    mainViewEl: mainViewRef.value,
    mediaEl,
    albumArtContainerEl: albumArtContainerRef.value, // ✅ Vue ref，替代 getElementById
  });

  // 初始化画廊（使用 Gallery 组件暴露的 ref，替代 getElementById）
  useGallery({
    galleryContainer: galleryRef.value?.galleryContainerRef,
    galleryWrapper: galleryRef.value?.galleryWrapperRef,
    playerContainer: playerContainerRef.value,
    bgCanvas,
    bgCtx,
  });

  // 媒体服务
  const mediaService = useMediaService();
  mediaService.init();

  // 快捷键
  loadShortcuts();
  setupShortcutListeners();

  // 拖拽（保存清理函数）
  _cleanupDragAndDrop = setupDragAndDrop();

  // 全局键盘事件（保存 handler 引用）
  setupGlobalShortcuts();


  // Electron API 监听
  window.electronAPI.onOpenFile((filePath) => {
    mediaService.playFileFromPath(filePath);
  });

  window.electronAPI.onFullscreenChange((isFullscreen) => {
    if (!isFullscreen && playerStore.isScreensaverMode) {
      playerStore.setScreensaverMode(false);
    }
  });

  // 加载持久化状态
  const initialTime = loadPlayerState();

  // 加载媒体库
  await mediaService.loadInitialData();

  // 合并视频进度缓存
  if (window._videoProgressCache) {
    const playlist = playerStore.playlist;
    playlist.forEach(track => {
      const progressData = window._videoProgressCache.get(track.src.replace('media://', ''));
      if (progressData) {
        track.lastPosition = progressData.lastPosition;
        track.totalDuration = progressData.totalDuration;
      }
    });
    playerStore.setPlaylist([...playlist]);
    delete window._videoProgressCache;
  }

  // 恢复播放状态
  const playlist = playerStore.playlist;
  if (playlist.length > 0) {
    let trackIndex = playerStore.currentTrackIndex;
    if (trackIndex >= playlist.length || trackIndex < 0) trackIndex = 0;
    setTimeout(() => {
      if (!playerStore.temporaryPlayingTrack) {
        playerStore.setCurrentTrackIndex(trackIndex, true);
      }
      if (initialTime > 0) {
        const unwatch = playerStore.$subscribe((mutation, state) => {
          if (state.duration > 0 && !playerStore.temporaryPlayingTrack) {
            window.dispatchEvent(new CustomEvent('seekTo', { detail: initialTime }));
            unwatch();
          }
        });
      }
    }, 0);
  } else {
    uiStore.toggleEmptyState(true);
    if (!playerStore.temporaryPlayingTrack) {
      setTimeout(() => uiStore.togglePanel('download'), 600);
    }
  }

  // 页面卸载和全局 Toast 事件（保存 handler 引用）
  window.addEventListener('beforeunload', _beforeUnloadHandler);
  window.addEventListener('showToast', _showToastHandler);

  console.log('Vue App initialized.');
});

onUnmounted(() => {
  // 清理所有全局事件监听，防止内存泄漏
  if (_keydownHandler) window.removeEventListener('keydown', _keydownHandler);
  if (_cleanupDragAndDrop) _cleanupDragAndDrop();
  window.removeEventListener('beforeunload', _beforeUnloadHandler);
  window.removeEventListener('showToast', _showToastHandler);

  // 清理 composable 内部的全局监听
  cleanupPlayer();
  cleanupGallery();
});
</script>
