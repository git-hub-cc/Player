// js/config.js

// 默认专辑封面
export const DEFAULT_ART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI0IzQjNCMyI+PHBhdGggZD0iTTEyIDNBOS45OSA5Ljk5IDAgMCAwIDIgMTJoLjAyYzAgNC45NyA0LjAzIDkgOC45OCA5czguOTgtNC4wMyA4Ljk4LTlBOS45OSA5Ljk5IDAgMCAwIDEyIDptMCAxNmMyLjYyIDAgNC43NS0yLjEyIDQuNzUtNC43NVMyMSAxMC42MyAyMSAxMGMwLTEuMDQtLjM1LTEuOTktLjkzLTIuNzlsLTYgNEMxMy40MyAxNy42NSA5LjUgMTYgOS41IDEyLjVDOS41IDguMzYgMTIuODYgNSA5LjUgNSBjLTEuOTggMC0zLjY5Ljg1LTQuNzggMi4yMkw2LjA4IDZDNy41IDQuMzQgOS42MiAzIDEyIDN6bS0uNS00YzEuMzggMCAyLjUtMS4xMiAyLjUtMi41UzEzLjg4IDUgMTIuNSA1IDcgNi4xMiA3IDcuNXMyLjEyIDIuNSAyLjUgMi41eiIvPjwvc3ZnPg==";

// 播放模式
export const PLAY_MODES = ['list', 'single', 'shuffle'];

// =========================================================================
// 【核心修改】更新默认快捷键配置
// 1. 将 "上一首/下一首" 从方向键解绑，改为更合适的组合键或功能键。
// 2. 新增 "快进/快退" 动作，并绑定到左右方向键。
// =========================================================================
export const defaultShortcuts = {
    'toggle-play': { label: '播放/暂停', keys: ['Space'] },
    'next-track': { label: '下一首', keys: ['Ctrl', '→'] }, // 修改为 Ctrl + →
    'prev-track': { label: '上一首', keys: ['Ctrl', '←'] }, // 修改为 Ctrl + ←
    'seek-forward': { label: '快进', keys: ['→'] },         // 新增快进行为
    'seek-backward': { label: '快退', keys: ['←'] },       // 新增快退行为
    'volume-up': { label: '音量+', keys: ['↑'] },
    'volume-down': { label: '音量-', keys: ['↓'] },
    'toggle-mute': { label: '静音/取消', keys: ['M'] },
    'toggle-lyrics': { label: '切换歌词', keys: ['L'] },
    'toggle-playlist': { label: '切换播放列表', keys: ['P'] }
};
// =========================================================================