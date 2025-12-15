// src/renderer/js/services/mediaService.js

/**
 * @file 媒体服务层 (Media Service)
 * @description
 * 渲染进程的业务逻辑核心和主进程API的适配器。
 */

import { mutations, getters } from '../state.js';
import { showToast, showConfirmationModal } from '../ui/modals.js';
import { pinyin } from 'pinyin-pro';

// --- 私有辅助函数 ---

function _makeTrackPlayable(track) {
    const playableTrack = { ...track };
    const encode = (p) => p ? p.split('/').map(s => encodeURIComponent(s)).join('/') : '';
    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
            playableTrack[key] = `media://${encode(value)}`;
        }
    });
    const title = track.title || '';
    playableTrack.pinyin = pinyin(title, { toneType: 'none' }).replace(/\s/g, '');
    playableTrack.initials = pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '');
    return playableTrack;
}

// =========================================================================
// --- 公共服务 API ---
// =========================================================================

export function init() {
    window.electronAPI.onNewTrack((newTrack) => {
        const track = _makeTrackPlayable(newTrack);
        const oldPlaylist = getters.playlist();
        mutations.setPlaylist([track, ...oldPlaylist]);

        // 如果原列表为空，直接播放新曲目，否则在当前播放位置后插入
        if (oldPlaylist.length === 0) {
            mutations.setCurrentTrackIndex(0);
            mutations.setIsPlaying(true);
        } else {
            // 确保当前索引在新列表中有效
            const newCurrentIndex = getters.currentTrackIndex() + 1;
            mutations.setCurrentTrackIndex(newCurrentIndex);
        }
        showToast(`已添加 "${track.title}" 到媒体库！`, 'success');
    });
    console.log("Media Service initialized.");
}

export async function loadInitialData() {
    try {
        const result = await window.electronAPI.getLocalPlaylist();
        if (result.success && Array.isArray(result.data)) {
            const playlist = result.data.map(_makeTrackPlayable);
            mutations.setPlaylist(playlist);
        } else {
            throw new Error(result.error || '无法加载播放列表');
        }
    } catch (error) {
        console.error("Failed to load initial playlist:", error);
        showToast("加载本地播放列表失败", "error");
    }
}

export async function searchOnline(query, page) {
    try {
        const result = await window.electronAPI.searchOnline(query, page);
        if (result.success) return result.data;
        throw new Error(result.error || "未知搜索错误");
    } catch (error) {
        console.error("Online search failed:", error);
        showToast(`搜索失败: ${error.message}`, "error");
        return null;
    }
}

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
        showToast(`无法播放在线曲目: "${track.title}"`, 'error');
    }
}

export function cacheTrack(trackData) {
    window.electronAPI.cacheTrack(trackData);
}

export async function deleteTrack(index) {
    const track = getters.playlist()[index];
    if (!track) return;
    try {
        await showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);
        const wasPlaying = getters.isPlaying();
        const isDeletingCurrent = getters.currentTrackIndex() === index;

        const decodedRelativeSrc = decodeURIComponent(track.src.substring('media://'.length));
        const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });

        if (!result.success) {
            showToast(result.error, 'error');
            return;
        }

        mutations.removeTrack(index);

        if (getters.playlist().length === 0) {
            mutations.clearPlayingTrackInfo();
        } else if (isDeletingCurrent) {
            const nextIndex = Math.min(index, getters.playlist().length - 1);
            mutations.setCurrentTrackIndex(nextIndex);
            if (wasPlaying) mutations.setIsPlaying(true);
        }
        showToast(`"${track.title}" 已删除`);
    } catch (err) {
        // 用户取消操作，无需提示
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
    } catch (err) {
        // 用户取消操作
    }
}