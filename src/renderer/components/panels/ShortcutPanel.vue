<template>
  <aside id="shortcut-panel" class="shortcut-panel" :class="{ active: uiStore.activePanel === 'shortcut' }">
    <div class="panel-header">
      <h2>快捷键设置</h2>
      <button class="control-btn" title="关闭" @click="uiStore.closeActivePanels()">
        <span v-html="icons.ICON_CLOSE"></span>
      </button>
    </div>
    <ul id="shortcut-list" class="shortcut-list">
      <li v-for="(setting, actionId) in playerStore.shortcutSettings" :key="actionId"
        class="shortcut-item" :data-action="actionId">
        <span class="action-label">{{ setting.label }}</span>
        <div class="shortcut-display">
          <template v-if="setting.keys && setting.keys.length > 0">
            <template v-for="(key, i) in setting.keys" :key="i">
              <kbd>{{ key }}</kbd>
              <span v-if="i < setting.keys.length - 1"> + </span>
            </template>
          </template>
          <span v-else class="placeholder">未设置</span>
        </div>
        <div class="actions">
          <button class="set-btn" @click="handleSet(actionId)">设置</button>
          <button class="clear-btn" @click="handleClear(actionId)">清除</button>
        </div>
      </li>
    </ul>
  </aside>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
import { usePlayerStore } from '../../stores/playerStore.js';
import { handleShortcutPanelAction } from '../../js/features/shortcuts.js';
import * as icons from '../../js/icons.js';

const uiStore = useUiStore();
const playerStore = usePlayerStore();

function handleSet(actionId) { handleShortcutPanelAction(actionId, 'set'); }
function handleClear(actionId) { handleShortcutPanelAction(actionId, 'clear'); }
</script>
