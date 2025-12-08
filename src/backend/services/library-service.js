// src/backend/services/library-service.js

import path from 'path';
import fs from 'fs';
import { dialog, shell, BrowserWindow } from 'electron';
import { pinyin } from 'pinyin-pro';
import { createRequire } from 'node:module';
import { exec } from 'child_process'; // 【新增】引入 exec 用于执行 FFmpeg 截图命令

// --- 动态加载 Canvas ---
// 使用 createRequire 是为了规避 Vite 打包时对 canvas 二进制文件(.node)解析产生的
// "Unexpected character" 错误。这种方式强制在运行时加载原生模块，而不是在构建时打包。
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
let FFMPEG_PATH = ''; // 【新增】存储 FFmpeg 路径

/**
 * 初始化媒体库服务。
 * @param {object} sharedConfig - 从 setup-service 传入的 CONFIG 对象。
 * @param {string} ffmpegPath - 【新增】FFmpeg 可执行文件路径。
 */
export function init(sharedConfig, ffmpegPath) {
    CONFIG = sharedConfig;
    FFMPEG_PATH = ffmpegPath;
    console.log(`[Library] 服务已初始化。FFmpeg 路径: ${FFMPEG_PATH || '未提供'}`);
}

/**
 * sanitzeFilename 的一个副本，用于本地导入
 */
function sanitizeFilename(filename) {
    if (!filename) return 'untitled';
    const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
    return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
}

/**
 * 辅助函数：将 HSL 颜色转换为 RGB 十六进制字符串
 */
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

/**
 * 辅助函数：根据字符串生成确定性的颜色
 */
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

/**
 * 辅助函数：从标题中提取用于展示的缩写字符
 */
function getDisplayChars(title) {
    if (!title) return '';
    return title.trim().substring(0, 10);
}

/**
 * 核心功能：生成占位封面图片
 */
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
 * 【新增】使用 FFmpeg 为本地视频文件生成截图
 * @param {string} videoPath - 视频源文件路径
 * @param {string} outputDir - 输出目录
 * @param {string} filename - 输出文件名（不含扩展名）
 * @returns {Promise<string|null>} - 成功返回生成的图片文件名（如 "file.jpg"），失败返回 null
 */
async function generateVideoThumbnail(videoPath, outputDir, filename) {
    if (!FFMPEG_PATH) {
        console.warn('[Library] FFmpeg 未配置，跳过视频截图。');
        return null;
    }

    const outputFilename = `${filename}.jpg`;
    const outputPath = path.join(outputDir, outputFilename);

    // 尝试在第 1 秒截图，避免开头黑屏
    // -y: 覆盖输出
    // -ss: 时间偏移
    // -i: 输入
    // -vframes 1: 只取一帧
    // -q:v 2: 较高质量的 JPEG
    const command = `"${FFMPEG_PATH}" -y -ss 00:00:01.000 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;

    return new Promise((resolve) => {
        exec(command, (error) => {
            if (error) {
                // 如果第 1 秒截图失败（可能视频极短），尝试不带 -ss 参数
                console.warn(`[Library] 第 1 秒截图失败，尝试截取开头: ${error.message}`);
                const retryCommand = `"${FFMPEG_PATH}" -y -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
                exec(retryCommand, (retryError) => {
                    if (retryError) {
                        console.error(`[Library] 视频截图彻底失败: ${videoPath}`, retryError);
                        resolve(null);
                    } else {
                        if (fs.existsSync(outputPath)) {
                            resolve(outputFilename);
                        } else {
                            resolve(null);
                        }
                    }
                });
            } else {
                if (fs.existsSync(outputPath)) {
                    resolve(outputFilename);
                } else {
                    resolve(null);
                }
            }
        });
    });
}

/**
 * 读取本地 playlist.json 文件内容。
 */
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

/**
 * 从播放列表和文件系统中删除一个曲目。
 */
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

        // 1. 更新播放列表
        const newPlaylist = playlist.filter(t => t.src !== relativeSrc);
        fs.writeFileSync(CONFIG.PLAYLIST_PATH, JSON.stringify(newPlaylist, null, 2), 'utf-8');

        // 2. 删除关联文件
        ['src', 'albumArt', 'lyrics'].forEach(key => {
            if (trackToDelete[key]) {
                if (key === 'albumArt' && trackToDelete[key].startsWith('data:')) {
                    return;
                }
                const filePath = path.join(CONFIG.MEDIA_ROOT, trackToDelete[key]);
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (unlinkError) {
                        console.error(`[Library] 删除文件失败: ${filePath}`, unlinkError);
                    }
                }
            }
        });

        return { success: true, message: `成功删除 "${trackToDelete.title}"` };
    } catch (error) {
        console.error(`[Library] 删除曲目时发生错误: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 将新曲目原子性地添加到 playlist.json 的开头。
 */
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

/**
 * 递归扫描目录，将音频、视频、歌词和封面文件按基本文件名分组。
 * @param {string} dirPath - 要扫描的目录路径。
 * @returns {Promise<Map<string, object>>} - 返回一个 Map，键是文件基本名，值是包含文件路径的对象。
 */
async function scanDirectoryRecursive(dirPath) {
    const fileGroups = new Map();
    // 【修改】扩展支持的文件类型，包含视频
    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
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
                    // media 字段用于存储音频或视频文件路径
                    fileGroups.set(baseName, { media: null, mediaType: null, lrc: null, art: null });
                }
                const group = fileGroups.get(baseName);

                if (audioExt.includes(ext) && !group.media) {
                    group.media = fullPath;
                    group.mediaType = 'audio';
                }
                else if (videoExt.includes(ext) && !group.media) {
                    group.media = fullPath;
                    group.mediaType = 'video';
                }
                else if (lrcExt === ext && !group.lrc) group.lrc = fullPath;
                else if (artExt.includes(ext) && !group.art) group.art = fullPath;
            }
        }
    }

    await scan(dirPath);
    return fileGroups;
}

/**
 * 处理本地媒体导入流程。
 * 支持音频和视频文件，并在导入视频时自动尝试生成截图。
 * @param {string} directoryPath - 用户选择的目录路径。
 * @param {function} sendMessage - 用于向渲染进程发送状态更新的回调函数。
 * @returns {Promise<object>} - 包含 success 和 importedCount/error 的结果对象。
 */
export async function handleLocalImport(directoryPath, sendMessage) {
    if (!directoryPath) {
        return { success: false, error: '未提供目录。' };
    }

    sendMessage('import-status', { message: '开始扫描目录...', type: 'default' });
    try {
        const fileGroups = await scanDirectoryRecursive(directoryPath);
        // 筛选出包含有效媒体文件（音频或视频）的组
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
                // 根据媒体类型决定目标目录
                const isVideo = group.mediaType === 'video';
                const targetDir = isVideo ? CONFIG.VIDEOS_DIR : CONFIG.MUSIC_DIR;
                const relativeDirName = isVideo ? 'videos' : 'music';

                // 1. 复制媒体文件
                const newMediaPath = path.join(targetDir, `${safeFilename}${path.extname(group.media)}`);
                // 使用 copyFile 覆盖模式，如果目标已存在会覆盖，也可以加检查跳过
                await fs.promises.copyFile(group.media, newMediaPath);

                const newTrack = {
                    title: title,
                    artist: '本地导入',
                    src: `${relativeDirName}/${path.basename(newMediaPath)}`,
                    albumArt: '',
                    lyrics: '',
                    type: isVideo ? 'video' : 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                    initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                };

                // 2. 处理封面
                if (group.art) {
                    // 场景 A: 存在本地封面文件，直接复制
                    const newArtPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}${path.extname(group.art)}`);
                    await fs.promises.copyFile(group.art, newArtPath);
                    newTrack.albumArt = `albumArt/${path.basename(newArtPath)}`;
                } else {
                    // 场景 B: 没有封面
                    if (isVideo) {
                        // 如果是视频，尝试使用 FFmpeg 截图
                        sendMessage('import-status', { message: `正在为视频 "${title}" 生成缩略图...` });
                        const generatedImageName = await generateVideoThumbnail(group.media, CONFIG.ALBUMART_DIR, safeFilename);
                        if (generatedImageName) {
                            newTrack.albumArt = `albumArt/${generatedImageName}`;
                        } else {
                            // 截图失败，回退到占位图
                            try {
                                const generatedDataUrl = generatePlaceholderArt(title);
                                if (generatedDataUrl) newTrack.albumArt = generatedDataUrl;
                            } catch (e) { /* ignore */ }
                        }
                    } else {
                        // 如果是音频，生成占位图
                        try {
                            const generatedDataUrl = generatePlaceholderArt(title);
                            if (generatedDataUrl) newTrack.albumArt = generatedDataUrl;
                        } catch (artError) {
                            console.warn(`[Library] 为 "${title}" 生成封面失败:`, artError);
                        }
                    }
                }

                // 3. 处理歌词
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

/**
 * 打开一个对话框让用户选择一个目录。
 */
export async function handleSelectDirectory() {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return { canceled: true, filePaths: [] };
    return dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
}

/**
 * 在文件管理器中打开应用的媒体根目录。
 */
export function handleOpenMediaFolder() {
    if (CONFIG.MEDIA_ROOT && fs.existsSync(CONFIG.MEDIA_ROOT)) {
        shell.openPath(CONFIG.MEDIA_ROOT);
    } else {
        console.warn(`[Library] 媒体目录不存在: ${CONFIG.MEDIA_ROOT}`);
    }
}