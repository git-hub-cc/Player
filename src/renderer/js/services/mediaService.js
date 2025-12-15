// src/renderer/js/services/mediaService.js

/**
 * @file 媒体服务层 (Media Service)
 * @description
 * 渲染进程的业务逻辑核心和主进程API的适配器。
 * 它是唯一与 `window.electronAPI` 直接通信的模块。
 *
 * 主要职责:
 * 1. 封装所有IPC调用，为上层提供清晰的业务方法。
 * 2. 处理从主进程返回的数据，进行转换和格式化（例如，将文件路径转为media://协议）。
 * 3. 协调复杂的业务流程（如删除、分离音视频），包括用户确认和状态更新。
 * 4. 监听来自主进程的事件（如onNewTrack），并更新全局状态。
 */

import { mutations, getters } from '../state.js';
import * as ui from '../ui.js';
import { pinyin } from 'pinyin-pro';

// --- 私有辅助函数 ---

/**
 * 将后端返回的原始轨道对象转换为前端可用的、包含可播放URL的格式。
 * @private
 * @param {object} track - 后端返回的原始轨道对象。
 * @returns {object} - 包含 pinyin 和可播放路径的完整前端轨道对象。
 */
function _makeTrackPlayable(track) {
    const playableTrack = { ...track };
    const encode = (p) => p ? p.split('/').map(s => encodeURIComponent(s)).join('/') : '';

    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        // 只转换非 http/data 协议的本地相对路径
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
            playableTrack[key] = `media://${encode(value)}`;
        }
    });

    // 补充拼音和首字母信息，确保数据一致性
    const title = track.title || '';
    playableTrack.pinyin = pinyin(title, { toneType: 'none' }).replace(/\s/g, '');
    playableTrack.initials = pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '');

    return playableTrack;
}


// =========================================================================
// --- 公共服务 API ---
// =========================================================================

/**
 * 初始化服务，主要是设置IPC事件监听器。
 */
export function init() {
    // 监听主进程推送的新增轨道事件
    window.electronAPI.onNewTrack((newTrack) => {
        const track = _makeTrackPlayable(newTrack);
        const oldPlaylist = getters.playlist();
        mutations.setPlaylist([track, ...oldPlaylist]);

        if (oldPlaylist.length === 0) {
            mutations.setCurrentTrackIndex(0);
            mutations.setIsPlaying(true);
        } else {
            mutations.setCurrentTrackIndex(getters.currentTrackIndex() + 1);
        }
        ui.showToast(`已添加 "${track.title}" 到媒体库！`);
    });

    console.log("Media Service initialized.");
}

/**
 * 加载应用的初始数据（本地播放列表）。
 */
export async function loadInitialData() {
    try {
        const result = await window.electronAPI.getLocalPlaylist();
        if (result.success && Array.isArray(result.data)) {
            const playlist = result.data.map(_makeTrackPlayable);
            mutations.setPlaylist(playlist);
        }
    } catch (error) {
        console.error("Failed to load initial playlist:", error);
        ui.showToast("加载本地播放列表失败", "error");
    }
}

/**
 * 在线搜索音乐。
 * @param {string} query - 搜索关键词。
 * @param {number} page - 页码。
 * @returns {Promise<object|null>} - 搜索结果或在失败时返回 null。
 */
export async function searchOnline(query, page) {
    try {
        const result = await window.electronAPI.searchOnline(query, page);
        if (result.success) {
            return result.data;
        }
        throw new Error(result.error || "未知搜索错误");
    } catch (error) {
        console.error("Online search failed:", error);
        ui.showToast(`搜索失败: ${error.message}`, "error");
        return null;
    }
}

/**
 * 解析在线曲目的可播放URL和封面。
 * @param {object} trackInfo - 包含 id, source, pic_id 等信息的轨道对象。
 * @returns {Promise<object|null>} - 包含 playableSrc 和 albumArtUrl 的对象，或 null。
 */
export async function resolvePlayableUrl(trackInfo) {
    try {
        const result = await window.electronAPI.getMusicUrl(trackInfo);
        if (result.success && result.url) {
            return {
                playableSrc: result.url,
                albumArtUrl: result.albumArtUrl || trackInfo.albumArt
            };
        }
        throw new Error(result.error || "未能获取播放链接");
    } catch (error) {
        console.error(`Failed to resolve playable URL for "${trackInfo.title}":`, error);
        return null;
    }
}

/**
 * 播放一个临时的在线曲目。
 * @param {object} track - 未完全解析的在线轨道对象。
 */
export async function playTemporaryTrack(track) {
    const resolved = await resolvePlayableUrl(track);
    if (resolved) {
        const playableTrack = {
            ...track,
            src: resolved.playableSrc,
            albumArt: resolved.albumArtUrl,
        };
        mutations.setTemporaryPlayingTrack(playableTrack);
        mutations.setIsPlaying(true);
    } else {
        ui.showToast(`无法播放在线曲目: "${track.title}"`, 'error');
    }
}

/**
 * 请求主进程缓存（下载）一个在线曲目。
 * @param {object} trackData - 在线轨道对象。
 */
export function cacheTrack(trackData) {
    window.electronAPI.cacheTrack(trackData);
}

/**
 * 处理删除曲目的业务流程。
 * @param {number} index - 要删除的轨道在播放列表中的索引。
 */
export async function deleteTrack(index) {
    const track = getters.playlist()[index];
    if (!track) return;

    try {
        await ui.showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);
        const wasPlaying = getters.isPlaying();
        const isDeletingCurrent = getters.currentTrackIndex() === index;

        const decodedRelativeSrc = decodeURIComponent(track.src.substring('media://'.length));
        const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });

        if (!result.success) {
            ui.showToast(result.error, 'error');
            return;
        }

        mutations.removeTrack(index); // 状态变更

        if (getters.playlist().length === 0) {
            mutations.clearPlayingTrackInfo();
        } else if (isDeletingCurrent) {
            const nextIndex = Math.min(index, getters.playlist().length - 1);
            mutations.setCurrentTrackIndex(nextIndex);
            if (wasPlaying) mutations.setIsPlaying(true);
        }
        ui.showToast(`"${track.title}" 已删除`);

    } catch (err) {
        // 用户取消操作，无需提示
    }
}

/**
 * 处理分离音视频的业务流程。
 * @param {number} index - 目标视频在播放列表中的索引。
 */
export async function separateVideo(index) {
    const track = getters.playlist()[index];
    if (!track || track.type !== 'video') return;

    try {
        await ui.showConfirmationModal(`确定要将 "${track.title}" 分离为独立的音视频文件吗？`);
        ui.showToast('正在处理，请稍候...', 'info');
        const result = await window.electronAPI.separateVideo(track);

        if (result.success) {
            const updatedPlaylist = result.data.map(_makeTrackPlayable);
            const currentSrc = getters.currentTrack()?.src;
            const newIndex = updatedPlaylist.findIndex(t => t.src === currentSrc);

            mutations.setPlaylist(updatedPlaylist);
            mutations.setCurrentTrackIndex(newIndex > -1 ? newIndex : 0);
            ui.showToast(result.message || '视频分离成功！', 'success');
        } else {
            ui.showToast(`分离失败: ${result.error}`, 'error');
        }
    } catch (err) {
        // 用户取消操作
    }
}