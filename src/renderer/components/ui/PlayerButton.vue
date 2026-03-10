<template>
  <button 
    class="action-btn"
    :class="[
      variant === 'secondary' ? 'secondary-btn' : '',
      variant === 'danger' ? 'danger-mode' : '',
      size === 'small' ? 'small-btn' : '',
      { loading: isLoading, 'full-width': fullWidth }
    ]"
    :disabled="disabled || isLoading"
    @click="$emit('click', $event)"
  >
    <span class="btn-text" v-if="$slots.default || text">
      <slot>{{ text }}</slot>
    </span>
    <span class="btn-loader" v-if="isLoading"></span>
  </button>
</template>

<script setup>
defineProps({
  text: {
    type: String,
    default: ''
  },
  variant: {
    type: String,
    default: 'primary',
    validator: (value) => ['primary', 'secondary', 'danger'].includes(value)
  },
  size: {
    type: String,
    default: 'medium',
    validator: (value) => ['medium', 'small'].includes(value)
  },
  isLoading: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  fullWidth: {
    type: Boolean,
    default: false
  }
});

defineEmits(['click']);
</script>

<style scoped>
/* Scoped styles can be added here if specific overrides are needed, 
   but base styles like .action-btn are already in panels.css / components.css */
</style>
