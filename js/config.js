// js/config.js

export const DEFAULT_ART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI0IzQjNCMyI+PHBhdGggZD0iTTEyIDNBOS45OSA5Ljk5IDAgMCAwIDIgMTJoLjAyYzAgNC45NyA0LjAzIDkgOC45OCA5czguOTgtNC4wMyA4Ljk4LTlBOS45OSA5Ljk5IDAgMCAwIDEyIDptMCAxNmMyLjYyIDAgNC43NS0yLjEyIDQuNzUtNC43NVMyMSAxMC42MyAyMSAxMGMwLTEuMDQtLjM1LTEuOTktLjkzLTIuNzlsLTYgNEMxMy40MyAxNy42NSA5LjUgMTYgOS41IDEyLjVDOS41IDguMzYgMTIuODYgNSA5LjUgNSBjLTEuOTggMC0zLjY5Ljg1LTQuNzggMi4yMkw2LjA4IDZDNy41IDQuMzQgOS42MiAzIDEyIDN6bS0uNS00YzEuMzggMCAyLjUtMS4xMiAyLjUtMi41UzEzLjg4IDUgMTIuNSA1IDcgNi4xMiA3IDcuNXMyLjEyIDIuNSAyLjUgMi41eiIvPjwvc3ZnPg==";

export const PLAY_MODES = ['list', 'single', 'shuffle'];

export const defaultShortcuts = {
    'toggle-play': { label: '播放/暂停', keys: ['Space'] },
    'next-track': { label: '下一首', keys: ['→'] },
    'prev-track': { label: '上一首', keys: ['←'] },
    'volume-up': { label: '音量+', keys: ['↑'] },
    'volume-down': { label: '音量-', keys: ['↓'] },
    'toggle-mute': { label: '静音/取消', keys: ['M'] },
    'toggle-lyrics': { label: '切换歌词', keys: ['L'] },
    'toggle-playlist': { label: '切换播放列表', keys: ['P'] }
};

export const desktopTourSteps = [
    { element: '#play-pause-btn', title: '主控制区', content: '点击这里可以播放或暂停当前媒体。您也可以使用快捷键。', position: 'top' },
    { element: '.progress-container', title: '播放进度', content: '这里显示播放进度，您可以拖动滑块来快进或快退。', position: 'top' },
    { element: '#shortcut-btn', title: '快捷键设置', content: '点击这里可以自定义控制播放器的键盘快捷键。', position: 'top' },
    { element: '#lyrics-btn', title: '同步歌词', content: '点击此按钮可以显示或隐藏同步歌词界面。', position: 'top' },
    { element: '#playlist-btn', title: '播放列表', content: '在这里查看和切换播放队列中的所有媒体。', position: 'top' },
    {
        element: '.container',
        title: '无限画廊',
        content: '在播放器外的任意空白区域按住并拖动，即可在音乐库的画廊中漫游，点击封面可直接播放。',
        position: 'top',
        isCustomDemo: 'gallery'
    },
    { element: '.track-info', title: '尽情享受吧！', content: '现在您可以开始使用了。所有功能都已介绍完毕。', position: 'top' }
];

export const mobileTourSteps = [
    { element: '#play-pause-btn', title: '主控制区', content: '点击这里可以播放或暂停当前媒体。', position: 'top' },
    { element: '.progress-container', title: '播放进度', content: '这里显示播放进度，您可以拖动滑块来快进或快退。', position: 'top' },
    { element: '#mobile-lyrics-btn', title: '同步歌词', content: '点击此按钮可以显示或隐藏同步歌词界面。', position: 'top' },
    { element: '#mobile-playlist-btn', title: '播放列表', content: '在这里查看和切换播放队列中的所有媒体。', position: 'top' },
    { element: '.main-controls', title: '尽情享受吧！', content: '现在您可以开始使用了。所有功能都已介绍完毕。', position: 'top' }
];