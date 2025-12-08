// src/backend/services/library-service.js

import path from 'path';
import fs from 'fs';
import { dialog, shell, BrowserWindow } from 'electron';
import { pinyin } from 'pinyin-pro';
import { createRequire } from 'node:module';

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

/**
 * 初始化媒体库服务。
 * @param {object} sharedConfig - 从 setup-service 传入的 CONFIG 对象。
 */
export function init(sharedConfig) {
    CONFIG = sharedConfig;
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
 * @param {number} h - 色相 (0-360)
 * @param {number} s - 饱和度 (0-100)
 * @param {number} l - 亮度 (0-100)
 * @returns {string} - 十六进制颜色代码 (例如 "#RRGGBB")
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
 * 使用简单的哈希算法将字符串映射到 HSL 色彩空间。
 * @param {string} str - 输入字符串
 * @returns {string} - 十六进制背景颜色
 */
function stringToColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    // 色相：利用哈希值在 0-360 之间循环
    const h = Math.abs(hash) % 360;
    // 饱和度：固定在 60-75% 之间，保持色彩鲜艳但不刺眼
    const s = 65 + (Math.abs(hash) % 10);
    // 亮度：固定在 40-50% 之间，确保白色文字可读
    const l = 45 + (Math.abs(hash) % 10);
    return hslToHex(h, s, l);
}

/**
 * =========================================================================
 * 【核心修改】调整从标题中提取的字符数量
 * =========================================================================
 * 辅助函数：从标题中提取用于展示的缩写字符
 * @param {string} title - 歌曲标题
 * @returns {string} - 最多10个字符的展示文本
 */
function getDisplayChars(title) {
    if (!title) return '';
    // 直接截取前10个字符作为展示文本
    return title.trim().substring(0, 10);
}

/**
 * =========================================================================
 * 【核心修改】调整字体大小以适应更长的文本
 * =========================================================================
 * 核心功能：生成占位封面图片
 * @param {string} title - 歌曲标题
 * @returns {string} - Base64 格式的 Data URI
 */
function generatePlaceholderArt(title) {
    if (!createCanvas) return ''; // 如果 Canvas 未加载，返回空

    const size = 1024;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // 1. 绘制背景
    const bgColor = stringToColor(title);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);

    // 2. 绘制文字
    const text = getDisplayChars(title);
    // 减小字体大小以适应更长的文本（最多10个字符）
    ctx.font = 'bold 90px "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 调整垂直位置以在视觉上居中
    ctx.fillText(text, size / 2, size / 2);

    return canvas.toDataURL('image/png');
}

/**
 * 读取本地 playlist.json 文件内容。
 * @returns {Promise<object>} - 包含 success 和 data/error 的结果对象。
 */
export async function getLocalPlaylist() {
    try {
        if (fs.existsSync(CONFIG.PLAYLIST_PATH)) {
            const playlistData = JSON.parse(fs.readFileSync(CONFIG.PLAYLIST_PATH, 'utf-8'));
            return { success: true, data: playlistData };
        } else {
            // 文件不存在是正常情况，返回空数组
            return { success: true, data: [] };
        }
    } catch (e) {
        console.error(`[Library] 读取播放列表失败: ${e.message}`);
        return { success: false, error: e.message };
    }
}

/**
 * 从播放列表和文件系统中删除一个曲目。
 * @param {object} trackData - 包含要删除曲目 src 属性的对象。
 * @returns {Promise<object>} - 包含 success 和 message/error 的结果对象。
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
                // 注意：对于动态生成的 Data URI 封面，这里不会删除任何文件，因为路径不是文件路径
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
 * @param {Array<object>} newTracks - 要添加的新曲目数组。
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
 * 递归扫描目录，将音频、歌词和封面文件按基本文件名分组。
 * @param {string} dirPath - 要扫描的目录路径。
 * @returns {Promise<Map<string, object>>} - 返回一个 Map，键是文件基本名，值是包含文件路径的对象。
 */
async function scanDirectoryRecursive(dirPath) {
    const fileGroups = new Map();
    const audioExt = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
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
                    fileGroups.set(baseName, { audio: null, lrc: null, art: null });
                }
                const group = fileGroups.get(baseName);

                if (audioExt.includes(ext) && !group.audio) group.audio = fullPath;
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
        const audioTracks = Array.from(fileGroups.values()).filter(group => group.audio);

        if (audioTracks.length === 0) {
            sendMessage('import-status', { message: '在所选目录中未找到支持的音频文件。', type: 'error' });
            return { success: true, importedCount: 0 };
        }

        sendMessage('import-status', { message: `扫描完成，发现 ${audioTracks.length} 首歌曲。开始导入...` });

        let importedCount = 0;
        const newPlaylistTracks = [];

        for (const group of audioTracks) {
            const title = path.basename(group.audio, path.extname(group.audio));
            const safeFilename = sanitizeFilename(title);

            try {
                // 1. 复制音频文件
                const newAudioPath = path.join(CONFIG.MUSIC_DIR, `${safeFilename}${path.extname(group.audio)}`);
                await fs.promises.copyFile(group.audio, newAudioPath);

                const newTrack = {
                    title: title,
                    artist: '本地导入',
                    src: `music/${path.basename(newAudioPath)}`,
                    albumArt: '',
                    lyrics: '',
                    type: 'audio',
                    pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
                    initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, ''),
                };

                // 2. 处理封面
                if (group.art) {
                    // 如果存在本地封面文件，复制它
                    const newArtPath = path.join(CONFIG.ALBUMART_DIR, `${safeFilename}${path.extname(group.art)}`);
                    await fs.promises.copyFile(group.art, newArtPath);
                    newTrack.albumArt = `albumArt/${path.basename(newArtPath)}`;
                } else {
                    // 【核心新增】如果不存在封面，动态生成基于标题的占位图
                    try {
                        const generatedDataUrl = generatePlaceholderArt(title);
                        if (generatedDataUrl) {
                            newTrack.albumArt = generatedDataUrl;
                        }
                    } catch (artError) {
                        console.warn(`[Library] 为 "${title}" 生成封面失败:`, artError);
                        // 生成失败不影响导入，保持 albumArt 为空即可
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

        sendMessage('import-status', { message: `导入完成！成功导入 ${importedCount} 首歌曲。`, type: 'success' });
        return { success: true, importedCount };

    } catch (error) {
        console.error(`[Library] 本地导入流程失败: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * 打开一个对话框让用户选择一个目录。
 * @returns {Promise<Electron.OpenDialogReturnValue>}
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