// src/preload.js

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- 异步调用 ---
    getLocalPlaylist: () => ipcRenderer.invoke('get-local-playlist'),
    searchOnline: (query, page) => ipcRenderer.invoke('search-online', { query, page }),
    deleteTrack: (trackData) => ipcRenderer.invoke('delete-track', trackData),
    getMusicUrl: (trackInfo) => ipcRenderer.invoke('get-music-url', trackInfo),
    getLrcContent: (relativePath) => ipcRenderer.invoke('get-lrc-content', relativePath),
    selectImportDirectory: () => ipcRenderer.invoke('select-import-directory'),
    startLocalImport: (dirPath) => ipcRenderer.invoke('start-local-import', dirPath),
    separateVideo: (trackData) => ipcRenderer.invoke('separate-video', trackData),
    getOnlineLyric: (lyricId, source) => ipcRenderer.invoke('get-online-lyric', { lyricId, source }),

    // --- 核心工具 ---
    downloadCoreTool: (toolName) => ipcRenderer.invoke('download-core-tool', toolName),
    openToolsFolder: () => ipcRenderer.invoke('open-tools-folder'),

    // --- 文件拖拽接口 ---
    // 【核心修复】使用 webUtils.getPathForFile 获取真实文件路径
    handleFileDrop: (files) => {
        if (!Array.isArray(files)) {
            console.error('[Preload] handleFileDrop 接收到的不是一个数组:', files);
            return Promise.resolve({ success: false, error: 'Preload Error: Invalid file list.' });
        }
        try {
            // 在渲染进程中直接访问 File 对象的 .path 属性可能会得到 undefined
            // 必须在 Preload 环节使用 Electron 的 webUtils 来解析真实路径
            const fileListPayload = files.map(file => {
                let filePath = '';
                try {
                    filePath = webUtils.getPathForFile(file);
                } catch (e) {
                    console.warn(`[Preload] 无法解析文件路径: ${file.name}`, e);
                    // 尝试回退到 file.path，尽管通常是 undefined
                    filePath = file.path;
                }

                return {
                    name: file.name,
                    path: filePath,
                    type: file.type,
                    size: file.size
                };
            }).filter(f => f.path); // 过滤掉无法获取路径的文件

            if (fileListPayload.length === 0) {
                return Promise.resolve({ success: false, error: 'No valid file paths found.' });
            }

            return ipcRenderer.invoke('handle-file-drop', fileListPayload);
        } catch (e) {
            console.error('[Preload] 处理文件拖拽时发生错误:', e);
            return Promise.resolve({ success: false, error: `Preload Error: ${e.message}` });
        }
    },

    // --- 单向调用 ---
    startDownload: (requestData) => ipcRenderer.send('download-douyin', requestData),
    cacheTrack: (trackData) => ipcRenderer.send('cache-track', trackData),
    toggleFullscreen: (state) => ipcRenderer.send('toggle-fullscreen', state),
    openMediaFolder: () => ipcRenderer.send('open-media-folder'),

    // --- 监听事件 ---
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
    // 【核心新增】暴露一个用于监听“打开文件”事件的接口
    // =========================================================================
    /**
     * 注册一个回调函数，当主进程通过文件关联请求打开文件时被调用。
     * @param {function(string): void} callback - 接收文件路径作为参数的回调函数。
     * @returns {Function} - 一个用于取消监听的函数。
     */
    onOpenFile: (callback) => {
        const handler = (event, filePath) => callback(filePath);
        ipcRenderer.on('open-file', handler);
        // 返回一个清理函数，用于在组件卸载时移除监听器
        return () => ipcRenderer.removeListener('open-file', handler);
    },
    // =========================================================================
});