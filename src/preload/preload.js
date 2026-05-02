// src/preload/preload.js

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- 异步调用 ---
    getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
    searchOnline: (query, page) => ipcRenderer.invoke('search-online', { query, page }),
    deleteTrack: (trackData) => ipcRenderer.invoke('delete-track', trackData),
    getMusicUrl: (trackInfo) => ipcRenderer.invoke('get-music-url', trackInfo),
    getVipMusicUrl: (trackInfo) => ipcRenderer.invoke('get-vip-music-url', trackInfo),
    getLrcContent: (relativePath) => ipcRenderer.invoke('get-lrc-content', relativePath),
    selectImportDirectory: () => ipcRenderer.invoke('select-import-directory'),
    startLocalImport: (dirPath, shouldCopy) => ipcRenderer.invoke('start-local-import', dirPath, shouldCopy),
    separateVideo: (trackData) => ipcRenderer.invoke('separate-video', trackData),
    getOnlineLyric: (trackInfo) => ipcRenderer.invoke('get-online-lyric', trackInfo),
    cleanupMissingTracks: () => ipcRenderer.invoke('cleanup-missing-tracks'),
    checkEnv: () => ipcRenderer.invoke('check-env'),

    // --- 核心工具 ---
    downloadCoreTool: (toolName) => ipcRenderer.invoke('download-core-tool', toolName),
    openToolsFolder: (targetPath) => ipcRenderer.invoke('open-tools-folder', targetPath),
    checkCoreTools: () => ipcRenderer.invoke('check-core-tools'),

    // --- 文件拖拽接口 ---
    handleFileDrop: (files, shouldCopy) => {
        if (!Array.isArray(files)) return Promise.resolve({ success: false, error: 'Preload Error: Invalid file list.' });
        try {
            const fileListPayload = files.map(file => ({
                name: file.name,
                path: webUtils.getPathForFile(file),
                type: file.type,
                size: file.size
            })).filter(f => f.path);
            if (fileListPayload.length === 0) return Promise.resolve({ success: false, error: 'No valid file paths found.' });
            return ipcRenderer.invoke('handle-file-drop', fileListPayload, shouldCopy);
        } catch (e) {
            return Promise.resolve({ success: false, error: `Preload Error: ${e.message}` });
        }
    },

    // --- 单向调用 ---
    startDownload: (requestData) => ipcRenderer.send('download-douyin', requestData),
    cacheTrack: (trackData) => ipcRenderer.send('cache-track', trackData),
    toggleFullscreen: (state) => ipcRenderer.send('toggle-fullscreen', state),
    openMediaFolder: (type, trackSrc) => ipcRenderer.send('open-media-folder', type, trackSrc),
    changeMediaDirectory: () => ipcRenderer.invoke('change-media-directory'),

    cancelDownload: (id, type) => ipcRenderer.send('cancel-download', { id, type }),

    // --- 监听事件 ---
    onDownloadStatus: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('download-status', handler);
        return () => ipcRenderer.removeListener('download-status', handler);
    },
    onNewTrack: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('new-track-added', handler);
        return () => ipcRenderer.removeListener('new-track-added', handler);
    },
    onImportStatus: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('import-status', handler);
        return () => ipcRenderer.removeListener('import-status', handler);
    },
    onFullscreenChange: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('fullscreen-change', handler);
        return () => ipcRenderer.removeListener('fullscreen-change', handler);
    },
    onDownloadStarted: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('download-started', handler);
        return () => ipcRenderer.removeListener('download-started', handler);
    },
    onDownloadProgress: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('download-progress', handler);
        return () => ipcRenderer.removeListener('download-progress', handler);
    },
    onDownloadFinished: (callback) => {
        const handler = (event, ...args) => callback(...args);
        ipcRenderer.on('download-finished', handler);
        return () => ipcRenderer.removeListener('download-finished', handler);
    },
    onOpenFile: (callback) => {
        const handler = (event, filePath) => callback(filePath);
        ipcRenderer.on('open-file', handler);
        return () => ipcRenderer.removeListener('open-file', handler);
    },
    onEnvCheckProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('env-check-progress', handler);
        return () => ipcRenderer.removeListener('env-check-progress', handler);
    },
    onEnvReady: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('env-ready', handler);
        return () => ipcRenderer.removeListener('env-ready', handler);
    },
    onEnvError: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('env-error', handler);
        return () => ipcRenderer.removeListener('env-error', handler);
    }
});