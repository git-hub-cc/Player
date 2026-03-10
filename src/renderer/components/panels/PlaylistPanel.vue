<template>
  <aside id="playlist-panel" class="playlist-panel" :class="{ active: uiStore.activePanel === 'playlist' }">
    <div class="panel-header">
      <h2>媒体库</h2>
      <div class="panel-header-actions">
        <button id="locate-current-media-btn" class="control-btn" title="定位当前播放" @click="locateCurrent">
          <span v-html="icons.ICON_LOCATE"></span>
        </button>
        <button id="change-media-folder-btn" class="control-btn" title="修改媒体库目录" @click="changeFolder">
          <span v-html="icons.ICON_EDIT_FOLDER"></span>
        </button>
        <button id="open-media-folder-btn" class="control-btn" title="打开媒体库目录"
          @click="openMediaFolder">
          <span v-html="icons.ICON_FOLDER"></span>
        </button>
        <button class="control-btn" title="关闭" @click="uiStore.closeActivePanels()">
          <span v-html="icons.ICON_CLOSE"></span>
        </button>
      </div>
    </div>

    <!-- 过滤模式按钮 -->
    <div class="filter-mode-container">
      <button class="filter-mode-btn" :class="{ active: playerStore.mediaFilterMode === 'all' }"
        data-mode="all" title="混合模式：显示全部" @click="playerStore.setMediaFilterMode('all')">
        <span v-html="icons.ICON_FILTER_ALL"></span>
      </button>
      <button class="filter-mode-btn" :class="{ active: playerStore.mediaFilterMode === 'audio' }"
        data-mode="audio" title="音乐模式：仅显示音频" @click="playerStore.setMediaFilterMode('audio')">
        <span v-html="icons.ICON_FILTER_AUDIO"></span>
      </button>
      <button class="filter-mode-btn" :class="{ active: playerStore.mediaFilterMode === 'video' }"
        data-mode="video" title="视频模式：仅显示视频" @click="playerStore.setMediaFilterMode('video')">
        <span v-html="icons.ICON_FILTER_VIDEO"></span>
      </button>
    </div>

    <!-- 搜索 -->
    <div class="panel-search-container">
      <input type="search" id="playlist-search" class="panel-search"
        placeholder="搜索 (歌名/歌手/拼音/首字母)" v-model="searchQuery">
    </div>

    <!-- 播放列表：只渲染过滤后的条目，完全消除隐藏 DOM 节点 -->
    <ul id="playlist" class="playlist" ref="playlistEl"
      @click="onPlaylistClick" @contextmenu.prevent="onPlaylistContextMenu">
      <li v-for="item in filteredPlaylist" :key="item.track.src"
        class="playlist-item"
        :class="{
          active: item.originalIndex === playerStore.currentTrackIndex && !playerStore.temporaryPlayingTrack,
          'is-video': item.track.type === 'video',
          'playlist-item-highlight': item.originalIndex === highlightedIndex,
        }"
        :data-index="item.originalIndex">
        <div class="playlist-item-main-content">
          <div class="playlist-icon">{{ item.track.type === 'video' ? '🎬' : '🎵' }}</div>
          <div class="playlist-details">
            <div class="playlist-title">{{ item.track.title }}</div>
            <div class="playlist-artist">{{ item.track.artist }}</div>
          </div>
        </div>
        <div v-if="item.track.type === 'video'" class="video-progress-bar">
          <div class="video-progress-bar-inner"
            :style="{ width: videoProgress(item.track) + '%' }"></div>
        </div>
      </li>
      <li id="playlist-no-results" class="no-results-message"
        v-show="filteredPlaylist.length === 0">未找到结果</li>
    </ul>
  </aside>
</template>

<script setup>
import { ref, computed } from 'vue';
import * as icons from '../../js/icons.js';
import { usePlayerStore } from '../../stores/playerStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { useMediaService } from '../../composables/useMediaService.js';
import { FILTER_MODES } from '../../js/config.js';

const playerStore = usePlayerStore();
const uiStore = useUiStore();
const mediaService = useMediaService();
const playlistEl = ref(null);
const searchQuery = ref('');
/** 高亮动画正在进行的 originalIndex，-1 表示无 */
const highlightedIndex = ref(-1);

/**
 * 过滤后的播放列表。
 * 每项包含 { track, originalIndex }，v-for 只渲染匹配条目，
 * 彻底消除 CSS hidden DOM 节点。
 */
const filteredPlaylist = computed(() => {
  const mode = playerStore.mediaFilterMode;
  const query = searchQuery.value.toLowerCase().replace(/\s/g, '');

  return playerStore.playlist.reduce((acc, track, index) => {
    // 类型过滤
    if (mode === FILTER_MODES.AUDIO && track.type === 'video') return acc;
    if (mode === FILTER_MODES.VIDEO && track.type !== 'video') return acc;

    // 关键词过滤
    if (query) {
      const matched =
        (track.title || '').toLowerCase().includes(query) ||
        (track.artist || '').toLowerCase().includes(query) ||
        (track.pinyin || '').includes(query) ||
        (track.initials || '').includes(query);
      if (!matched) return acc;
    }

    acc.push({ track, originalIndex: index });
    return acc;
  }, []);
});

function videoProgress(track) {
  if (!track.totalDuration || track.totalDuration === 0) return 0;
  return Math.min(100, (track.lastPosition / track.totalDuration) * 100);
}

function onPlaylistClick(e) {
  const item = e.target.closest('.playlist-item[data-index]');
  if (!item) return;
  const newIndex = parseInt(item.dataset.index, 10);
  if (!isNaN(newIndex)) {
    playerStore.setCurrentTrackIndex(newIndex, true);
    playerStore.setIsPlaying(true);
  }
}

function onPlaylistContextMenu(e) {
  const item = e.target.closest('.playlist-item[data-index]');
  if (!item) return;
  const index = parseInt(item.dataset.index, 10);
  if (isNaN(index)) return;
  const track = playerStore.playlist[index];
  const items = [
    { label: '删除', action: 'delete-track', index },
    ...(track?.type === 'video' ? [{ label: '分离音视频', action: 'separate-video', index }] : []),
  ];
  const menuW = 150, menuH = items.length * 36;
  const x = e.clientX + menuW > window.innerWidth ? window.innerWidth - menuW - 5 : e.clientX;
  const y = e.clientY + menuH > window.innerHeight ? window.innerHeight - menuH - 5 : e.clientY;
  uiStore.showContextMenu({ x, y, items, context: { index } });
}

async function locateCurrent() {
  const index = playerStore.currentTrackIndex;
  if (index === -1) { uiStore.showToast('当前没有播放的内容', 'info'); return; }
  const track = playerStore.playlist[index];
  if (!track) return;

  const currentMode = playerStore.mediaFilterMode;
  let modeChanged = false;
  if (currentMode === FILTER_MODES.AUDIO && track.type === 'video') {
    playerStore.setMediaFilterMode(FILTER_MODES.ALL);
    uiStore.showToast('已切换至混合模式以定位视频', 'info');
    modeChanged = true;
  } else if (currentMode === FILTER_MODES.VIDEO && track.type !== 'video') {
    playerStore.setMediaFilterMode(FILTER_MODES.ALL);
    uiStore.showToast('已切换至混合模式以定位音频', 'info');
    modeChanged = true;
  }
  if (uiStore.activePanel !== 'playlist') uiStore.togglePanel('playlist');

  // 等待 DOM 更新（若切换了模式，给额外时间让列表重渲染）
  setTimeout(() => {
    const itemEl = playlistEl.value?.querySelector(`.playlist-item[data-index="${index}"]`);
    if (itemEl) {
      itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 通过 Vue 响应式状态驱动 CSS 类动画，不直接操作 style
      highlightedIndex.value = index;
      setTimeout(() => { highlightedIndex.value = -1; }, 1500);
    }
  }, modeChanged ? 100 : 0);
}

function openMediaFolder() {
  window.electronAPI.openMediaFolder(playerStore.mediaFilterMode);
}

async function changeFolder() {
  try {
    uiStore.showToast('正在修改媒体库目录...', 'info');
    const result = await window.electronAPI.changeMediaDirectory();
    if (result.canceled) { uiStore.showToast('已取消修改', 'info'); return; }
    if (result.success) {
      uiStore.showToast(result.message || '媒体库目录修改成功', 'success');
      await mediaService.loadInitialData();
    } else {
      uiStore.showToast(`修改失败: ${result.error}`, 'error');
    }
  } catch (err) {
    uiStore.showToast(`发生错误: ${err.message}`, 'error');
  }
}
</script>
