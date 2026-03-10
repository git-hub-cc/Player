<template>
  <aside id="download-panel" class="download-panel" :class="{ active: uiStore.activePanel === 'download' }">
    <div class="panel-header">
      <h2>添加资源</h2>
      <button class="control-btn" title="关闭" @click="uiStore.closeActivePanels()">
        <AppIcon name="close" />
      </button>
    </div>
    <div id="download-panel-content" class="download-panel-content">
      <div id="downloader-view" class="downloader-view">
        <div class="downloader-input-area">
          <p class="panel-description">{{ description }}</p>
          <textarea id="url-or-search-input" v-model="inputText"
            placeholder="粘贴链接 或 输入歌曲/歌手名..."></textarea>
          <div id="download-actions-container" class="download-actions-container">
            <PlayerButton
              id="import-local-btn"
              :is-loading="isImporting"
              :disabled="isDownloading"
              @click="handleImport">
              导入本地资源
            </PlayerButton>
            <PlayerButton
              id="start-download-btn"
              v-show="isUrlMode"
              :is-loading="isDownloading"
              :disabled="isImporting"
              @click="handleDownload">
              {{ isDownloading ? '取消下载' : '开始下载' }}
            </PlayerButton>
            <PlayerButton
              id="search-online-btn"
              v-show="!isUrlMode"
              :is-loading="isSearching"
              @click="performSearch(inputText.trim(), 1)">
              搜索
            </PlayerButton>
          </div>
          <div id="download-status" class="download-status"
            :class="{ success: statusType === 'success', error: statusType === 'error' }"
            v-show="statusMessage">{{ statusMessage }}</div>
          <div class="download-progress-container" v-show="statusType === 'progress'">
            <div class="download-progress-bar" :style="{ width: progressWidth }"></div>
          </div>
        </div>
        <div id="search-results-container" class="search-results-container">
          <ul id="search-results-list" class="playlist" @click="onResultClick">
            <li v-for="(track, index) in searchResults" :key="track.originalSrc"
              class="playlist-item" :data-index="index" :data-src="track.originalSrc"
              :class="{ cached: isCached(track) }">
              <div class="playlist-item-main-content">
                <div class="playlist-icon">🎵</div>
                <div class="playlist-details">
                  <div class="playlist-title">{{ track.title }}</div>
                  <div class="playlist-artist">{{ track.artist }}</div>
                </div>
              </div>
              <button class="playlist-download-btn" :title="isCached(track) ? '已缓存' : '下载到本地'"
                :class="{ cached: isCached(track), downloading: isDownloadingTrack(track) }">
                <span v-html="icons.ICON_DOWNLOAD" class="download-icon-wrap"></span>
                <div class="spinner-icon-container">
                  <span v-html="icons.ICON_SPINNER"></span>
                  <span v-html="icons.ICON_STOP"></span>
                </div>
                <span v-html="icons.ICON_CACHED" class="cached-icon-wrap"></span>
              </button>
            </li>
          </ul>
          <div id="pagination-controls" class="pagination-controls" v-show="totalPages > 1">
            <button id="prev-page-btn" class="pagination-btn" title="上一页"
              :disabled="currentPage <= 1" @click="performSearch(currentQuery, currentPage - 1)">
              <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path></svg>
            </button>
            <span class="page-info">{{ currentPage }} / {{ totalPages }}</span>
            <button id="next-page-btn" class="pagination-btn" title="下一页"
              :disabled="currentPage >= totalPages" @click="performSearch(currentQuery, currentPage + 1)">
              <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useUiStore } from '../../stores/uiStore.js';
import { usePlayerStore } from '../../stores/playerStore.js';
import { useMediaService } from '../../composables/useMediaService.js';
import * as icons from '../../js/icons.js';
import AppIcon from '../ui/AppIcon.vue';
import PlayerButton from '../ui/PlayerButton.vue';

const uiStore = useUiStore();
const playerStore = usePlayerStore();
const { searchOnline, playTemporaryTrack, cacheTrack } = useMediaService();

const inputText = ref('');
const statusMessage = ref('');
const statusType = ref('default');
const progressWidth = ref('0%');
const isSearching = ref(false);
const isDownloading = ref(false);
const isImporting = ref(false);
const searchResults = ref([]);
const currentQuery = ref('');
const currentPage = ref(1);
const totalPages = ref(1);
const activeCacheDownloads = ref(new Set());

const ITEMS_PER_PAGE = 20;

const isUrlMode = computed(() => /https?:\/\//.test(inputText.value));

const description = computed(() => {
  const url = inputText.value.trim();
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return '检测到抖音链接，点击"开始下载"进行处理。';
  if (url.includes('jable.tv')) return '检测到Jable链接，点击"开始下载"进行处理。';
  if (/https?:\/\//.test(url)) return '检测到链接，将使用通用引擎处理 (支持B站/YouTube等)。';
  return '输入歌曲名进行在线搜索，或粘贴 某音/某B 链接进行本地下载。';
});

function isCached(track) {
  return playerStore.playlist.some(p => p.id === track.id && p.source === track.source);
}

function isDownloadingTrack(track) {
  return activeCacheDownloads.value.has(track.id);
}

function transformApiData(apiTrack) {
  return {
    id: apiTrack.id,
    title: apiTrack.name,
    artist: Array.isArray(apiTrack.artist) ? apiTrack.artist.join(' / ') : apiTrack.artist,
    album: apiTrack.album,
    pic_id: apiTrack.pic_id,
    lyric_id: apiTrack.lyric_id,
    url_id: apiTrack.url_id,
    source: apiTrack.source,
    type: 'audio',
    albumArt: '',
    originalSrc: `meting://${apiTrack.source}/${apiTrack.id}`
  };
}

async function performSearch(query, page = 1) {
  if (!query) { uiStore.showToast('请输入歌曲名或歌手名！', 'error'); return; }
  if (page === 1) searchResults.value = [];
  isSearching.value = true;
  statusMessage.value = `正在搜索 "${query}" (第 ${page} 页)...`;
  statusType.value = 'default';

  const data = await searchOnline(query, page);
  if (data) {
    const { results, total } = data;
    searchResults.value = results.map(transformApiData);
    currentQuery.value = query;
    currentPage.value = page;
    totalPages.value = Math.ceil(total / ITEMS_PER_PAGE) || 1;
    statusMessage.value = `搜索成功！显示 ${results.length} 首歌曲。`;
    statusType.value = 'success';
  } else {
    statusMessage.value = '搜索失败，请检查网络或稍后重试。';
    statusType.value = 'error';
  }
  isSearching.value = false;
}

async function handleImport() {
  isImporting.value = true;
  statusMessage.value = '等待选择资源目录...';
  statusType.value = 'default';
  try {
    const result = await window.electronAPI.selectImportDirectory();
    if (result.canceled) { statusMessage.value = '已取消导入操作。'; return; }
    statusMessage.value = '已选择目录，开始导入...';
    await window.electronAPI.startLocalImport(result.filePaths[0]);
  } catch (err) {
    uiStore.showToast(`导入出错: ${err.message}`, 'error');
  } finally {
    isImporting.value = false;
  }
}

function handleDownload() {
  if (isDownloading.value) {
    window.electronAPI.cancelDownload(null, 'url-download');
    return;
  }
  const url = inputText.value.trim().match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) { statusMessage.value = '请输入有效的URL。'; statusType.value = 'error'; return; }
  window.electronAPI.startDownload(url);
  isDownloading.value = true;
}

function onResultClick(e) {
  const item = e.target.closest('.playlist-item');
  if (!item) return;
  const track = searchResults.value[parseInt(item.dataset.index, 10)];
  if (!track) return;

  const downloadBtn = e.target.closest('.playlist-download-btn');
  if (downloadBtn && !isCached(track)) {
    e.stopPropagation();
    if (isDownloadingTrack(track)) {
      window.electronAPI.cancelDownload(track.id, 'cache-download');
      activeCacheDownloads.value.delete(track.id);
    } else {
      activeCacheDownloads.value.add(track.id);
      cacheTrack(track);
    }
  } else if (!downloadBtn) {
    playTemporaryTrack(track);
  }
}

// 监听下载/导入状态
if (window.electronAPI) {
  window.electronAPI.onDownloadStatus?.((status) => {
    statusMessage.value = status.message;
    statusType.value = status.type;
    if (status.type === 'progress' && typeof status.progress === 'number') {
      progressWidth.value = `${Math.min(100, status.progress * 100)}%`;
    } else {
      progressWidth.value = '0%';
    }
    if (status.type === 'success' || status.type === 'error') {
      isDownloading.value = false;
    }
  });
  window.electronAPI.onImportStatus?.((status) => {
    statusMessage.value = status.message;
    statusType.value = status.type;
    if (status.type === 'success' && status.importedCount > 0) {
      window.location.reload();
    }
  });
}

// 监听播放列表变化，更新缓存状态
watch(() => playerStore.playlist, () => {
  activeCacheDownloads.value.forEach(id => {
    const isCachedNow = playerStore.playlist.some(t => t.id === id);
    if (isCachedNow) activeCacheDownloads.value.delete(id);
  });
}, { deep: false });
</script>
