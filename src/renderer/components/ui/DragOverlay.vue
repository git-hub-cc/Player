<template>
  <div class="drag-overlay" :class="{ active: uiStore.isDragOverlayActive }">
    <div class="drag-overlay-content">
      <AppIcon name="drag-add" />
      <p>释放以添加到媒体库</p>
    </div>
  </div>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
import AppIcon from '../ui/AppIcon.vue';

// 拖拽激活状态由 uiStore.isDragOverlayActive 驱动，
// App.vue 的 setupDragAndDrop 通过 uiStore.setDragOverlayActive() 控制显示/隐藏。
const uiStore = useUiStore();
</script>
