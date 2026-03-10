<template>
  <Teleport to="body">
    <Transition name="toast">
      <div v-if="uiStore.toast.visible" id="toast"
        class="toast"
        :class="['toast-' + uiStore.toast.type]"
        role="alert">
        {{ uiStore.toast.message }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
const uiStore = useUiStore();
</script>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(20px); }
</style>
