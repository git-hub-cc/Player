<template>
  <aside id="info-panel" class="info-panel" :class="{ active: uiStore.activePanel === 'info' }">
    <div class="panel-header">
      <h2>关于项目</h2>
      <button class="control-btn" title="关闭" @click="uiStore.closeActivePanels()">
        <AppIcon name="close" />
      </button>
    </div>
    <div class="info-content">
      <h3>项目地址</h3>
      <p>https://github.com/git-hub-cc/Player</p>
      <h3>设计灵感</h3>
      <p>本播放器的用户界面 (UI) 设计语言主要灵感来源于 Spotify 桌面客户端，旨在致敬其现代化、美观且用户友好的交互体验。</p>
      <h3>使用技巧</h3>
      <p><strong>沉浸模式：</strong>双击播放区域（封面或视频）可进入或退出全屏沉浸式视图。</p>
      <p><strong>快进/快退：</strong>短按方向键 <kbd>←</kbd> / <kbd>→</kbd> 可进行步进跳转，长按则可以倍速播放。</p>
      <h3>数据源致谢</h3>
      <p>本项目部分在线音乐搜索与播放功能基于 <strong>Meting</strong> 与 <strong>GD音乐台 (music.gdstudio.xyz)</strong> 提供的 API 实现。</p>
      <p>请尊重作者劳动成果。使用过程如遇问题，可 B 站私信：<strong>GD-Studio</strong>。</p>
      <h3>免责声明</h3>
      <p class="statement-title" style="color: #e91429;">重要提示:</p>
      <p><strong>本站资源来自网络，仅限本人学习参考，严禁下载、传播或商用，如侵权请与我联系删除。继续使用将视为同意本声明。</strong></p>
      <p>所有媒体内容的版权归原作者或其各自的版权所有者所有。</p>
    </div>
  </aside>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
import AppIcon from '../ui/AppIcon.vue';
const uiStore = useUiStore();
</script>
