<template>
  <aside id="settings-panel" class="settings-panel" :class="{ active: uiStore.activePanel === 'settings' }">
    <div class="panel-header">
      <h2>系统设置</h2>
      <div class="panel-header-actions">
        <button class="control-btn" title="打开组件安装目录"
          @click="openToolsFolder">
          <span v-html="icons.ICON_FOLDER"></span>
        </button>
        <button class="control-btn" title="关闭" @click="uiStore.closeActivePanels()">
          <span v-html="icons.ICON_CLOSE"></span>
        </button>
      </div>
    </div>
    <div class="settings-content">
      <div class="settings-section">
        <h3 class="section-title">核心组件状态</h3>
        <p class="section-desc">部分下载和处理功能依赖以下工具。如果功能异常，请检查状态或尝试重新下载。</p>

        <div class="tool-card" id="ffmpeg-tool-card">
          <div class="tool-header">
            <div class="tool-info">
              <span class="tool-name">FFmpeg</span>
              <span class="tool-status-badge" :class="ffmpegStatus.exists ? 'installed' : 'missing'">
                {{ ffmpegStatus.exists ? '已就绪' : '未安装' }}
              </span>
            </div>
            <div class="tool-icon" v-html="ffmpegStatus.exists ? checkCircleIcon : alertCircleIcon"></div>
          </div>
          <div class="tool-path-container">
            <span class="tool-path" :title="ffmpegStatus.path">
              路径: {{ ffmpegStatus.path || '--' }}
            </span>
          </div>
          <div class="tool-actions">
            <PlayerButton
              variant="secondary"
              size="small"
              class="download-tool-btn"
              :is-loading="ffmpegDownloading"
              @click="downloadTool('ffmpeg', 'FFmpeg')">
              {{ ffmpegStatus.exists ? '重新下载 / 修复' : '立即下载' }}
            </PlayerButton>
          </div>
        </div>

        <div class="tool-card" id="ytdlp-tool-card">
          <div class="tool-header">
            <div class="tool-info">
              <span class="tool-name">yt-dlp</span>
              <span class="tool-status-badge" :class="ytdlpStatus.exists ? 'installed' : 'missing'">
                {{ ytdlpStatus.exists ? '已就绪' : '未安装' }}
              </span>
            </div>
            <div class="tool-icon" v-html="ytdlpStatus.exists ? checkCircleIcon : alertCircleIcon"></div>
          </div>
          <div class="tool-path-container">
            <span class="tool-path" :title="ytdlpStatus.path">
              路径: {{ ytdlpStatus.path || '--' }}
            </span>
          </div>
          <div class="tool-actions">
            <PlayerButton
              variant="secondary"
              size="small"
              class="download-tool-btn"
              :is-loading="ytdlpDownloading"
              @click="downloadTool('yt-dlp', 'yt-dlp')">
              {{ ytdlpStatus.exists ? '重新下载 / 修复' : '立即下载' }}
            </PlayerButton>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useUiStore } from '../../stores/uiStore.js';
import { ICON_CHECK_CIRCLE, ICON_ALERT_CIRCLE } from '../../js/icons.js';
import * as icons from '../../js/icons.js';
import PlayerButton from '../ui/PlayerButton.vue';

const uiStore = useUiStore();
const checkCircleIcon = ICON_CHECK_CIRCLE;
const alertCircleIcon = ICON_ALERT_CIRCLE;

const ffmpegStatus = ref({ exists: false, path: '' });
const ytdlpStatus = ref({ exists: false, path: '' });
const ffmpegDownloading = ref(false);
const ytdlpDownloading = ref(false);

function openToolsFolder() {
  window.electronAPI.openToolsFolder();
}

async function refreshToolStatus() {
  try {
    const status = await window.electronAPI.checkCoreTools();
    ffmpegStatus.value = status.ffmpeg || { exists: false, path: '' };
    ytdlpStatus.value = status.ytDlp || { exists: false, path: '' };
  } catch {
    uiStore.showToast('无法获取组件状态', 'error');
  }
}

async function downloadTool(toolName, displayName) {
  const isFF = toolName === 'ffmpeg';
  if (isFF) ffmpegDownloading.value = true;
  else ytdlpDownloading.value = true;
  uiStore.showToast(`开始下载 ${displayName}...`, 'info');
  try {
    const result = await window.electronAPI.downloadCoreTool(toolName);
    if (result.success) {
      uiStore.showToast(`${displayName} 下载安装成功！`, 'success');
      refreshToolStatus();
    } else {
      uiStore.showToast(`下载失败: ${result.error}`, 'error');
    }
  } catch (err) {
    uiStore.showToast(`操作异常: ${err.message}`, 'error');
  } finally {
    if (isFF) ffmpegDownloading.value = false;
    else ytdlpDownloading.value = false;
  }
}

// 当设置面板打开时刷新工具状态
watch(() => uiStore.activePanel, (panel) => {
  if (panel === 'settings') refreshToolStatus();
});
</script>
