// src/backend/services/library-service.js

import path from 'path';
import fs from 'fs';
import { dialog, shell, BrowserWindow } from 'electron';
import { pinyin } from 'pinyin-pro';
import { createRequire } from 'node:module';
import { exec } from 'child_process';

// --- 动态加载 Canvas ---
const require = createRequire(import.meta.url);
let createCanvas;
try {
    const canvasModule = require('canvas');
    createCanvas = canvasModule.createCanvas;
} catch (e) {
    console.warn('[Library] Canvas 模块未安装或加载失败，将跳过自动封面生成功能:', e.message);
}

/**
 * @class LibraryService
 * @description 负责管理本地媒体库，包括播放列表的读写、文件导入、删除和视频处理。
 */
export class LibraryService {
    // #config 存储应用的路径配置
    #config;
    // #ffmpegPath 存储 FFmpeg 的可执行文件路径
    #ffmpegPath;

    /**
     * @param {object} config - 应用的全局配置对象。
     * @param {string} ffmpegPath - FFmpeg 可执行文件路径。
     */
    constructor(config, ffmpegPath) {
        this.#config = config;
        this.#ffmpegPath = ffmpegPath;
        console.log(`[Library Service] 服务已实例化。FFmpeg 路径: ${this.#ffmpegPath || '未安装'}`);
    }

    /**
     * 在按需下载 FFmpeg 成功后，更新其路径。
     * @param {string} newPath - 新的路径。
     */
    setFfmpegPath(newPath) {
        this.#ffmpegPath = newPath;
        console.log(`[Library Service] FFmpeg 路径已更新: ${newPath}`);
    }

    // --- 私有辅助方法 ---

    #sanitizeFilename(filename) {
        if (!filename) return 'untitled';
        const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
        return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
    }

    async #generateVideoThumbnail(videoPath, outputDir, filename) {
        if (!this.#ffmpegPath) {
            console.warn('[Library] FFmpeg 未安装，跳过视频截图生成。');
            return null;
        }
        const outputFilename = `${filename}.jpg`;
        const outputPath = path.join(outputDir, outputFilename);
        const command = `"${this.#ffmpegPath}" -y -ss 00:00:01.000 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;

        return new Promise((resolve) => {
            exec(command, (error) => {
                if (error) {
                    const retryCommand = `"${this.#ffmpegPath}" -y -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
                    exec(retryCommand, (retryError) => resolve(fs.existsSync(outputPath) ? outputFilename : null));
                } else {
                    resolve(fs.existsSync(outputPath) ? outputFilename : null);
                }
            });
        });
    }

    async #scanDirectoryRecursive(dirPath) {
        const fileGroups = new Map(); const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus']; const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi']; const artExt = ['.jpg', '.jpeg', '.png']; const lrcExt = '.lrc';
        async function scan(currentDir) {
            const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) { await scan(fullPath); }
                else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase(); const baseName = path.join(path.dirname(fullPath), path.basename(entry.name, ext));
                    if (!fileGroups.has(baseName)) { fileGroups.set(baseName, { media: null, mediaType: null, lrc: null, art: null }); }
                    const group = fileGroups.get(baseName);
                    if (audioExt.includes(ext) && !group.media) { group.media = fullPath; group.mediaType = 'audio'; }
                    else if (videoExt.includes(ext) && !group.media) { group.media = fullPath; group.mediaType = 'video'; }
                    else if (lrcExt === ext && !group.lrc) group.lrc = fullPath;
                    else if (artExt.includes(ext) && !group.art) group.art = fullPath;
                }
            }
        }
        await scan(dirPath); return fileGroups;
    }

    // --- 公共 API 方法 ---

    /**
     * =========================================================================
     * 【核心修改】将此方法设为公共方法，以便其他服务可以调用它来生成占位图。
     * =========================================================================
     * 为给定的标题生成一个基于颜色哈希的占位封面图。
     * @param {string} title - 用于生成颜色和文本的标题。
     * @returns {string} - 返回 PNG 格式的 Base64 Data URL，如果 Canvas 不可用则返回空字符串。
     */
    generatePlaceholderArt(title) {
        if (!createCanvas) return '';
        const size = 1024;
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        const hslToHex = (h, s, l) => {
            l /= 100; const a = s * Math.min(l, 1 - l) / 100;
            const f = n => { const k = (n + h / 30) % 12; const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); return Math.round(255 * color).toString(16).padStart(2, '0'); };
            return `#${f(0)}${f(8)}${f(4)}`;
        };
        const stringToColor = (str) => {
            let hash = 0; for (let i = 0; i < str.length; i++) { hash = str.charCodeAt(i) + ((hash << 5) - hash); }
            const h = Math.abs(hash) % 360, s = 65 + (Math.abs(hash) % 10), l = 45 + (Math.abs(hash) % 10);
            return hslToHex(h, s, l);
        };
        const getDisplayChars = (t) => t ? t.trim().substring(0, 50) : '';

        ctx.fillStyle = stringToColor(title); ctx.fillRect(0, 0, size, size);
        const fontSize = 90, lineHeight = 110, maxWidth = size * 0.85;
        ctx.font = `bold ${fontSize}px "Microsoft YaHei", "Segoe UI", Arial, sans-serif`; ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const text = getDisplayChars(title);
        const lines = []; let currentLine = '';
        for (let i = 0; i < text.length; i++) {
            const char = text[i]; const testLine = currentLine + char; const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && i > 0) { lines.push(currentLine); currentLine = char; } else { currentLine = testLine; }
        }
        lines.push(currentLine);
        const totalBlockHeight = lines.length * lineHeight; let startY = (size - totalBlockHeight) / 2 + (lineHeight / 2);
        lines.forEach((line) => { ctx.fillText(line, size / 2, startY); startY += lineHeight; });
        return canvas.toDataURL('image/png');
    }

    async getLocalPlaylist() {
        try { if (fs.existsSync(this.#config.PLAYLIST_PATH)) { const data = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); return { success: true, data }; } else { return { success: true, data: [] }; } } catch (e) { return { success: false, error: e.message }; }
    }

    async handleDeleteTrack({ src: relativeSrc }) {
        if (!relativeSrc) return { success: false, error: '删除失败: 未提供曲目路径。' };
        try {
            let playlist = []; if (fs.existsSync(this.#config.PLAYLIST_PATH)) { playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); }
            const trackToDelete = playlist.find(t => t.src === relativeSrc); if (!trackToDelete) return { success: false, error: '删除失败: 曲目未在播放列表中找到。' };
            const newPlaylist = playlist.filter(t => t.src !== relativeSrc); fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(newPlaylist, null, 2), 'utf-8');
            ['src', 'albumArt', 'lyrics'].forEach(key => { if (trackToDelete[key] && !trackToDelete[key].startsWith('data:')) { const filePath = path.join(this.#config.MEDIA_ROOT, trackToDelete[key]); if (fs.existsSync(filePath)) { fs.unlink(filePath, () => {}); } } });
            return { success: true, message: `成功删除 "${trackToDelete.title}"` };
        } catch (error) { return { success: false, error: error.message }; }
    }

    async updateLocalPlaylist(newTracks) {
        if (!newTracks || newTracks.length === 0) return; let playlist = [];
        try { if (fs.existsSync(this.#config.PLAYLIST_PATH)) { playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); } } catch (e) { console.error(`[Library] 读取旧播放列表失败:`, e); }
        const existingSrcs = new Set(playlist.map(track => track.src)); const uniqueNewTracks = newTracks.filter(track => !existingSrcs.has(track.src));
        if (uniqueNewTracks.length > 0) { const updatedPlaylist = [...uniqueNewTracks, ...playlist]; fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(updatedPlaylist, null, 2), 'utf-8'); }
    }

    async handleSeparateVideo(trackData) {
        if (!this.#ffmpegPath) { return { success: false, error: 'FFmpeg 未安装，无法执行分离操作。', reason: 'tool_missing', missing: 'ffmpeg' }; }
        if (!trackData || !trackData.src) { return { success: false, error: '无效的轨道数据。' }; }
        let sourceRelativePath = trackData.src.startsWith('media://') ? trackData.src.substring('media://'.length) : trackData.src; sourceRelativePath = decodeURIComponent(sourceRelativePath);
        const sourceFullPath = path.join(this.#config.MEDIA_ROOT, sourceRelativePath); if (!fs.existsSync(sourceFullPath)) { return { success: false, error: '源视频文件不存在。' }; }
        try {
            const sourceDir = path.dirname(sourceFullPath), sourceExt = path.extname(sourceFullPath), sourceBaseName = path.basename(sourceFullPath, sourceExt);
            const videoOnlyPath = path.join(sourceDir, `${sourceBaseName}_video${sourceExt}`); const audioOnlyPath = path.join(this.#config.MUSIC_DIR, `${sourceBaseName}_audio.opus`);
            const videoCommand = `"${this.#ffmpegPath}" -y -i "${sourceFullPath}" -c:v copy -an "${videoOnlyPath}"`; const audioCommand = `"${this.#ffmpegPath}" -y -i "${sourceFullPath}" -vn -c:a libopus -b:a 128k "${audioOnlyPath}"`;
            const runCommand = (cmd) => new Promise((resolve, reject) => { exec(cmd, (error, stdout, stderr) => { if (error) return reject(new Error(`FFmpeg 错误: ${stderr || error.message}`)); resolve(stdout); }); });
            await Promise.all([runCommand(videoCommand), runCommand(audioCommand)]);
            const generatedThumbName = await this.#generateVideoThumbnail(videoOnlyPath, this.#config.ALBUMART_DIR, `${sourceBaseName}_video`);
            const videoArtPath = generatedThumbName ? `albumArt/${generatedThumbName}` : (trackData.albumArt || '');
            let playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); const originalIndex = playlist.findIndex(t => t.src === sourceRelativePath);
            if (originalIndex === -1) { return { success: false, error: '在播放列表中未找到原始轨道，无法更新。' }; }
            const videoOnlyTrack = { ...trackData, title: `${trackData.title} (仅视频)`, src: path.relative(this.#config.MEDIA_ROOT, videoOnlyPath).replace(/\\/g, '/'), albumArt: videoArtPath, };
            // =========================================================================
            // 【核心修改】为分离出的音频文件生成占位封面图，而不是留空。
            // =========================================================================
            const audioTitle = `${trackData.title} (仅音频)`;
            const audioArtDataUrl = this.generatePlaceholderArt(audioTitle);
            const audioOnlyTrack = { ...trackData, title: audioTitle, src: path.relative(this.#config.MEDIA_ROOT, audioOnlyPath).replace(/\\/g, '/'), type: 'audio', lyrics: '', albumArt: audioArtDataUrl, };
            // =========================================================================
            playlist.splice(originalIndex + 1, 0, videoOnlyTrack, audioOnlyTrack); fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');
            return { success: true, data: playlist, message: '视频分离成功！' };
        } catch (error) { return { success: false, error: error.message }; }
    }

    async handleDroppedFiles(files, sendMessage) {
        console.log('🔍 [Library Service] 开始处理拖拽文件...'); if (!files || files.length === 0) return { success: false, error: '未接收到文件。' };
        const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus']; const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi'];
        let importedCount = 0; const newPlaylistTracks = [];
        const validFiles = files.filter(file => { if (!file?.path) return false; const ext = path.extname(file.path).toLowerCase(); return audioExt.includes(ext) || videoExt.includes(ext); });
        if (validFiles.length === 0) { sendMessage('import-status', { message: '不支持的文件类型', type: 'error' }); return { success: false, error: '不支持的文件类型' }; }
        sendMessage('import-status', { message: `正在处理 ${validFiles.length} 个文件...` });
        for (const file of validFiles) {
            try {
                const originalPath = file.path, ext = path.extname(originalPath).toLowerCase(), title = path.basename(originalPath, ext);
                const safeFilename = this.#sanitizeFilename(title); const isVideo = videoExt.includes(ext);
                const targetDir = isVideo ? this.#config.VIDEOS_DIR : this.#config.MUSIC_DIR; const relativeDirName = isVideo ? 'videos' : 'music';
                const newMediaPath = path.join(targetDir, `${safeFilename}${ext}`); await fs.promises.copyFile(originalPath, newMediaPath);
                const newTrack = { title, artist: '拖拽导入', src: `${relativeDirName}/${path.basename(newMediaPath)}`, albumArt: '', lyrics: '', type: isVideo ? 'video' : 'audio', pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''), initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '') };
                if (isVideo) { const generatedImageName = await this.#generateVideoThumbnail(newMediaPath, this.#config.ALBUMART_DIR, safeFilename); if (generatedImageName) newTrack.albumArt = `albumArt/${generatedImageName}`; }
                newPlaylistTracks.push(newTrack); importedCount++; sendMessage('new-track-added', newTrack);
            } catch (error) { console.error(`❌ [Library Service] 导入文件 ${file.name} 失败:`, error); }
        }
        if (newPlaylistTracks.length > 0) { await this.updateLocalPlaylist(newPlaylistTracks); sendMessage('import-status', { message: `成功导入 ${importedCount} 个文件！`, type: 'success' }); return { success: true, importedCount, tracks: newPlaylistTracks }; }
        else { return { success: false, error: '导入失败，请检查日志。' }; }
    }

    async handleLocalImport(directoryPath, sendMessage) {
        if (!directoryPath) { return { success: false, error: '未提供目录。' }; } sendMessage('import-status', { message: '开始扫描目录...', type: 'default' });
        try {
            const fileGroups = await this.#scanDirectoryRecursive(directoryPath); const mediaTracks = Array.from(fileGroups.values()).filter(group => group.media);
            if (mediaTracks.length === 0) { sendMessage('import-status', { message: '未找到媒体文件', type: 'error' }); return { success: true, importedCount: 0 }; }
            sendMessage('import-status', { message: `发现 ${mediaTracks.length} 个文件，开始导入...` }); let importedCount = 0; const newPlaylistTracks = [];
            for (const group of mediaTracks) {
                try {
                    const { media, mediaType, lrc, art } = group;
                    const ext = path.extname(media), title = path.basename(media, ext);
                    const safeFilename = this.#sanitizeFilename(title);
                    const isVideo = mediaType === 'video';
                    const targetDir = isVideo ? this.#config.VIDEOS_DIR : this.#config.MUSIC_DIR;
                    const newMediaPath = path.join(targetDir, `${safeFilename}${ext}`);
                    await fs.promises.copyFile(media, newMediaPath);

                    const newTrack = {
                        title, artist: '本地导入', type: mediaType,
                        src: path.relative(this.#config.MEDIA_ROOT, newMediaPath).replace(/\\/g, '/'),
                        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
                    };

                    if (lrc) {
                        const newLrcPath = path.join(targetDir, `${safeFilename}.lrc`);
                        await fs.promises.copyFile(lrc, newLrcPath);
                        newTrack.lyrics = path.relative(this.#config.MEDIA_ROOT, newLrcPath).replace(/\\/g, '/');
                    } else { newTrack.lyrics = ''; }

                    if (art) {
                        const newArtPath = path.join(this.#config.ALBUMART_DIR, `${safeFilename}${path.extname(art)}`);
                        await fs.promises.copyFile(art, newArtPath);
                        newTrack.albumArt = path.relative(this.#config.MEDIA_ROOT, newArtPath).replace(/\\/g, '/');
                    } else if (isVideo) {
                        const thumbName = await this.#generateVideoThumbnail(newMediaPath, this.#config.ALBUMART_DIR, safeFilename);
                        newTrack.albumArt = thumbName ? `albumArt/${thumbName}` : '';
                    } else { newTrack.albumArt = ''; }

                    newPlaylistTracks.push(newTrack);
                    importedCount++;
                    sendMessage('import-status', { message: `[${importedCount}/${mediaTracks.length}] ${title}` });
                } catch (e) {
                    console.error(`导入 ${group.media} 失败:`, e);
                }
            }
            if (newPlaylistTracks.length > 0) { await this.updateLocalPlaylist(newPlaylistTracks); }
            sendMessage('import-status', { message: `导入完成！成功导入 ${importedCount} 个文件。`, type: 'success' });
            return { success: true, importedCount };
        } catch (error) { return { success: false, error: error.message }; }
    }

    // --- 静态 IPC 处理器 (不需要 this) ---

    async handleSelectDirectory() {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (!mainWindow) return { canceled: true, filePaths: [] };
        return dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    }

    handleOpenMediaFolder() {
        if (this.#config.MEDIA_ROOT && fs.existsSync(this.#config.MEDIA_ROOT)) {
            shell.openPath(this.#config.MEDIA_ROOT);
        } else {
            console.warn(`[Library] 媒体目录不存在: ${this.#config.MEDIA_ROOT}`);
        }
    }
}