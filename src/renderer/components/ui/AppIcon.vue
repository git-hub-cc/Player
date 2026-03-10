<template>
  <span class="app-icon" v-html="iconSvg"></span>
</template>

<script setup>
import { computed } from 'vue';
import * as icons from '../../js/icons.js';

const props = defineProps({
  name: {
    type: String,
    required: true
  }
});

const iconSvg = computed(() => {
  // Convert name format from 'info' to 'ICON_INFO', 'edit-folder' to 'ICON_EDIT_FOLDER'
  const constantName = 'ICON_' + props.name.toUpperCase().replace(/-/g, '_');
  return icons[constantName] || '';
});
</script>

<style>
.app-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.app-icon svg {
  width: 1em;
  height: 1em;
  fill: currentColor;
}
</style>
