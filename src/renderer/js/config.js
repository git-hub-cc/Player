// src/renderer/js/config.js

// 默认专辑封面
export const DEFAULT_ART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI0IzQjNCMyI+PHBhdGggZD0iTTEyIDNBOS45OSA5Ljk5IDAgMCAwIDIgMTJoLjAyYzAgNC45NyA0LjAzIDkgOC45OCA5czguOTgtNC4wMyA4Ljk4LTlBOS45OSA5Ljk5IDAgMCAwIDEyIDptMCAxNmMyLjYyIDAgNC43NS0yLjEyIDQuNzUtNC43NVMyMSAxMC42MyAyMSAxMGMwLTEuMDQtLjM1LTEuOTktLjkzLTIuNzlsLTYgNEMxMy40MyAxNy42NSA5LjUgMTYgOS41IDEyLjVDOS41IDguMzYgMTIuODYgNSA5LjUgNSBjLTEuOTggMC0zLjY5Ljg1LTQuNzggMi4yMkw2LjA4IDZDNy41IDQuMzQgOS42MiAzIDEyIDN6bS0uNS00YzEuMzggMCAyLjUtMS4xMiAyLjUtMi41UzEzLjg4IDUgMTIuNSA1IDcgNi4xMiA3IDcuNXMyLjEyIDIuNSAyLjUgMi41eiIvPjwvc3ZnPg==";

// 播放模式
export const PLAY_MODES = ['list', 'single', 'shuffle'];

// =========================================================================
// 【核心新增】媒体库过滤模式常量
// =========================================================================
export const FILTER_MODES = {
    ALL: 'all',    // 混合模式：显示所有
    AUDIO: 'audio',// 纯音乐模式：仅显示音频
    VIDEO: 'video' // 纯视频模式：仅显示视频
};
// =========================================================================

// =========================================================================
// 【快捷键配置】
// =========================================================================
export const defaultShortcuts = {
    'toggle-play': { label: '播放/暂停', keys: ['Space'] },
    'next-track': { label: '下一首', keys: ['Ctrl', '→'] },
    'prev-track': { label: '上一首', keys: ['Ctrl', '←'] },
    'seek-forward': { label: '快进', keys: ['→'] },
    'seek-backward': { label: '快退', keys: ['←'] },
    'volume-up': { label: '音量+', keys: ['↑'] },
    'volume-down': { label: '音量-', keys: ['↓'] },
    'speed-up': { label: '加速', keys: ['C'] },
    'speed-down': { label: '减速', keys: ['X'] },
    'speed-reset': { label: '重置倍速', keys: ['Z'] },
    // 旋转配置：Alt + 方向键
    'rotate-cw': { label: '向右旋转', keys: ['Alt', '→'] }, // 顺时针
    'rotate-ccw': { label: '向左旋转', keys: ['Alt', '←'] }, // 逆时针
    'toggle-mute': { label: '静音/取消', keys: ['M'] },
    'toggle-lyrics': { label: '切换歌词', keys: ['L'] },
    'toggle-playlist': { label: '切换播放列表', keys: ['P'] },
    // =========================================================================
    // 【核心新增】全屏切换快捷键配置
    // =========================================================================
    'toggle-fullscreen': { label: '全屏/退出', keys: ['Enter'] }
};