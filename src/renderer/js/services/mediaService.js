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

// --- 缓存与请求锁定配置 ---
const CACHE_EXPIRATION_MS = 30 * 60 * 1000; // 缓存过期时间: 30分钟
const CACHE_MAX_SIZE = 500; // 最大缓存条目数
const apiCache = new Map(); // 使用Map实现API数据缓存
const inFlightRequests = new Set(); // 使用Set跟踪正在进行的API请求

// --- 私有辅助函数 ---

/**
 * 将从主进程接收到的轨道对象转换为渲染进程可直接播放的格式。
 * 主要处理本地文件路径，将其转换为自定义的 'media://' 协议。
 * @param {object} track - 原始轨道对象。
 * @returns {object} - 转换后的可播放轨道对象。
 * @private
 */
function _makeTrackPlayable(track) {
    const playableTrack = { ...track };
    // 辅助函数，用于安全地编码路径的各个部分
    const encode = (p) => p ? p.split('/').map(s => encodeURIComponent(s)).join('/') : '';

    // 转换 src, albumArt, lyrics 字段
    ['src', 'albumArt', 'lyrics'].forEach(key => {
        const value = playableTrack[key];
        // 仅转换非http、非data URL的本地相对路径
        if (value && !value.startsWith('http') && !value.startsWith('data:')) {
            playableTrack[key] = `media://${encode(value)}`;
        }
    });

    // 生成拼音和首字母，用于搜索
    const title = track.title || '';
    playableTrack.pinyin = pinyin(title, { toneType: 'none' }).replace(/\s/g, '');
    playableTrack.initials = pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '');

    return playableTrack;
}

// =========================================================================
// --- 公共服务 API ---
// =========================================================================

/**
 * 初始化媒体服务，主要负责监听主进程推送的新轨道事件。
 */
export function init() {
    window.electronAPI.onNewTrack((newTrack) => {
        // =========================================================================
        // 【核心修改】检查当前播放列表是否为空，若为空则自动刷新
        // =========================================================================
        const wasEmpty = getters.playlist().length === 0;

        if (wasEmpty) {
            // 如果这是添加的第一首歌曲，则自动重新加载页面，
            // 以确保UI从“空状态”正确过渡到“播放状态”。
            showToast(`"${newTrack.title}" 已添加！正在刷新媒体库...`, 'success');
            setTimeout(() => window.location.reload(), 1500); // 延迟一点给用户看提示
            return; // 阻止后续代码执行
        }
        // =========================================================================

        // 如果播放列表不为空，则执行常规的动态更新逻辑
        const track = _makeTrackPlayable(newTrack);
        const oldPlaylist = getters.playlist();

        // 将新轨道添加到播放列表的开头
        mutations.setPlaylist([track, ...oldPlaylist]);

        // 保持当前播放的歌曲不变（通过增加索引）
        const newCurrentIndex = getters.currentTrackIndex() + 1;
        mutations.setCurrentTrackIndex(newCurrentIndex);

        showToast(`已添加 "${track.title}" 到媒体库！`, 'success');
    });
    console.log("Media Service initialized.");
}


/**
 * 加载应用的初始数据，即本地播放列表。
 */
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
        console.error("加载初始播放列表失败:", error);
        showToast("加载本地播放列表失败", "error");
    }
}

/**
 * 执行在线搜索，包含缓存和请求锁定逻辑。
 * @param {string} query - 搜索关键词。
 * @param {number} page - 页码。
 * @returns {Promise<object|null>} - 成功时返回搜索结果数据，否则返回 null。
 */
export async function searchOnline(query, page) {
    const requestKey = `${query}_${page}`;
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
 * @param {object} trackInfo - 包含id和source的轨道信息。
 * @returns {Promise<object|null>} - 成功时返回包含 playableSrc 和 albumArtUrl 的对象。
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
        console.error(`解析 "${trackInfo.title}" 的播放URL失败:`, error);
        return null;
    }
}

/**
 * 临时播放在线搜索结果中的曲目。
 * @param {object} track - 从搜索结果中选择的轨道对象。
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
        showToast(`无法播放在线曲目: "${track.title}"`, 'error');
    }
}

/**
 * 请求主进程缓存（下载）一个在线曲目。
 * @param {object} trackData - 要缓存的轨道数据。
 */
export function cacheTrack(trackData) {
    window.electronAPI.cacheTrack(trackData);
}

/**
 * 删除本地媒体库中的一个曲目（包括文件）。
 * @param {number} index - 要删除的曲目在播放列表中的索引。
 */
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
        showToast(`"${track.title}" 已删除`);

        // =========================================================================
        // 【核心修改】当删除最后一首歌后，自动刷新页面以返回欢迎页。
        // =========================================================================
        if (getters.playlist().length === 0) {
            // 短暂延迟后刷新，让用户看到“已删除”的提示
            setTimeout(() => window.location.reload(), 1500);
            return; // 刷新将重置状态，无需再手动更新播放状态
        }
        // =========================================================================

        // 如果列表不为空，则更新播放状态
        if (isDeletingCurrent) {
            const nextIndex = Math.min(index, getters.playlist().length - 1);
            mutations.setCurrentTrackIndex(nextIndex);
            if (wasPlaying) mutations.setIsPlaying(true);
        }

    } catch (err) {
        // 用户点击了“取消”，无需任何操作
    }
}

/**
 * 请求主进程将一个视频文件分离为独立的音频和视频文件。
 * @param {number} index - 视频轨道在播放列表中的索引。
 */
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