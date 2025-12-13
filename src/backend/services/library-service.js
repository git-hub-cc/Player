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

// --- 模块作用域变量 ---
let CONFIG = {};
let FFMPEG_PATH = '';

/**
 * 初始化媒体库服务。
 * @param {object} sharedConfig - 从 setup-service 传入的 CONFIG 对象。
 * @param {string} ffmpegPath - FFmpeg 可执行文件路径。
 */
export function init(sharedConfig, ffmpegPath) {
    CONFIG = sharedConfig;
    FFMPEG_PATH = ffmpegPath;
    console.log(`[Library] 服务已初始化。FFmpeg 路径: ${FFMPEG_PATH || '未安装'}`);
}

/**
 * 用于在按需下载成功后，更新 ffmpeg 路径。
 * @param {string} path - 新的路径。
 */
export function setFfmpegPath(path) {
    FFMPEG_PATH = path;
    console.log(`[Library] FFmpeg 路径已更新: ${path}`);
}

function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

function hslToHex(h, s, l) {
    l /= 100;
    const a = s * Math.min(l, 1 - l) / 100;
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    const s = 65 + (Math.abs(hash) % 10);
    const l = 45 + (Math.abs(hash) % 10);
    return hslToHex(h, s, l);
}

function getDisplayChars(title) {
    if (!title) return '';
    return title.trim().substring(0, 10);
}

function generatePlaceholderArt(title) {
    if (!createCanvas) return '';
    const size = 1024;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const bgColor = stringToColor(title);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);
    const text = getDisplayChars(title);
    ctx.font = 'bold 90px "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);
    return canvas.toDataURL('image/png');
}

/**
 * 增加 FFmpeg 存在性检查。
 */
async function generateVideoThumbnail(videoPath, outputDir, filename) {
    if (!FFMPEG_PATH) {
        console.warn('[Library] FFmpeg 未安装，跳过视频截图生成。');
        return null;
    }
    const outputFilename = `${filename}.jpg`;
    const outputPath = path.join(outputDir, outputFilename);
    const command = `"${FFMPEG_PATH}" -y -ss 00:00:01.000 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;

    return new Promise((resolve) => {
        exec(command, (error) => {
            if (error) {
                console.warn(`[Library] 第 1 秒截图失败，尝试截取开头: ${error.message}`);
                const retryCommand = `"${FFMPEG_PATH}" -y -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
                exec(retryCommand, (retryError) => {
                    if (retryError) {
                        console.error(`[Library] 视频截图彻底失败: ${videoPath}`, retryError);
                        resolve(null);
                    } else {
                        resolve(fs.existsSync(outputPath) ? outputFilename : null);
                    }
                });
            } else {
                resolve(fs.existsSync(outputPath) ? outputFilename : null);
            }
        });
    });
}

export async function getLocalPlaylist() {
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            const playlistData = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
            return { success: true, data: playlistData };
        } else {
            return { success: true, data: [] };
        }
    } catch (e) {
        console.error(`[Library] 读取播放列表失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

export async function handleDeleteTrack({ src: relativeSrc }) {
    if (!relativeSrc) {
        return { success: false, error: '删除失败: 未提供曲目路径。' };
    }
    try {
        let playlist = [];
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
        const trackToDelete = playlist.find(t => t.src === relativeSrc);
        if (!trackToDelete) {
            return { success: false, error: '删除失败: 曲目未在播放列表中找到。' };
        }
        const newPlaylist = playlist.filter(t => t.src !== relativeSrc);
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(newPlaylist, null, 2), 'utf-8');
        ['src', 'albumArt', 'lyrics'].forEach(key => {
            if (trackToDelete[key] && !trackToDelete[key].startsWith('data:')) {
                const filePath = path.join(CONFIG.MEDIA_ROOT, trackToDelete[key]);
                if (fs.existsSync(filePath)) {
                    fs.unlink(filePath, (err) => {
                        if (err) console.error(`[Library] 删除文件失败: ${filePath}`, err);
                    });
                }
            }
        });
        return { success: true, message: `成功删除 "${trackToDelete.title}"` };
    } catch (error) {
        console.error(`[Library] 删除曲目时发生错误: ${error.message}`);
        return { success: false, error: error.message };
    }
}

export async function updateLocalPlaylist(newTracks) {
    if (!newTracks || newTracks.length === 0) return;
    let playlist = [];
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error(`[Library] 更新播放列表时读取旧文件失败:`, e);
    }
    const existingSrcs = new Set(playlist.map(track => track.src));
    const uniqueNewTracks = newTracks.filter(track => !existingSrcs.has(track.src));
    if (uniqueNewTracks.length > 0) {
        const updatedPlaylist = [...uniqueNewTracks, ...playlist];
        try {
            fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(updatedPlaylist, null, 2), 'utf-8');
        } catch (writeError) {
            console.error(`[Library] 写入播放列表文件失败:`, writeError);
        }
    }
}

export async function handleSeparateVideo(trackData) {
    if (!FFMPEG_PATH) {
        return {
            success: false,
            error: 'FFmpeg 未安装，无法执行分离操作。',
            reason: 'tool_missing',
            missing: 'ffmpeg'
        };
    }
    if (!trackData || !trackData.src) {
        return { success: false, error: '无效的轨道数据。' };
    }

    let sourceRelativePath = trackData.src;
    if (sourceRelativePath.startsWith('media://')) {
        sourceRelativePath = sourceRelativePath.substring('media://'.length);
    }
    sourceRelativePath = decodeURIComponent(sourceRelativePath);

    const sourceFullPath = path.join(CONFIG.MEDIA_ROOT, sourceRelativePath);

    if (!fs.existsSync(sourceFullPath)) {
        return { success: false, error: '源视频文件不存在。' };
    }

    try {
        const sourceDir = path.dirname(sourceFullPath);
        const sourceExt = path.extname(sourceFullPath);
        const sourceBaseName = path.basename(sourceFullPath, sourceExt);

        const videoOnlyPath = path.join(sourceDir, `${sourceBaseName}_video${sourceExt}`);
        const audioOnlyPath = path.join(CONFIG.MUSIC_DIR, `${sourceBaseName}_audio.opus`);

        const videoCommand = `"${FFMPEG_PATH}" -y -i "${sourceFullPath}" -c:v copy -an "${videoOnlyPath}"`;
        const audioCommand = `"${FFMPEG_PATH}" -y -i "${sourceFullPath}" -vn -c:a libopus -b:a 128k "${audioOnlyPath}"`;

        const runCommand = (cmd) => new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) return reject(new Error(`FFmpeg 错误: ${stderr || error.message}`));
                resolve(stdout);
            });
        });

        await Promise.all([runCommand(videoCommand), runCommand(audioCommand)]);

        const videoThumbBaseName = `${sourceBaseName}_video`;
        const generatedThumbName = await generateVideoThumbnail(videoOnlyPath, CONFIG.ALBUMART_DIR, videoThumbBaseName);
        const videoArtPath = generatedThumbName ? `albumArt/${generatedThumbName}` : (trackData.albumArt || '');

        let playlist = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
        const originalIndex = playlist.findIndex(t => t.src === sourceRelativePath);

        if (originalIndex === -1) {
            return { success: false, error: '在播放列表中未找到原始轨道，无法更新。' };
        }

        const videoOnlyTrack = {
            ...trackData,
            title: `${trackData.title} (仅视频)`,
            src: path.relative(CONFIG.MEDIA_ROOT, videoOnlyPath).replace(/\\/g, '/'),
            albumArt: videoArtPath, // 使用新生成的封面
        };
        const audioOnlyTrack = {
            ...trackData,
            title: `${trackData.title} (仅音频)`,
            src: path.relative(CONFIG.MEDIA_ROOT, audioOnlyPath).replace(/\\/g, '/'),
            type: 'audio',
            lyrics: '',
            albumArt: '', // 置为空字符串，前端将自动使用默认SVG
        };

        playlist.splice(originalIndex + 1, 0, videoOnlyTrack, audioOnlyTrack);
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');

        return { success: true, data: playlist, message: '视频分离成功！' };

    } catch (error) {
        console.error(`[Library] 分离视频失败:`, error);
        return { success: false, error: error.message };
    }
}

async function scanDirectoryRecursive(dirPath) {
    const fileGroups = new Map();
    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus'];
    const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi'];
    const artExt = ['.jpg', '.jpeg', '.png'];
    const lrcExt = '.lrc';

    async function scan(currentDir) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await scan(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const baseName = path.join(path.dirname(fullPath), path.basename(entry.name, ext));
                if (!fileGroups.has(baseName)) {
                    fileGroups.set(baseName, { media: null, mediaType: null, lrc: null, art: null });
                }
                const group = fileGroups.get(baseName);
                if (audioExt.includes(ext) && !group.media) {
                    group.media = fullPath; group.mediaType = 'audio';
                } else if (videoExt.includes(ext) && !group.media) {
                    group.media = fullPath; group.mediaType = 'video';
                } else if (lrcExt === ext && !group.lrc) group.lrc = fullPath;
                else if (artExt.includes(ext) && !group.art) group.art = fullPath;
            }
        }
    }
    await scan(dirPath);
    return fileGroups;
}

/**
 * =========================================================================
 * 【核心修复】处理拖拽文件的逻辑
 * 增加防御性检查，确保文件对象包含 path 属性
 * =========================================================================
 */
export async function handleDroppedFiles(files, sendMessage) {
    console.log('🔍 [Library Service] 开始处理拖拽文件...');
    if (!files || !Array.isArray(files) || files.length === 0) {
        console.warn('⚠️ [Library Service] 未接收到有效文件。');
        return { success: false, error: '未接收到文件。' };
    }

    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus'];
    const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi'];

    let importedCount = 0;
    const newPlaylistTracks = [];

    // 过滤出有效的媒体文件，并增加对 path 的检查
    const validFiles = files.filter(file => {
        if (!file || typeof file.path !== 'string') {
            console.warn(`⚠️ [Library Service] 跳过无效文件对象: name="${file?.name}", path="${file?.path}" (类型: ${typeof file?.path})`);
            return false;
        }
        const ext = path.extname(file.path).toLowerCase();
        const isValid = audioExt.includes(ext) || videoExt.includes(ext);
        if (!isValid) {
            console.log(`   - 跳过不支持的格式: ${file.name} (${ext})`);
        }
        return isValid;
    });

    if (validFiles.length === 0) {
        // 如果是因为 files 对象存在但 path 缺失导致的
        const hasMissingPaths = files.some(f => !f.path);
        const msg = hasMissingPaths
            ? '无法读取文件路径，请重试。'
            : '不支持的文件类型，仅支持音频和视频文件。';

        console.warn(`⚠️ [Library Service] 所有文件均被过滤: ${msg}`);
        sendMessage('import-status', { message: msg, type: 'error' });
        return { success: false, error: msg };
    }

    sendMessage('import-status', { message: `正在处理 ${validFiles.length} 个文件...` });
    console.log(`✅ [Library Service] 确认处理 ${validFiles.length} 个有效文件。`);

    for (const file of validFiles) {
        try {
            const originalPath = file.path;
            const ext = path.extname(originalPath).toLowerCase();
            const title = path.basename(originalPath, ext);
            const safeFilename = sanitizeFilename(title);

            console.log(`   > 处理中: ${originalPath}`);

            const isVideo = videoExt.includes(ext);
            const targetDir = isVideo ? CONFIG.VIDEOS_DIR : CONFIG.MUSIC_DIR;
            const relativeDirName = isVideo ? 'videos' : 'music';

            const newMediaPath = path.join(targetDir, `${safeFilename}${ext}`);

            // 复制文件到应用目录
            await fs.promises.copyFile(originalPath, newMediaPath);

            const newTrack = {
                title: title,
                artist: '拖拽导入',
                src: `${relativeDirName}/${path.basename(newMediaPath)}`,
                albumArt: '',
                lyrics: '',
                type: isVideo ? 'video' : 'audio',
                pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
            };

            // 尝试查找同名的封面和歌词文件 (在原文件目录下)
            const sourceDir = path.dirname(originalPath);
            const possibleArtFiles = ['.jpg', '.jpeg', '.png'].map(artExt => path.join(sourceDir, `${title}${artExt}`));
            const possibleLrcFile = path.join(sourceDir, `${title}.lrc`);

            // 处理封面
            let artFound = false;
            for (const artPath of possibleArtFiles) {
                if (fs.existsSync(artPath)) {
                    const newArtPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}${path.extname(artPath)}`);
                    await fs.promises.copyFile(artPath, newArtPath);
                    newTrack.albumArt = `albumArt/${path.basename(newArtPath)}`;
                    artFound = true;
                    break;
                }
            }

            if (!artFound) {
                if (isVideo) {
                    const generatedImageName = await generateVideoThumbnail(newMediaPath, CONFIG.ALBUMART_DIR, safeFilename);
                    if (generatedImageName) {
                        newTrack.albumArt = `albumArt/${generatedImageName}`;
                    } else {
                        try { newTrack.albumArt = generatePlaceholderArt(title) || ''; } catch (e) { /* ignore */ }
                    }
                } else {
                    try { newTrack.albumArt = generatePlaceholderArt(title) || ''; } catch (e) { /* ignore */ }
                }
            }

            // 处理歌词
            if (fs.existsSync(possibleLrcFile)) {
                const newLrcPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
                await fs.promises.copyFile(possibleLrcFile, newLrcPath);
                newTrack.lyrics = `music/${path.basename(newLrcPath)}`;
            }

            newPlaylistTracks.push(newTrack);
            importedCount++;

            // 发送单条添加通知，让前端实时更新
            sendMessage('new-track-added', newTrack);

        } catch (error) {
            console.error(`❌ [Library Service] 导入文件 ${file.name} 失败:`, error);
        }
    }

    if (newPlaylistTracks.length > 0) {
        await updateLocalPlaylist(newPlaylistTracks);
        console.log(`✅ [Library Service] 成功导入 ${importedCount} 个文件。`);
        sendMessage('import-status', { message: `成功导入 ${importedCount} 个文件！`, type: 'success' });
        return { success: true, importedCount, tracks: newPlaylistTracks };
    } else {
        return { success: false, error: '导入失败，请检查日志。' };
    }
}

export async function handleLocalImport(directoryPath, sendMessage) {
    if (!directoryPath) {
        return { success: false, error: '未提供目录。' };
    }
    sendMessage('import-status', { message: '开始扫描目录...', type: 'default' });
    try {
        const fileGroups = await scanDirectoryRecursive(directoryPath);
        const mediaTracks = Array.from(fileGroups.values()).filter(group => group.media);

        if (mediaTracks.length === 0) {
            sendMessage('import-status', { message: '在所选目录中未找到支持的媒体文件。', type: 'error' });
            return { success: true, importedCount: 0 };
        }
        sendMessage('import-status', { message: `扫描完成，发现 ${mediaTracks.length} 个媒体文件。开始导入...` });

        let importedCount = 0;
        const newPlaylistTracks = [];

        for (const group of mediaTracks) {
            const title = path.basename(group.media, path.extname(group.media));
            const safeFilename = sanitizeFilename(title);

            try {
                const isVideo = group.mediaType === 'video';
                const targetDir = isVideo ? CONFIG.VIDEOS_DIR : CONFIG.MUSIC_DIR;
                const relativeDirName = isVideo ? 'videos' : 'music';

                const newMediaPath = path.join(targetDir, `${safeFilename}${path.extname(group.media)}`);
                await fs.promises.copyFile(group.media, newMediaPath);

                const newTrack = {
                    title: title, artist: '本地导入', src: `${relativeDirName}/${path.basename(newMediaPath)}`,
                    albumArt: '', lyrics: '', type: isVideo ? 'video' : 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                    initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                };

                if (group.art) {
                    const newArtPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}${path.extname(group.art)}`);
                    await fs.promises.copyFile(group.art, newArtPath);
                    newTrack.albumArt = `albumArt/${path.basename(newArtPath)}`;
                } else {
                    if (isVideo) {
                        sendMessage('import-status', { message: `正在为视频 "${title}" 生成缩略图...` });
                        const generatedImageName = await generateVideoThumbnail(group.media, CONFIG.ALBUMART_DIR, safeFilename);
                        if (generatedImageName) {
                            newTrack.albumArt = `albumArt/${generatedImageName}`;
                        } else {
                            try { newTrack.albumArt = generatePlaceholderArt(title) || ''; } catch (e) { /* ignore */ }
                        }
                    } else {
                        try { newTrack.albumArt = generatePlaceholderArt(title) || ''; } catch (artError) { console.warn(`[Library] 为 "${title}" 生成封面失败:`, artError); }
                    }
                }

                if (group.lrc) {
                    const newLrcPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}.lrc`);
                    await fs.promises.copyFile(group.lrc, newLrcPath);
                    newTrack.lyrics = `music/${path.basename(newLrcPath)}`;
                }

                newPlaylistTracks.push(newTrack);
                importedCount++;
            } catch (copyError) {
                console.error(`[Library] 导入文件 ${title} 时出错:`, copyError);
            }
        }
        if (newPlaylistTracks.length > 0) {
            await updateLocalPlaylist(newPlaylistTracks);
        }
        sendMessage('import-status', { message: `导入完成！成功导入 ${importedCount} 个文件。`, type: 'success' });
        return { success: true, importedCount };
    } catch (error) {
        console.error(`[Library] 本地导入流程失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

export async function handleSelectDirectory() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
}

export function handleOpenMediaFolder() {
    if (CONFIG.MEDIA_ROOT && fs.existsSync(CONFIG.MEDIA_ROOT)) {
        shell.openPath(CONFIG.MEDIA_ROOT);
    } else {
        console.warn(`[Library] 媒体目录不存在: ${CONFIG.MEDIA_ROOT}`);
    }
}