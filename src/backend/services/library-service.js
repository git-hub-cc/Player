// src/backend/services/library-service.js

import path from 'path';
import fs from 'fs';
import { dialog, shell, BrowserWindow } from 'electron';
import { pinyin } from 'pinyin-pro';
import { createRequire } from 'node:module';
import { exec } from 'child_process';

const require = createRequire(import.meta.url || (typeof __filename !== 'undefined' ? __filename : process.cwd()));
let createCanvas;
try {
    const canvasModule = require('canvas');
    createCanvas = canvasModule.createCanvas;
} catch (e) {
    console.warn('[Library] Canvas 模块未安装或加载失败，将跳过自动封面生成功能:', e.message);
}

export class LibraryService {
    #config;
    #ffmpegPath;
    #lastOrdinal = -1;

    constructor(config, ffmpegPath) {
        this.#config = config;
        this.#ffmpegPath = ffmpegPath;
        console.log(`[Library Service] Service instantiated. FFmpeg path: ${this.#ffmpegPath || 'Not Installed'}`);
    }

    setFfmpegPath(newPath) {
        this.#ffmpegPath = newPath;
        console.log(`[Library Service] FFmpeg path updated: ${newPath}`);
    }

    // --- 私有辅助方法 ---

    async #ensureLastOrdinal() {
        if (this.#lastOrdinal !== -1) return;
        
        let maxOrdinal = 0;
        const dirs = [this.#config.MUSIC_DIR, this.#config.VIDEOS_DIR];
        
        for (const dir of dirs) {
            try {
                if (fs.existsSync(dir)) {
                    const files = await fs.promises.readdir(dir);
                    for (const file of files) {
                        const match = file.match(/^(\d{5})\./);
                        if (match) {
                            const ordinal = parseInt(match[1], 10);
                            if (ordinal > maxOrdinal) maxOrdinal = ordinal;
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Library] Failed to scan directory ${dir} for ordinals:`, e.message);
            }
        }
        this.#lastOrdinal = maxOrdinal;
    }

    async getNextOrdinal() {
        await this.#ensureLastOrdinal();
        this.#lastOrdinal++;
        return this.#lastOrdinal.toString().padStart(5, '0');
    }

    #generateUniqueFilename() {
        // 保留旧方法以防万一，但内部逻辑倾向于使用 ordinal
        const timestamp = Date.now();
        const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        return `media_${timestamp}_${randomSuffix}`;
    }

    #sanitizeFilename(filename) {
        if (!filename) return 'untitled';
        const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
        return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
    }

    async #generateVideoThumbnail(videoPath, outputDir, uniqueFilenameBase) {
        if (!this.#ffmpegPath) {
            console.warn('[Library] FFmpeg 未安装，跳过视频截图生成。');
            return null;
        }
        const outputFilename = `${uniqueFilenameBase}.jpg`;
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

    generateAndSavePlaceholderArt(title, uniqueFilenameBase) {
        if (!createCanvas || !this.#config.ALBUMART_DIR) return '';
        const base64Url = this.generatePlaceholderArt(title);
        if (!base64Url) return '';
        try {
            const filename = `${uniqueFilenameBase}.png`;
            const absolutePath = path.join(this.#config.ALBUMART_DIR, filename);
            const base64Data = base64Url.replace(/^data:image\/png;base64,/, "");
            fs.writeFileSync(absolutePath, base64Data, 'base64');
            const relativePath = path.relative(this.#config.MEDIA_ROOT, absolutePath).replace(/\\/g, '/');
            return relativePath;
        } catch (error) {
            console.error(`[Library] 保存占位封面图失败 for "${title}":`, error);
            return '';
        }
    }

    async getLocalPlaylist() {
        try { if (fs.existsSync(this.#config.PLAYLIST_PATH)) { const data = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); return { success: true, data }; } else { return { success: true, data: [] }; } } catch (e) { return { success: false, error: e.message }; }
    }

    async handleDeleteTrack({ src: relativeSrc }) {
        if (!relativeSrc) return { success: false, error: '删除失败: 未提供曲目路径。' };

        try {
            let playlist = [];
            if (fs.existsSync(this.#config.PLAYLIST_PATH)) {
                playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8'));
            }

            const trackToDelete = playlist.find(t => t.src === relativeSrc);
            if (!trackToDelete) return { success: false, error: '删除失败: 曲目未在播放列表中找到。' };

            const newPlaylist = playlist.filter(t => t.src !== relativeSrc);
            fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(newPlaylist, null, 2), 'utf-8');

            const keysToDelete = ['src', 'albumArt', 'lyrics'];

            for (const key of keysToDelete) {
                const fileRelativePath = trackToDelete[key];

                if (fileRelativePath && typeof fileRelativePath === 'string' &&
                    !fileRelativePath.startsWith('data:') &&
                    !fileRelativePath.startsWith('http')) {

                    try {
                        const filePath = path.join(this.#config.MEDIA_ROOT, fileRelativePath);
                        // 【核心修复】使用同步删除，并对 EBUSY 等错误进行健壮的日志记录
                        if (fs.existsSync(filePath)) {
                            try {
                                fs.unlinkSync(filePath);
                                console.log(`[Library] 成功删除文件: ${filePath}`);
                            } catch (err) {
                                // 详细记录删除失败的错误，包括错误码
                                console.warn(`[Library] 删除物理文件失败 (${key}): ${filePath}`, err.message, `(Code: ${err.code})`);
                            }
                        }
                    } catch (pathError) {
                        console.warn(`[Library] 解析文件路径出错:`, pathError);
                    }
                }
            }

            return { success: true, message: `成功删除 "${trackToDelete.title}"` };
        } catch (error) {
            console.error('[Library] handleDeleteTrack 发生未捕获异常:', error);
            return { success: false, error: error.message };
        }
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

            // =========================================================================
            // 【核心修改】修改输出路径和FFmpeg命令，将音频分离为 MP3 格式
            // =========================================================================
            const videoOrdinal = await this.getNextOrdinal();
            const videoOnlyPath = path.join(this.#config.VIDEOS_DIR, `${videoOrdinal}${sourceExt}`);
            const audioOrdinal = await this.getNextOrdinal();
            const audioOnlyPath = path.join(this.#config.MUSIC_DIR, `${audioOrdinal}.mp3`);

            const videoCommand = `"${this.#ffmpegPath}" -y -i "${sourceFullPath}" -c:v copy -an "${videoOnlyPath}"`;
            const audioCommand = `"${this.#ffmpegPath}" -y -i "${sourceFullPath}" -vn -c:a libmp3lame -b:a 192k "${audioOnlyPath}"`;
            // =========================================================================

            const runCommand = (cmd) => new Promise((resolve, reject) => { exec(cmd, (error, stdout, stderr) => { if (error) return reject(new Error(`FFmpeg 错误: ${stderr || error.message}`)); resolve(stdout); }); });
            await Promise.all([runCommand(videoCommand), runCommand(audioCommand)]);
            const generatedThumbName = await this.#generateVideoThumbnail(videoOnlyPath, this.#config.ALBUMART_DIR, videoOrdinal);
            const videoArtPath = generatedThumbName ? `albumArt/${generatedThumbName}` : (trackData.albumArt || '');
            let playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8')); const originalIndex = playlist.findIndex(t => t.src === sourceRelativePath);
            if (originalIndex === -1) { return { success: false, error: '在播放列表中未找到原始轨道，无法更新。' }; }
            const videoOnlyTrack = { ...trackData, title: `${trackData.title} (仅视频)`, src: path.relative(this.#config.MEDIA_ROOT, videoOnlyPath).replace(/\\/g, '/'), albumArt: videoArtPath, };
            const audioTitle = `${trackData.title} (仅音频)`;
            const audioArtDataUrl = this.generatePlaceholderArt(audioTitle);
            const audioOnlyTrack = { ...trackData, title: audioTitle, src: path.relative(this.#config.MEDIA_ROOT, audioOnlyPath).replace(/\\/g, '/'), type: 'audio', lyrics: '', albumArt: audioArtDataUrl, };
            
            // 为音频生成并保存物理占位图（使用其自己的序号）
            audioOnlyTrack.albumArt = this.generateAndSavePlaceholderArt(audioTitle, audioOrdinal);
            playlist.splice(originalIndex + 1, 0, videoOnlyTrack, audioOnlyTrack); fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');
            return { success: true, data: playlist, message: '视频分离成功！' };
        } catch (error) { return { success: false, error: error.message }; }
    }

    async handleDroppedFiles(files, sendMessage, shouldCopy = true) {
        console.log('🔍 [Library Service] 开始处理拖拽文件...', { shouldCopy }); if (!files || files.length === 0) return { success: false, error: '未接收到文件。' };
        const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus']; const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi'];
        let importedCount = 0; const newPlaylistTracks = [];
        const validFiles = files.filter(file => { if (!file?.path) return false; const ext = path.extname(file.path).toLowerCase(); return audioExt.includes(ext) || videoExt.includes(ext); });
        if (validFiles.length === 0) { sendMessage('import-status', { message: '不支持的文件类型', type: 'error' }); return { success: false, error: '不支持的文件类型' }; }
        sendMessage('import-status', { message: `正在处理 ${validFiles.length} 个文件...` });
        for (const file of validFiles) {
            try {
                const originalPath = file.path, ext = path.extname(originalPath).toLowerCase(), title = path.basename(originalPath, ext);
                const uniqueFilenameBase = await this.getNextOrdinal();
                const isVideo = videoExt.includes(ext);
                const targetDir = isVideo ? this.#config.VIDEOS_DIR : this.#config.MUSIC_DIR; const relativeDirName = isVideo ? 'videos' : 'music';
                
                let finalSrc;
                let mediaPathForArt = originalPath;

                if (shouldCopy) {
                    const newMediaPath = path.join(targetDir, `${uniqueFilenameBase}${ext}`);
                    await fs.promises.copyFile(originalPath, newMediaPath);
                    finalSrc = `${relativeDirName}/${path.basename(newMediaPath)}`;
                    mediaPathForArt = newMediaPath;
                } else {
                    finalSrc = originalPath.replace(/\\/g, '/');
                }

                const newTrack = {
                    title, artist: '拖拽导入', src: finalSrc, albumArt: '', lyrics: '',
                    type: isVideo ? 'video' : 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                    initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
                };

                if (isVideo) {
                    const generatedImageName = await this.#generateVideoThumbnail(newMediaPath, this.#config.ALBUMART_DIR, uniqueFilenameBase);
                    if (generatedImageName) newTrack.albumArt = `albumArt/${generatedImageName}`;
                    newTrack.lastPosition = 0;
                    newTrack.totalDuration = 0;
                } else {
                    newTrack.albumArt = this.generateAndSavePlaceholderArt(title, uniqueFilenameBase);
                }

                newPlaylistTracks.push(newTrack); importedCount++; sendMessage('new-track-added', newTrack);
            } catch (error) { console.error(`❌ [Library Service] 导入文件 ${file.name} 失败:`, error); }
        }
        if (newPlaylistTracks.length > 0) {
            await this.updateLocalPlaylist(newPlaylistTracks);
            sendMessage('import-status', {
                message: `成功导入 ${importedCount} 个文件！`,
                type: 'success',
                importedCount: importedCount
            });
            return { success: true, importedCount, tracks: newPlaylistTracks };
        } else {
            return { success: false, error: '导入失败，请检查日志。' };
        }
    }

    async handleLocalImport(directoryPath, sendMessage, shouldCopy = true) {
        if (!directoryPath) { return { success: false, error: '未提供目录。' }; } sendMessage('import-status', { message: '开始扫描目录...', type: 'default' });
        try {
            const fileGroups = await this.#scanDirectoryRecursive(directoryPath); const mediaTracks = Array.from(fileGroups.values()).filter(group => group.media);
            if (mediaTracks.length === 0) { sendMessage('import-status', { message: '未找到媒体文件', type: 'error' }); return { success: true, importedCount: 0 }; }
            sendMessage('import-status', { message: `发现 ${mediaTracks.length} 个文件，开始导入...` }); let importedCount = 0; const newPlaylistTracks = [];
            for (const group of mediaTracks) {
                try {
                    const { media, mediaType, lrc, art } = group;
                    const ext = path.extname(media), title = path.basename(media, ext);
                    const uniqueFilenameBase = await this.getNextOrdinal();
                    const isVideo = mediaType === 'video';
                    const targetDir = isVideo ? this.#config.VIDEOS_DIR : this.#config.MUSIC_DIR;
                    
                    let finalSrc;
                    if (shouldCopy) {
                        const newMediaPath = path.join(targetDir, `${uniqueFilenameBase}${ext}`);
                        await fs.promises.copyFile(media, newMediaPath);
                        finalSrc = path.relative(this.#config.MEDIA_ROOT, newMediaPath).replace(/\\/g, '/');
                    } else {
                        finalSrc = media.replace(/\\/g, '/');
                    }

                    const newTrack = {
                        title, artist: '本地导入', type: mediaType,
                        src: finalSrc,
                        pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                        initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
                    };

                    if (lrc) {
                        if (shouldCopy) {
                            const newLrcPath = path.join(targetDir, `${uniqueFilenameBase}.lrc`);
                            await fs.promises.copyFile(lrc, newLrcPath);
                            newTrack.lyrics = path.relative(this.#config.MEDIA_ROOT, newLrcPath).replace(/\\/g, '/');
                        } else {
                            newTrack.lyrics = lrc.replace(/\\/g, '/');
                        }
                    } else { newTrack.lyrics = ''; }

                    if (art) {
                        if (shouldCopy) {
                            const newArtPath = path.join(this.#config.ALBUMART_DIR, `${uniqueFilenameBase}${path.extname(art)}`);
                            await fs.promises.copyFile(art, newArtPath);
                            newTrack.albumArt = path.relative(this.#config.MEDIA_ROOT, newArtPath).replace(/\\/g, '/');
                        } else {
                            newTrack.albumArt = art.replace(/\\/g, '/');
                        }
                    } else if (isVideo) {
                        const thumbName = await this.#generateVideoThumbnail(shouldCopy ? path.join(this.#config.MEDIA_ROOT, finalSrc) : finalSrc, this.#config.ALBUMART_DIR, uniqueFilenameBase);
                        newTrack.albumArt = thumbName ? `albumArt/${thumbName}` : '';
                    } else {
                        newTrack.albumArt = this.generateAndSavePlaceholderArt(title, uniqueFilenameBase);
                    }

                    if (isVideo) {
                        newTrack.lastPosition = 0;
                        newTrack.totalDuration = 0;
                    }

                    newPlaylistTracks.push(newTrack);
                    importedCount++;
                    sendMessage('import-status', { message: `[${importedCount}/${mediaTracks.length}] ${title}` });
                } catch (e) {
                    console.error(`导入 ${group.media} 失败:`, e);
                }
            }
            if (newPlaylistTracks.length > 0) { await this.updateLocalPlaylist(newPlaylistTracks); }
            sendMessage('import-status', {
                message: `导入完成！成功导入 ${importedCount} 个文件。`,
                type: 'success',
                importedCount: importedCount
            });
            return { success: true, importedCount };
        } catch (error) { return { success: false, error: error.message }; }
    }

    /**
     * 清理播放列表中不存在的本地文件
     */
    async cleanupMissingTracks() {
        try {
            if (!fs.existsSync(this.#config.PLAYLIST_PATH)) return { success: true, removedCount: 0 };
            
            const playlist = JSON.parse(fs.readFileSync(this.#config.PLAYLIST_PATH, 'utf-8'));
            const initialCount = playlist.length;
            
            const validTracks = [];
            let removedCount = 0;

            for (const track of playlist) {
                if (track.src) {
                    // 如果是 media:// 协议或相对路径，解析到 MEDIA_ROOT
                    // 如果已经是绝对路径，则直接检查
                    let fullPath;
                    if (path.isAbsolute(track.src) || /^[a-zA-Z]:/.test(track.src)) {
                        fullPath = track.src;
                    } else {
                        const relativePath = track.src.startsWith('media://') 
                            ? track.src.substring('media://'.length) 
                            : track.src;
                        fullPath = path.join(this.#config.MEDIA_ROOT, decodeURIComponent(relativePath));
                    }

                    if (fs.existsSync(fullPath)) {
                        validTracks.push(track);
                    } else {
                        console.log(`[Library] Removing missing track: ${track.title} (${track.src})`);
                        removedCount++;
                    }
                } else {
                    validTracks.push(track); // 保留没有 src 的（虽然理论上不会有）
                }
            }

            if (removedCount > 0) {
                fs.writeFileSync(this.#config.PLAYLIST_PATH, JSON.stringify(validTracks, null, 2), 'utf-8');
            }

            return { success: true, removedCount, totalRemaining: validTracks.length };
        } catch (e) {
            console.error('[Library] Cleanup failed:', e);
            return { success: false, error: e.message };
        }
    }

    async handleSelectDirectory() {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (!mainWindow) return { canceled: true, filePaths: [] };
        return dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    }

    /**
     * 打开媒体目录，如果提供了 currentTrackSrc 则尝试选中该文件。
     * @param {string} type - 'audio', 'video' 或 'all'
     * @param {string|null} currentTrackSrc - 当前播放轨道的相对路径 (media:// 后面的部分)
     */
    handleOpenMediaFolder(type, currentTrackSrc = null) {
        let targetPath = null;

        // 尝试解析当前文件的绝对路径以进行选中
        if (currentTrackSrc) {
            try {
                // 处理可能带有 media:// 前缀的情况
                let relativePath = currentTrackSrc.startsWith('media://') 
                    ? currentTrackSrc.substring('media://'.length) 
                    : currentTrackSrc;
                
                const fullPath = path.normalize(path.join(this.#config.MEDIA_ROOT, decodeURIComponent(relativePath)));
                
                if (fs.existsSync(fullPath)) {
                    console.log(`[Library] Showing item in folder: ${fullPath}`);
                    shell.showItemInFolder(fullPath);
                    return;
                }
                console.warn(`[Library] Current track file does not exist: ${fullPath}`);
            } catch (e) {
                console.error(`[Library] Failed to resolve current track path:`, e.message);
            }
        }

        // 回退逻辑：打开相应的子目录
        if (type === 'audio') {
            targetPath = this.#config.MUSIC_DIR;
        } else if (type === 'video') {
            targetPath = this.#config.VIDEOS_DIR;
        } else {
            // 如果是 'all' 或其他未知类型，默认打开音乐目录，避免打开媒体根目录
            targetPath = this.#config.MUSIC_DIR;
        }

        if (targetPath && fs.existsSync(targetPath)) {
            console.log(`[Library] Opening folder: ${targetPath}`);
            shell.openPath(targetPath);
        } else {
            console.warn(`[Library] Directory does not exist: ${targetPath}`);
            // 如果连音乐目录都不存在，尝试打开视频目录，作为最后的兜底
            if (type !== 'video' && fs.existsSync(this.#config.VIDEOS_DIR)) {
                 shell.openPath(this.#config.VIDEOS_DIR);
            }
        }
    }

    async handleChangeMediaDirectory() {
        try {
            const mainWindow = BrowserWindow.getAllWindows()[0];
            if (!mainWindow) return { canceled: true };

            const result = await dialog.showOpenDialog(mainWindow, {
                title: '选择新的媒体库目录',
                properties: ['openDirectory', 'createDirectory']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return { canceled: true };
            }

            const newMediaRoot = result.filePaths[0];
            const oldMediaRoot = this.#config.MEDIA_ROOT;

            if (newMediaRoot === oldMediaRoot) {
                return { success: false, error: '新目录与当前目录相同。' };
            }

            // 检查新目录是否为空 (除了新建时可能自带隐藏文件)
            try {
                const newDirFiles = await fs.promises.readdir(newMediaRoot);
                if (newDirFiles.length > 0) {
                    // 如果不为空，询问用户是否继续（此提示也可以移除，直接覆盖或合并）
                    // 暂且直接覆盖或合并，简化操作。
                }
            } catch (e) { /* ignore */ }

            console.log(`[Library] 准备将媒体库从 ${oldMediaRoot} 移动到 ${newMediaRoot}`);

            // 为了支持跨盘符移动，我们自己实现一个简单的全量拷贝并删除，或者使用 cpSync (Node.js 16.7+)
            // 复制老目录的内容到新目录
            try {
                await fs.promises.cp(oldMediaRoot, newMediaRoot, { recursive: true, force: true });
            } catch (copyErr) {
                console.error(`[Library] 拷贝媒体库目录失败:`, copyErr);
                return { success: false, error: `拷贝文件失败: ${copyErr.message}` };
            }

            // 更新配置对象
            this.#config.MEDIA_ROOT = newMediaRoot;
            this.#config.VIDEOS_DIR = path.join(newMediaRoot, 'videos');
            this.#config.ALBUMART_DIR = path.join(newMediaRoot, 'albumart');
            this.#config.MUSIC_DIR = path.join(newMediaRoot, 'music');
            this.#config.PLAYLIST_PATH = path.join(newMediaRoot, 'playlist.json');

            // 确保新配置下必要的子目录都存在 (应对空的情况)
            [this.#config.VIDEOS_DIR, this.#config.ALBUMART_DIR, this.#config.MUSIC_DIR].forEach(dir => {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            });

            // 持久化到 user-config.json
            if (this.#config.USER_CONFIG_PATH) {
                try {
                    let userConfig = {};
                    if (fs.existsSync(this.#config.USER_CONFIG_PATH)) {
                        userConfig = JSON.parse(fs.readFileSync(this.#config.USER_CONFIG_PATH, 'utf8'));
                    }
                    userConfig.mediaRoot = newMediaRoot;
                    fs.writeFileSync(this.#config.USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2), 'utf8');
                } catch (e) {
                    console.error('[Library] 保存 user-config.json 失败:', e);
                }
            }

            // 尝试删除老目录 (可能会因为文件占用等原因失败，失败就不管了)
            try {
                await fs.promises.rm(oldMediaRoot, { recursive: true, force: true });
            } catch (rmErr) {
                console.warn(`[Library] 警告：删除旧媒体库目录失败（这不影响新库的使用）:`, rmErr);
            }

            return { success: true, message: '媒体库目录已成功修改并迁移数据。' };

        } catch (error) {
            console.error('[Library] handleChangeMediaDirectory 失败:', error);
            return { success: false, error: error.message };
        }
    }
}