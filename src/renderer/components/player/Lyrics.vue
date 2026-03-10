<template>
  <div id="lyrics-container" class="lyrics-container" :class="{ active: uiStore.isLyricsVisible }">
    <div id="lyrics-list-wrapper" @mousedown="onLyricsDragStart" ref="lyricsWrapperEl" @wheel="onLyricsWheel">
      <!-- Drag Indicator -->
      <div class="lyrics-drag-indicator" :class="{ active: isDragging }">
        <div class="lyrics-drag-line"></div>
        <div class="lyrics-drag-time">{{ formattedDragTime }}</div>
      </div>

      <div class="lyrics-list" :class="{ dragging: isDragging }" :style="{ transform: `translateY(${translateY}px)` }" ref="lyricsContentEl">
        <div v-if="!hasLyrics" class="no-lyrics">
          {{ playerStore.currentTrack ? '暂无歌词' : '' }}
        </div>
        <p v-for="(line, index) in playerStore.parsedLyrics" :key="index"
          :class="{ active: index === activeLyricIndex }"
          :ref="el => { if (el) lyricLineRefs[index] = el }"
          @click="seekToLine(line.time)">
          {{ line.text || '...' }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { usePlayerStore } from '../../stores/playerStore.js';
import { useUiStore } from '../../stores/uiStore.js';

const playerStore = usePlayerStore();
const uiStore = useUiStore();
const lyricsWrapperEl = ref(null);
const lyricsContentEl = ref(null);
const lyricLineRefs = ref([]);
let userScrolledAt = 0;
const USER_SCROLL_LOCK_MS = 3000;

const translateY = ref(0);
const isDragging = ref(false);
const dragTime = ref(0);
let dragStartY = 0;
let initialTranslateY = 0;
let wasPlayingBeforeDrag = false;

const formattedDragTime = computed(() => {
  const time = dragTime.value;
  const mins = Math.floor(time / 60);
  const secs = Math.floor(time % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
});

const hasLyrics = computed(() => playerStore.parsedLyrics.length > 0);

const activeLyricIndex = computed(() => {
  const lyrics = playerStore.parsedLyrics;
  const currentTime = playerStore.currentTime;
  if (!lyrics.length) return -1;
  let activeIndex = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].time <= currentTime) activeIndex = i;
    else break;
  }
  return activeIndex;
});

watch(activeLyricIndex, (newIndex) => {
  if (newIndex < 0 || isDragging.value || playerStore.isDraggingLyrics) return;
  const timeSinceScroll = Date.now() - userScrolledAt;
  if (timeSinceScroll < USER_SCROLL_LOCK_MS) return;
  syncLyricsPosition(newIndex);
});

function syncLyricsPosition(index) {
  nextTick(() => {
    const el = lyricLineRefs.value[index];
    if (el && lyricsWrapperEl.value) {
      const wrapperH = lyricsWrapperEl.value.clientHeight;
      const elTop = el.offsetTop;
      const elH = el.offsetHeight;
      translateY.value = wrapperH / 2 - elTop - elH / 2;
    }
  });
}

// 当 parsedLyrics 变化时重置 refs 数组和位置
watch(() => playerStore.parsedLyrics, () => {
  lyricLineRefs.value = [];
  translateY.value = 0;
  userScrolledAt = 0;
});

// 处理全屏等引起的 UI 变化，导致 offsetTop 可能会改变
watch(() => uiStore.isLyricsVisible, (visible) => {
  if (visible && activeLyricIndex.value >= 0) {
    syncLyricsPosition(activeLyricIndex.value);
  }
});

function seekToLine(time) {
  if (!isNaN(time) && !isDragging.value) {
    userScrolledAt = 0; // 重置用户滚动锁定
    window.dispatchEvent(new CustomEvent('seekTo', { detail: time }));
    playerStore.setIsPlaying(true);
  }
}

function onLyricsWheel(e) {
  if (isDragging.value) return;
  userScrolledAt = Date.now();
  // 简易手动滚动效果，避免滚轮时被锁定
  translateY.value -= e.deltaY * 0.5;
}

// --- 拖拽交互 ---
function onLyricsDragStart(e) {
  if (!hasLyrics.value || e.button !== 0) return;
  // 忽略对歌词段落的直接点击，保留 seekTo 行为，但通过 e.target 判断可能有点复杂，统一处理 mousedown。
  // 注意，如果我们在此处 preventDefault，可能会阻止 click 事件触发 seekToLine，所以需要小心。
  // 我们只在拖拽确实发生时（mousemove）标记状态，但我们需要记录其实点。
  
  // 为了不影响 click (seekToLine)，我们不在 mousedown 阻止默认事件，除非真的开拖。
  dragStartY = e.clientY;
  initialTranslateY = translateY.value;

  window.addEventListener('mousemove', onLyricsDragMove);
  window.addEventListener('mouseup', onLyricsDragEnd, { once: true });
}

function onLyricsDragMove(e) {
  // 如果移动距离过小，则不认为是拖拽（防抖）
  if (!isDragging.value && Math.abs(e.clientY - dragStartY) > 5) {
    isDragging.value = true;
    playerStore.setIsDraggingLyrics(true);
    wasPlayingBeforeDrag = playerStore.isPlaying;
    if (wasPlayingBeforeDrag) playerStore.setIsPlaying(false);
  }

  if (!isDragging.value) return;
  e.preventDefault();

  translateY.value = initialTranslateY + e.clientY - dragStartY;

  // 寻找离中心线最近的歌词
  if (!lyricsWrapperEl.value) return;
  const centerLineY = lyricsWrapperEl.value.getBoundingClientRect().top + lyricsWrapperEl.value.clientHeight / 2;
  
  let closestIndex = -1;
  let minDistance = Infinity;

  lyricLineRefs.value.forEach((el, index) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const distance = Math.abs((rect.top + rect.height / 2) - centerLineY);
    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = index;
    }
  });

  if (closestIndex !== -1 && playerStore.parsedLyrics[closestIndex]) {
    dragTime.value = playerStore.parsedLyrics[closestIndex].time;
  }
}

function onLyricsDragEnd(e) {
  window.removeEventListener('mousemove', onLyricsDragMove);
  
  if (!isDragging.value) {
    // 仅仅是点击
    return;
  }
  
  e.preventDefault();

  isDragging.value = false;
  playerStore.setIsDraggingLyrics(false);

  if (dragTime.value >= 0) {
    userScrolledAt = 0; // 重置
    window.dispatchEvent(new CustomEvent('seekTo', { detail: dragTime.value }));
  }
  
  if (wasPlayingBeforeDrag) {
    playerStore.setIsPlaying(true);
  }
}

onUnmounted(() => {
  window.removeEventListener('mousemove', onLyricsDragMove);
  window.removeEventListener('mouseup', onLyricsDragEnd);
});
</script>
