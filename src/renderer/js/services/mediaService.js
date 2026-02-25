// src/renderer/js/services/mediaService.js

/**
 * @file 媒体服务层 (Media Service)
 * @description
 * 渲染进程的业务逻辑核心和主进程API的适配器。
 * 负责加载初始数据、处理API请求（包括缓存和请求锁定）、以及执行用户操作（如删除、分离视频）。
 */

import { mutations, getters } from '../state.js';
import { showToast, showConfirmationModal } from '../ui/modals.js';
import { pinyin } from 'pinyin-pro';
import path from 'path-browserify';
import { DEFAULT_ART } from '../config.js';
import * as dom from '../dom.js'; // 【核心新增】导入 dom 模块以访问 mediaPlayer 元素

// --- 缓存与请求锁定配置 ---
const CACHE_EXPIRATION_MS = 30 * 60 * 1000;
const CACHE_MAX_SIZE = 500;
const apiCache = new Map();
const inFlightRequests = new Set();

// --- 私有辅助函数 ---
function _makeTrackPlayable(track) {
    const playableTrack = { ...track };
    const encode = (p) => p ? p.split('/').map(s => encodeURIComponent(s)).join('/') : '';
    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        if (value && !value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('file:')) {
            playableTrack[key] = `media://${encode(value)}`;
        }
    });
    const title = track.title || '';
    playableTrack.pinyin = pinyin(title, { toneType: 'none' }).replace(/\s/g, '');
    playableTrack.initials = pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '');
    return playableTrack;
}

// --- 公共服务 API ---

export function init() {
    window.electronAPI.onNewTrack((newTrack) => {
        const wasEmpty = getters.playlist().length === 0;
        if (wasEmpty) {
            showToast(`"${newTrack.title}" 已添加！正在刷新媒体库...`, 'success');
            setTimeout(() => window.location.reload(), 1500);
            return;
        }
        const track = _makeTrackPlayable(newTrack);
        mutations.prependTrackWhilePlaying(track);
        showToast(`已添加 "${track.title}" 到媒体库！`, 'success');
    });
    console.log("Media Service initialized.");
}

export async function loadInitialData() {
    try {
        const result = await window.electronAPI.getLocalPlaylist();
        if (result.success && Array.isArray(result.data)) {
            mutations.setPlaylist(result.data.map(_makeTrackPlayable));
        } else {
            throw new Error(result.error || '无法加载播放列表');
        }
    } catch (error) {
        console.error("加载初始播放列表失败:", error);
        showToast("加载本地播放列表失败", "error");
    }
}

export async function searchOnline(query, page) {
    const requestKey = `search_${query}_${page}`;
    if (apiCache.has(requestKey)) {
        const cachedEntry = apiCache.get(requestKey);
        if (Date.now() - cachedEntry.timestamp < CACHE_EXPIRATION_MS) {
            return cachedEntry.data;
        } else {
            apiCache.delete(requestKey);
        }
    }
    if (inFlightRequests.has(requestKey)) {
        showToast('正在搜索中，请勿频繁操作...', 'info');
        return null;
    }
    try {
        inFlightRequests.add(requestKey);
        const result = await window.electronAPI.searchOnline(query, page);
        if (result.success) {
            if (apiCache.size >= CACHE_MAX_SIZE) {
                const oldestKey = apiCache.keys().next().value;
                apiCache.delete(oldestKey);
            }
            apiCache.set(requestKey, { data: result.data, timestamp: Date.now() });
            return result.data;
        } else {
            throw new Error(result.error || "未知搜索错误");
        }
    } catch (error) {
        console.error("在线搜索失败:", error);
        showToast(`搜索失败: ${error.message}`, "error");
        return null;
    } finally {
        inFlightRequests.delete(requestKey);
    }
}

export async function resolvePlayableUrl(trackInfo) {
    try {
        const result = await window.electronAPI.getMusicUrl(trackInfo);
        if (result.success && result.url) {
            return {
                playableSrc: result.url,
                albumArtUrl: result.albumArtUrl || trackInfo.albumArt,
                isVip: result.isVip,
                originalTrackInfo: result.originalTrackInfo
            };
        }
        throw new Error(result.error || "未能获取播放链接");
    } catch (error) {
        console.error(`解析 "${trackInfo.title}" 的播放URL失败:`, error);
        return null;
    }
}

export async function playTemporaryTrack(track) {
    const placeholderTrack = { ...track, src: '', albumArt: track.albumArt || DEFAULT_ART, isLoading: true };
    mutations.setTemporaryPlayingTrack(placeholderTrack);
    try {
        const resolved = await resolvePlayableUrl(track);
        if (resolved) {
            const playableTrack = {
                ...track,
                src: resolved.playableSrc,
                albumArt: resolved.albumArtUrl || track.albumArt || DEFAULT_ART,
                isLoading: false,
                isVip: resolved.isVip,
                originalTrackInfo: resolved.originalTrackInfo
            };
            mutations.setTemporaryPlayingTrack(playableTrack);
            mutations.setIsPlaying(true);
        } else {
            showToast(`无法播放: "${track.title}"`, 'error');
        }
    } catch (error) {
        console.error("临时播放流程异常:", error);
        showToast(`播放出错: ${error.message}`, 'error');
    }
}

export function cacheTrack(trackData) {
    window.electronAPI.cacheTrack(trackData);
}

/**
 * 删除指定的轨道，并优雅地处理文件句柄锁定问题。
 * @param {number} index - 要删除的轨道在播放列表中的索引。
 */
export async function deleteTrack(index) {
    const track = getters.playlist()[index];
    if (!track) return;

    try {
        // 1. 弹出确认对话框
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        const wasPlaying = getters.isPlaying();
        const isDeletingCurrent = getters.currentTrackIndex() === index;
        const decodedRelativeSrc = decodeURIComponent(track.src.substring('media://'.length));

        // 2. 定义一个发送删除请求到主进程的函数
        const sendDeleteRequest = async () => {
            const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });

            if (!result.success) {
                showToast(result.error || '文件删除失败，可能仍被占用', 'error');
                // 如果删除失败，可能需要重新加载以同步状态
                setTimeout(() => window.location.reload(), 1500);
                return;
            }

            // 物理文件删除成功后，更新前端状态
            mutations.removeTrack(index);
            showToast(`"${track.title}" 已删除`);

            // 如果列表空了，刷新页面
            if (getters.playlist().length === 0) {
                setTimeout(() => window.location.reload(), 1500);
                return;
            }

            // 如果删除了当前曲目，决定下一步操作
            if (isDeletingCurrent) {
                const nextIndex = Math.min(index, getters.playlist().length - 1);
                mutations.setCurrentTrackIndex(nextIndex, true);
                if (wasPlaying) {
                    mutations.setIsPlaying(true);
                }
            }
        };

        // =========================================================================
        // 【核心修复】解决 EBUSY 文件锁定问题的无竞态流程
        // =========================================================================
        // 3. 检查是否在删除当前活动轨道
        if (isDeletingCurrent) {
            console.log('[MediaService] 正在删除当前活动曲目，将等待句柄释放...');

            // 使用 Promise 封装基于 'emptied' 事件的异步流程
            await new Promise(resolve => {
                // a. 在 <video> 元素上注册一个一次性的 'emptied' 事件监听器。
                //    此事件在媒体元素被清空（例如 src 更改并调用 load()）后触发，
                //    标志着旧资源的文件句柄已被操作系统释放。
                dom.mediaPlayer.addEventListener('emptied', async () => {
                    console.log('[MediaService] "emptied" 事件触发，文件句柄已释放。');
                    await sendDeleteRequest();
                    resolve();
                }, { once: true });

                // b. 触发媒体卸载
                mutations.setIsPlaying(false);
                dom.mediaPlayer.removeAttribute('src'); // 使用 removeAttribute 而非赋值空字符串，防止触发非法请求
                dom.mediaPlayer.load();   // 强制重新加载，这将触发 'emptied' 事件
            });
        } else {
            // 如果删除的不是当前轨道，文件未被锁定，直接发送删除请求
            await sendDeleteRequest();
        }
        // =========================================================================

    } catch (err) {
        // 捕获 showConfirmationModal 的拒绝（用户取消）或 IPC 错误
        if (err !== 'cancel') {
            console.error('删除轨道时发生错误:', err);
            showToast('操作失败，请查看控制台日志', 'error');
        }
    }
}

export async function separateVideo(index) {
    const track = getters.playlist()[index];
    if (!track || track.type !== 'video') return;
    try {
        await showConfirmationModal(`确定要将 "${track.title}" 分离为独立的音视频文件吗？`);
        showToast('正在处理，请稍候...', 'info');
        const result = await window.electronAPI.separateVideo(track);
        if (result.success) {
            const updatedPlaylist = result.data.map(_makeTrackPlayable);
            const currentSrc = getters.currentTrack()?.src;
            const newIndex = updatedPlaylist.findIndex(t => t.src === currentSrc);
            mutations.setPlaylist(updatedPlaylist);
            mutations.setCurrentTrackIndex(newIndex > -1 ? newIndex : 0);
            showToast(result.message || '视频分离成功！', 'success');
        } else {
            showToast(`分离失败: ${result.error}`, 'error');
        }
    } catch (err) { /* 用户取消 */ }
}

export function playFileFromPath(filePath) {
    if (!filePath) return;
    const mainView = document.querySelector('.main-view');
    if (mainView?.classList.contains('is-empty')) mainView.classList.remove('is-empty');
    try {
        const ext = path.extname(filePath).toLowerCase();
        const baseName = path.basename(filePath, ext);
        const videoExts = ['.mp4', '.mkv', '.webm'];
        const audioExts = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
        let type = 'unknown';
        if (videoExts.includes(ext)) type = 'video';
        else if (audioExts.includes(ext)) type = 'audio';
        else { showToast(`不支持的文件类型: ${ext}`, 'error'); return; }
        const newTrack = {
            title: baseName, artist: '本地文件',
            src: `file://${filePath.replace(/\\/g, '/')}`,
            albumArt: '', lyrics: '', type: type, isExternal: true,
        };
        mutations.setTemporaryPlayingTrack(newTrack);
        mutations.setIsPlaying(true);
        showToast(`正在播放: ${newTrack.title}`);
    } catch (error) {
        console.error('处理外部文件失败:', error);
        showToast(`无法播放文件: ${error.message}`, 'error');
    }
}