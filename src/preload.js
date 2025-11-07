const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- 异步调用 (请求 -> 响应) ---
    getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
    // =========================================================================
    // 【修改】searchOnline 现在接受 query 和 page 两个参数
    // =========================================================================
    searchOnline: (query, page) => ipcRenderer.invoke('search-online', { query, page }),
    // =========================================================================
    deleteTrack: (trackData) => ipcRenderer.invoke('delete-track', trackData),
    getMusicUrl: (trackInfo) => ipcRenderer.invoke('get-music-url', trackInfo),
    getLrcContent: (relativePath) => ipcRenderer.invoke('get-lrc-content', relativePath),

    // --- 单向调用 (仅发送) ---
    startDownload: (requestData) => ipcRenderer.send('download-douyin', requestData),
    cacheTrack: (trackData) => ipcRenderer.send('cache-track', trackData),

    // --- 监听主进程的回调 ---
    onDownloadStatus: (callback) => {
        ipcRenderer.on('download-status', (event, ...args) => callback(...args));
        // 返回一个取消监听的函数，以便组件卸载时清理
        return () => ipcRenderer.removeAllListeners('download-status');
    },
    onNewTrack: (callback) => {
        ipcRenderer.on('new-track-added', (event, ...args) => callback(...args));
        return () => ipcRenderer.removeAllListeners('new-track-added');
    },
});