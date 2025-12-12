// src/preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- 异步调用 (请求 -> 响应) ---
    getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
    searchOnline: (query, page) => ipcRenderer.invoke('search-online', { query, page }),
    deleteTrack: (trackData) => ipcRenderer.invoke('delete-track', trackData),
    getMusicUrl: (trackInfo) => ipcRenderer.invoke('get-music-url', trackInfo),
    getLrcContent: (relativePath) => ipcRenderer.invoke('get-lrc-content', relativePath),
    selectImportDirectory: () => ipcRenderer.invoke('select-import-directory'),
    startLocalImport: (dirPath) => ipcRenderer.invoke('start-local-import', dirPath),

    // --- 单向调用 (仅发送) ---
    startDownload: (requestData) => ipcRenderer.send('download-douyin', requestData),
    cacheTrack: (trackData) => ipcRenderer.send('cache-track', trackData),
    toggleFullscreen: (state) => ipcRenderer.send('toggle-fullscreen', state),
    openMediaFolder: () => ipcRenderer.send('open-media-folder'),

    // --- 监听主进程的回调 ---
    onDownloadStatus: (callback) => {
        ipcRenderer.on('download-status', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('download-status');
    },
    onNewTrack: (callback) => {
        ipcRenderer.on('new-track-added', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('new-track-added');
    },
    onImportStatus: (callback) => {
        ipcRenderer.on('import-status', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('import-status');
    },
    onFullscreenChange: (callback) => {
        ipcRenderer.on('fullscreen-change', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('fullscreen-change');
    },
    // =========================================================================
    // 【新增】监听核心组件下载状态的 API
    // =========================================================================
    onDownloadStarted: (callback) => {
        ipcRenderer.on('download-started', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('download-started');
    },
    onDownloadProgress: (callback) => {
        ipcRenderer.on('download-progress', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('download-progress');
    },
    onDownloadFinished: (callback) => {
        ipcRenderer.on('download-finished', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('download-finished');
    },
    // =========================================================================
});