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
    // =========================================================================
    // 【核心新增】暴露获取在线歌词的接口给渲染进程
    // =========================================================================
    getOnlineLyric: (lyricId, source) => ipcRenderer.invoke('get-online-lyric', { lyricId, source }),
    // =========================================================================

    // --- 核心工具 ---
    downloadCoreTool: (toolName) => ipcRenderer.invoke('download-core-tool', toolName),
    openToolsFolder: () => ipcRenderer.invoke('open-tools-folder'),

    // --- 文件拖拽处理 ---
    handleFileDrop: (files) => {
        console.group('🔍 [Preload] handleFileDrop Log');
        console.log('1. Files array received:', files);

        try {
            const fileList = files.map((file, index) => {
                let filePath = null;
                try {
                    // 获取物理路径
                    filePath = webUtils.getPathForFile(file);
                    console.log(`   - File[${index}]: name="${file.name}", path="${filePath}"`);
                } catch (pathError) {
                    console.error(`   - ❌ File[${index}] getPathForFile failed:`, pathError);
                }

                // 返回普通对象给主进程
                return {
                    name: file.name,
                    path: filePath,
                    type: file.type,
                    size: file.size
                };
            });

            console.log('2. Sending payload to Main:', fileList);
            console.groupEnd();

            return ipcRenderer.invoke('handle-file-drop', fileList);

        } catch (e) {
            console.error('❌ Preload processing error:', e);
            console.groupEnd();
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
});