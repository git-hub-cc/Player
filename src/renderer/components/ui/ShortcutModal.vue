<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="uiStore.shortcutModal.visible"
        id="shortcut-modal-overlay"
        class="modal-overlay shortcut-modal-overlay"
        @click.self="uiStore.hideShortcutModal()">
        <div class="modal-content shortcut-modal-content">
          <h3>正在录制快捷键</h3>
          <p>请按下您想要设置的按键组合...</p>
          <div id="shortcut-key-preview" class="shortcut-key-preview key-displaying">
            <span v-if="!uiStore.shortcutModal.keyPreview" class="placeholder">等待输入...</span>
            <template v-else>
              <template v-for="(key, i) in previewKeys" :key="i">
                <kbd>{{ key }}</kbd>
                <span v-if="i < previewKeys.length - 1"> + </span>
              </template>
            </template>
          </div>
          <p style="margin-top: 12px; color: var(--text-secondary); font-size:0.85rem;">
            松开按键以确认。按 Esc 取消。
          </p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue';
import { useUiStore } from '../../stores/uiStore.js';
const uiStore = useUiStore();
const previewKeys = computed(() =>
  uiStore.shortcutModal.keyPreview ? uiStore.shortcutModal.keyPreview.split(' + ') : []
);
</script>
