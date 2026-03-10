// src/renderer/composables/useMediaService.js
/**
 * @file 媒体服务 Composable
 * @description 包装 mediaService.js，使其使用 Pinia store 而非旧的 state.js。
 * 在 App.vue 中初始化一次。
 */

import { usePlayerStore } from '../stores/playerStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { getMediaElement } from './usePlayer.js';
import { pinyin } from 'pinyin-pro';
import path from 'path-browserify';
import { DEFAULT_ART, FILTER_MODES } from '../js/config.js';

const CACHE_EXPIRATION_MS = 30 * 60 * 1000;
const CACHE_MAX_SIZE = 500;
const apiCache = new Map();
const inFlightRequests = new Set();

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

export function useMediaService() {
    const playerStore = usePlayerStore();
    const uiStore = useUiStore();

    function init() {
        window.electronAPI.onNewTrack((newTrack) => {
            const wasEmpty = playerStore.playlist.length === 0;
            if (wasEmpty) {
                uiStore.showToast(`"${newTrack.title}" 已添加！正在刷新媒体库...`, 'success');
                setTimeout(() => window.location.reload(), 1500);
                return;
            }
            const track = _makeTrackPlayable(newTrack);
            playerStore.prependTrackWhilePlaying(track);
            uiStore.showToast(`已添加 "${track.title}" 到媒体库！`, 'success');
        });
    }

    async function loadInitialData() {
        try {
            const result = await window.electronAPI.getLocalPlaylist();
            if (result.success && Array.isArray(result.data)) {
                playerStore.setPlaylist(result.data.map(_makeTrackPlayable));
            } else {
                throw new Error(result.error || '无法加载播放列表');
            }
        } catch (error) {
            console.error('加载初始播放列表失败:', error);
            uiStore.showToast('加载本地播放列表失败', 'error');
        }
    }

    async function searchOnline(query, page) {
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
            uiStore.showToast('正在搜索中，请勿频繁操作...', 'info');
            return null;
        }
        try {
            inFlightRequests.add(requestKey);
            const result = await window.electronAPI.searchOnline(query, page);
            if (result.success) {
                if (apiCache.size >= CACHE_MAX_SIZE) {
                    apiCache.delete(apiCache.keys().next().value);
                }
                apiCache.set(requestKey, { data: result.data, timestamp: Date.now() });
                return result.data;
            } else {
                throw new Error(result.error || '未知搜索错误');
            }
        } catch (error) {
            uiStore.showToast(`搜索失败: ${error.message}`, 'error');
            return null;
        } finally {
            inFlightRequests.delete(requestKey);
        }
    }

    async function resolvePlayableUrl(trackInfo) {
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
            throw new Error(result.error || '未能获取播放链接');
        } catch (error) {
            console.error(`解析 "${trackInfo.title}" 的播放URL失败:`, error);
            return null;
        }
    }

    async function playTemporaryTrack(track) {
        const placeholderTrack = { ...track, src: '', albumArt: track.albumArt || DEFAULT_ART, isLoading: true };
        playerStore.setTemporaryPlayingTrack(placeholderTrack);
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
                playerStore.setTemporaryPlayingTrack(playableTrack);
                playerStore.setIsPlaying(true);
            } else {
                uiStore.showToast(`无法播放: "${track.title}"`, 'error');
            }
        } catch (error) {
            uiStore.showToast(`播放出错: ${error.message}`, 'error');
        }
    }

    function cacheTrack(trackData) {
        window.electronAPI.cacheTrack(trackData);
    }

    async function deleteTrack(index) {
        const track = playerStore.playlist[index];
        if (!track) return;
        try {
            await uiStore.showConfirmationModal(`确定要删除 "${track.title}" 吗？\n文件将从磁盘中永久移除。`);

            const wasPlaying = playerStore.isPlaying;
            const isDeletingCurrent = playerStore.currentTrackIndex === index;
            const decodedRelativeSrc = decodeURIComponent(track.src.substring('media://'.length));

            const sendDeleteRequest = async () => {
                const result = await window.electronAPI.deleteTrack({ src: decodedRelativeSrc });
                if (!result.success) {
                    uiStore.showToast(result.error || '文件删除失败，可能仍被占用', 'error');
                    setTimeout(() => window.location.reload(), 1500);
                    return;
                }
                playerStore.removeTrack(index);
                uiStore.showToast(`"${track.title}" 已删除`);
                if (playerStore.playlist.length === 0) {
                    setTimeout(() => window.location.reload(), 1500);
                    return;
                }
                if (isDeletingCurrent) {
                    const nextIndex = Math.min(index, playerStore.playlist.length - 1);
                    playerStore.setCurrentTrackIndex(nextIndex, true);
                    if (wasPlaying) playerStore.setIsPlaying(true);
                }
            };

            if (isDeletingCurrent) {
                const mediaEl = getMediaElement();
                await new Promise(resolve => {
                    mediaEl.addEventListener('emptied', async () => {
                        await sendDeleteRequest();
                        resolve();
                    }, { once: true });
                    playerStore.setIsPlaying(false);
                    mediaEl.removeAttribute('src');
                    mediaEl.load();
                });
            } else {
                await sendDeleteRequest();
            }
        } catch (err) {
            if (err !== 'cancel') {
                uiStore.showToast('操作失败，请查看控制台日志', 'error');
            }
        }
    }

    async function separateVideo(index) {
        const track = playerStore.playlist[index];
        if (!track || track.type !== 'video') return;
        try {
            await uiStore.showConfirmationModal(`确定要将 "${track.title}" 分离为独立的音视频文件吗？`);
            uiStore.showToast('正在处理，请稍候...', 'info');
            const result = await window.electronAPI.separateVideo(track);
            if (result.success) {
                const updatedPlaylist = result.data.map(_makeTrackPlayable);
                const currentSrc = playerStore.currentTrack?.src;
                const newIndex = updatedPlaylist.findIndex(t => t.src === currentSrc);
                playerStore.setPlaylist(updatedPlaylist);
                playerStore.setCurrentTrackIndex(newIndex > -1 ? newIndex : 0);
                uiStore.showToast(result.message || '视频分离成功！', 'success');
            } else {
                uiStore.showToast(`分离失败: ${result.error}`, 'error');
            }
        } catch { }
    }

    function playFileFromPath(filePath) {
        if (!filePath) return;
        try {
            const ext = path.extname(filePath).toLowerCase();
            const baseName = path.basename(filePath, ext);
            const videoExts = ['.mp4', '.mkv', '.webm'];
            const audioExts = ['.mp3', '.flac', '.wav', '.m4a', '.ogg'];
            let type = 'unknown';
            if (videoExts.includes(ext)) type = 'video';
            else if (audioExts.includes(ext)) type = 'audio';
            else { uiStore.showToast(`不支持的文件类型: ${ext}`, 'error'); return; }
            const newTrack = {
                title: baseName, artist: '本地文件',
                src: `file://${filePath.replace(/\\/g, '/')}`,
                albumArt: '', lyrics: '', type: type, isExternal: true,
            };
            playerStore.setTemporaryPlayingTrack(newTrack);
            playerStore.setIsPlaying(true);
            uiStore.showToast(`正在播放: ${newTrack.title}`);
        } catch (error) {
            uiStore.showToast(`无法播放文件: ${error.message}`, 'error');
        }
    }

    return {
        init, loadInitialData, searchOnline, resolvePlayableUrl,
        playTemporaryTrack, cacheTrack, deleteTrack, separateVideo, playFileFromPath,
        makeTrackPlayable: _makeTrackPlayable,
    };
}
