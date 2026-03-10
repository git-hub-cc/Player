<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="uiStore.confirmModal.visible"
        id="confirmation-modal-overlay"
        class="modal-overlay"
        @click.self="resolve(false)">
        <div class="modal-content">
          <p>{{ uiStore.confirmModal.message }}</p>
          <div class="modal-actions">
            <PlayerButton variant="secondary" @click="resolve(false)">取消</PlayerButton>
            <PlayerButton variant="danger" @click="resolve(true)">确定</PlayerButton>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { useUiStore } from '../../stores/uiStore.js';
import PlayerButton from './PlayerButton.vue';
const uiStore = useUiStore();
function resolve(result) {
  uiStore.resolveConfirm(result ? true : 'cancel');
}
</script>

<style scoped>
.modal-enter-active, .modal-leave-active { transition: opacity 0.2s ease; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
