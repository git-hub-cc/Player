<template>
  <div class="gallery-container" ref="galleryContainerRef">
    <div class="gallery-wrapper" ref="galleryWrapperRef"></div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

// Gallery 的实际渲染逻辑由 useGallery composable 在 App.vue 的 onMounted 中初始化。
// 此组件通过 defineExpose 将容器 ref 暴露给父级，以替代原来的 document.getElementById 查询。
const galleryContainerRef = ref(null);
const galleryWrapperRef = ref(null);

defineExpose({ galleryContainerRef, galleryWrapperRef });
</script>
