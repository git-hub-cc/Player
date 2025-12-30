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

/**
 * 解析在线曲目的可播放URL。
 * 现在返回一个更详细的对象，以支持VIP歌曲的试听-切换逻辑。
 */
export async function resolvePlayableUrl(trackInfo) {
    try {
        const result = await window.electronAPI.getMusicUrl(trackInfo);
        if (result.success && result.url) {
            return {
                playableSrc: result.url, // 对VIP是试听URL
                albumArtUrl: result.albumArtUrl || trackInfo.albumArt,
                isVip: result.isVip,
                originalTrackInfo: result.originalTrackInfo // VIP歌曲需要它来获取正式URL
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
 * 删除指定的轨道。
 * 【核心修复】解决了 EBUSY 锁定问题：先在前端卸载媒体，释放句柄后再通知后端删除。
 */
export async function deleteTrack(index) {
    const track = getters.playlist()[index];
    if (!track) return;

    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

        // 保存状态，以便后续恢复或判断
        const wasPlaying = getters.isPlaying();
        const isDeletingCurrent = getters.currentTrackIndex() === index;
        const decodedRelativeSrc = decodeURIComponent(track.src.substring('media://'.length));

        // =========================================================================
        // 【核心修复】防止文件锁定 (File Lock / EBUSY)
        // =========================================================================
        // 如果要删除的是当前正在播放（或暂停但已加载）的曲目，
        // 必须先在渲染进程停止播放并清除 src，迫使浏览器释放对文件的句柄。
        if (isDeletingCurrent) {
            console.log('[MediaService] 正在删除当前活动曲目，先卸载媒体以释放句柄...');
            mutations.setIsPlaying(false);
            mutations.clearPlayingTrackInfo(); // 这会触发 video 元素 src 被置空

            // 关键：给予浏览器/操作系统一点时间来完成句柄释放
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // =========================================================================

        // 此时句柄应已释放，安全发送 IPC 请求
        const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });

        if (!result.success) {
            showToast(result.error, 'error');
            // 如果删除失败且之前是当前曲目，可能需要考虑恢复状态，但通常不需要，让用户重新点击即可
            return;
        }

        // 物理文件删除成功，更新前端状态
        mutations.removeTrack(index);
        showToast(`"${track.title}" 已删除`);

        // 如果列表空了，刷新页面
        if (getters.playlist().length === 0) {
            setTimeout(() => window.location.reload(), 1500);
            return;
        }

        // 如果刚才删除了当前曲目，尝试播放下一首（或保持原来的位置）
        if (isDeletingCurrent) {
            // 由于 removeTrack 已经调整了数组，当前 index 现在指向原来的“下一首”
            // 确保索引不越界
            const nextIndex = Math.min(index, getters.playlist().length - 1);
            mutations.setCurrentTrackIndex(nextIndex);

            // 如果之前在播放，则继续播放新的当前曲目
            if (wasPlaying) {
                mutations.setIsPlaying(true);
            }
        }

    } catch (err) {
        // 用户取消或 IPC 错误
        if (err !== 'cancel') console.error(err);
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