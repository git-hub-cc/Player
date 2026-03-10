<template>
  <Teleport to="body">
    <div v-if="uiStore.contextMenu.visible"
      id="context-menu"
      class="context-menu"
      :style="{ top: uiStore.contextMenu.y + 'px', left: uiStore.contextMenu.x + 'px' }"
      @click.stop>
      <ul>
        <li v-for="item in uiStore.contextMenu.items" :key="item.action"
          class="context-menu-item" @click="onItemClick(item)">
          {{ item.label }}
        </li>
      </ul>
    </div>
    <!-- 点击外部关闭 -->
    <div v-if="uiStore.contextMenu.visible" class="context-menu-backdrop"
      @click="uiStore.hideContextMenu()" @contextmenu.prevent="uiStore.hideContextMenu()"></div>
  </Teleport>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
import { useMediaService } from '../../composables/useMediaService.js';

const uiStore = useUiStore();
const mediaService = useMediaService();

async function onItemClick(item) {
  uiStore.hideContextMenu();
  const ctx = uiStore.contextMenu.context;
  if (item.action === 'delete-track') {
    await mediaService.deleteTrack(ctx.index);
  } else if (item.action === 'separate-video') {
    await mediaService.separateVideo(ctx.index);
  }
}
</script>

<style scoped>
.context-menu-backdrop {
  position: fixed; inset: 0; z-index: 998;
}

.context-menu {
  position: fixed;
  z-index: 4000;
  background-color: var(--panel-bg);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 6px;
  min-width: 180px;
  border: 1px solid var(--highlight-bg);
  backdrop-filter: blur(10px);
}

.context-menu ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.context-menu li {
  padding: 10px 15px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.context-menu li:hover {
  background-color: var(--highlight-bg);
  color: var(--text-primary);
}
</style>
