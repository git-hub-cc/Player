// src/renderer/js/ui.js

/**
 * @file UI 视图层 (View Layer)
 * @description
 * 负责将应用状态渲染到 DOM 上。它是 state 的纯粹订阅者，不包含任何业务逻辑。
 *
 * 工作流程:
 * 1. 初始化时，订阅所有与 UI 相关的状态变更。
 * 2. 当监听到状态变化时，执行对应的 DOM 更新函数，将状态的变化“投影”到界面上。
 * 3. 封装所有独立的 UI 组件逻辑（如 Toast、模态框、面板切换等），使其易于调用和维护。
 */

import * as dom from './dom.js';
import { getters, mutations, subscribe } from './state.js';
import { PLAY_MODES, DEFAULT_ART } from './config.js';
import { getTemplate, formatTime, rgbToHsl, hslToRgb } from './utils.js';

// --- 模块私有状态 ---
let toastTimeout; // 用于 Toast 提示的定时器
let lastActiveLyricIndex = -1; // 上一个高亮的歌词行索引，用于性能优化
let visualizerDataArray = null; // 用于存储音频可视化数据的数组
let seekFeedbackTimeout = null; // 快进/快退UI反馈的定时器
let speedFeedbackTimeout = null; // 播放速度UI反馈的定时器
let animationFrameId = null; // 动画循环的ID，用于启动和停止
let nextBackgroundUpdateTime = 0; // 下一次动态背景更新的时间戳
const BACKGROUND_BEAT_MULTIPLIER = 12; // 背景更新频率与节拍的倍数关系

// =========================================================================
// --- 核心渲染与更新函数 ---
// =========================================================================

/**
 * 启动动画循环，用于驱动音频可视化和动态背景等需要持续更新的视觉效果。
 */
function _runAnimationFrame() {
    // 只有在播放状态下才执行动画逻辑
    if (getters.isPlaying()) {
        const track = getters.currentTrack();
        // 仅在播放音频且分析器可用时绘制可视化效果
        if (getters.analyser() && track?.type === 'audio') {
            _drawVisualizer();
        }

        // 基于节拍的动态背景更新
        const now = performance.now();
        if (track?.beatInterval > 0) {
            if (nextBackgroundUpdateTime === 0) nextBackgroundUpdateTime = now; // 初始化首次更新时间
            if (now >= nextBackgroundUpdateTime) {
                _updateDynamicBackground(track);
                const interval = track.beatInterval * 1000 * BACKGROUND_BEAT_MULTIPLIER;
                // 计算下一次更新时间，确保不会因卡顿而堆积
                nextBackgroundUpdateTime = Math.max(now, nextBackgroundUpdateTime + interval);
            }
        }
    }
    // 递归调用，形成持续的动画循环
    animationFrameId = requestAnimationFrame(_runAnimationFrame);
}

/**
 * 更新动态背景。视频模式下从当前帧提取颜色，音频模式下切换预设的调色板。
 * @param {object} track - 当前轨道对象。
 */
function _updateDynamicBackground(track) {
    if (track.type === 'video') {
        _extractAndApplyGradient(dom.mediaPlayer);
    } else if (track.type === 'audio' && track.colorPalettes?.length > 0) {
        const palettes = track.colorPalettes;
        const index = getters.currentColorPaletteIndex();
        const palette = palettes[index];
        dom.mainView.style.background = `linear-gradient(145deg, ${palette[0]}, ${palette[1]})`;
        // 更新索引，为下一次切换做准备
        mutations.setCurrentColorPaletteIndex((index + 1) % palettes.length);
    }
}

/**
 * 绘制音频可视化效果。
 * 优化了绘图逻辑，确保频谱条从中心向左右两侧对称、同时地绘制。
 */
function _drawVisualizer() {
    const analyser = getters.analyser();
    // 确保所有必需的元素和数据都已就绪
    if (!analyser || !dom.audioVisualizer || !dom.albumArtContainer) return;
    if (!visualizerDataArray) {
        visualizerDataArray = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(visualizerDataArray);

    const canvas = dom.audioVisualizer;
    const ctx = canvas.getContext('2d');
    // 响应式画布尺寸调整
    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }

    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const artSize = dom.albumArtContainer.offsetWidth;
    if (artSize === 0) return; // 如果封面不可见，则不绘制

    const centerX = w / 2, centerY = h / 2, halfSize = artSize / 2;
    const barWidth = 3, maxBarHeight = 100, numBarsPerSide = 64;

    // 根据当前背景色动态计算频谱条颜色
    let startColor, endColor;
    const colors = getters.currentGradientColors();
    if (colors) {
        const hsl = rgbToHsl(...colors[1]); // 使用背景色中的亮色
        // 调整颜色的色相、饱和度和亮度，使其更醒目
        const rgb = hslToRgb((hsl.h + 30) % 360, Math.min(hsl.s + 0.15, 1), Math.min(hsl.l + 0.2, 0.85));
        startColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.3)`;
        endColor = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.8)`;
    } else {
        // 默认颜色
        startColor = 'rgba(29, 185, 84, 0.2)';
        endColor = 'rgba(29, 185, 84, 0.8)';
    }
    ctx.lineWidth = barWidth; ctx.lineCap = 'round';

    const halfPerimeter = halfSize * 2 + artSize; // "U"形路径的总长度（一半）
    const step = halfPerimeter / numBarsPerSide; // 每根频谱条在路径上的步长

    for (let i = 0; i < numBarsPerSide; i++) {
        const dataIndex = Math.floor(i * (visualizerDataArray.length * 0.75) / numBarsPerSide);
        const barHeight = (visualizerDataArray[dataIndex] / 255) ** 2.5 * maxBarHeight;
        if (barHeight < 1) continue; // 忽略过短的条

        const p = i * step; // 当前条在U形路径上的位置
        let x, y, dx, dy; // (x,y)是起点, (dx,dy)是方向向量

        // 计算右半侧 U 形路径上的点和方向
        if (p < halfSize) { // 右下角
            x = centerX + p; y = centerY + halfSize; dx = 0; dy = 1;
        } else if (p < halfSize + artSize) { // 右侧垂直边
            x = centerX + halfSize; y = centerY + halfSize - (p - halfSize); dx = 1; dy = 0;
        } else { // 右上角
            x = centerX + halfSize - (p - (halfSize + artSize)); y = centerY - halfSize; dx = 0; dy = -1;
        }

        // --- 绘制右侧频谱条 ---
        const [sx, sy, ex, ey] = [x, y, x + dx * barHeight, y + dy * barHeight];
        let grad = ctx.createLinearGradient(sx, sy, ex, ey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();

        // --- 绘制左侧镜像的频谱条 ---
        const [msx, msy, mex, mey] = [2 * centerX - sx, sy, 2 * centerX - ex, ey];
        grad = ctx.createLinearGradient(msx, msy, mex, mey);
        grad.addColorStop(0, startColor); grad.addColorStop(1, endColor);
        ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(msx, msy); ctx.lineTo(mex, mey); ctx.stroke();
    }
}

/**
 * 从图像或视频帧中提取关键颜色，并应用为背景渐变。
 * @param {HTMLImageElement|HTMLVideoElement} sourceElement - 颜色来源元素。
 */
function _extractAndApplyGradient(sourceElement) {
    // 检查源元素是否有效且已加载完成
    if (!sourceElement || (sourceElement.tagName === 'IMG' && (!sourceElement.complete || !sourceElement.naturalWidth)) || (sourceElement.tagName === 'VIDEO' && sourceElement.readyState < 2)) {
        mutations.setCurrentGradientColors(null);
        return;
    }
    try {
        // 将源图像绘制到一个小尺寸的离屏Canvas上以提高性能
        const w = dom.bgCanvas.width = 100, h = dom.bgCanvas.height = 100;
        dom.bgCtx.drawImage(sourceElement, 0, 0, w, h);
        // 从左上角和右下角提取两个像素点作为渐变色
        const p1 = dom.bgCtx.getImageData(1, 1, 1, 1).data;
        const p4 = dom.bgCtx.getImageData(w - 2, h - 2, 1, 1).data;
        mutations.setCurrentGradientColors([[p1[0], p1[1], p1[2]], [p4[0], p4[1], p4[2]]]);
    } catch (e) {
        // 捕获跨域等错误，并重置颜色
        mutations.setCurrentGradientColors(null);
    }
}

// =========================================================================
// --- 状态订阅处理函数 (State Subscription Handlers) ---
// =========================================================================

/** 当播放状态改变时，更新UI */
function onIsPlayingChanged(isPlaying) {
    dom.playPauseBtn?.classList.toggle('playing', isPlaying);
    if (dom.playPauseBtn) dom.playPauseBtn.title = isPlaying ? '暂停' : '播放';
    // 如果开始播放且动画循环未运行，则启动它
    if (isPlaying && animationFrameId === null) {
        nextBackgroundUpdateTime = 0;
        _runAnimationFrame();
    }
}

/** 当当前轨道改变时，更新整个播放器视图 */
function onCurrentTrackChanged(track) {
    updateTrackInfoUI(track);
    updatePlaylistActiveItemUI();
    if (track) {
        const isVideo = track.type === 'video';
        // 根据媒体类型切换显示 专辑封面 或 视频播放器
        if (dom.albumArtContainer) dom.albumArtContainer.style.display = isVideo ? 'none' : 'flex';
        if (dom.mediaPlayer) dom.mediaPlayer.style.display = isVideo ? 'block' : 'none';
        dom.playerContainer?.classList.toggle('video-mode', isVideo);
        // 同时切换音频可视化Canvas的可见性
        if (dom.audioVisualizer) dom.audioVisualizer.style.display = isVideo ? 'none' : 'block';
        if (isVideo) {
            dom.mediaPlayer?.addEventListener('canplay', () => _extractAndApplyGradient(dom.mediaPlayer), { once: true });
        } else {
            // 为封面图加载设置事件，加载完成后提取颜色
            dom.albumArtEl.onload = () => _extractAndApplyGradient(dom.albumArtEl);
            // 如果图片已在缓存中，则直接触发
            if (dom.albumArtEl.complete) _extractAndApplyGradient(dom.albumArtEl);
        }
    } else {
        resetPlayerUI();
    }
}

/** 当播放时间更新时，更新进度条和歌词 */
function onTimeChanged({ currentTime, duration }) {
    if (getters.isScrubbing()) return; // 拖动进度条时不更新
    dom.currentTimeEl.textContent = formatTime(currentTime);
    dom.durationEl.textContent = formatTime(duration);
    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    dom.progressBar.value = progress;
    dom.progressBar.style.setProperty('--value-percent', `${progress}%`);
    syncLyrics(currentTime);
}

/** 当音量或静音状态改变时，更新音量条UI */
function onVolumeChanged({ volume, isMuted }) {
    const volumePercent = isMuted ? 0 : volume * 100;
    // 确保 DOM 元素存在再操作，提高鲁棒性
    if (dom.volumeBar) {
        dom.volumeBar.value = isMuted ? 0 : volume;
        dom.volumeBar.style.setProperty('--value-percent', `${volumePercent}%`);
    }
    dom.volumeBtn?.classList.toggle('muted', isMuted || volume === 0);
}


/** 当播放列表数据改变时，重新渲染列表 */
function onPlaylistChanged(playlist) {
    renderPlaylist(playlist);
    updatePlaylistActiveItemUI();
    toggleEmptyState(playlist.length === 0);
}

/** 当播放模式改变时，更新模式按钮的图标和标题 */
function onPlayModeChanged(modeIndex) {
    if (!dom.modeBtn) return;
    const currentMode = PLAY_MODES[modeIndex];
    dom.modeBtn.className = 'control-btn'; // 重置类名
    dom.modeBtn.classList.add(`mode-${currentMode}`);
    const titles = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };
    dom.modeBtn.title = titles[currentMode];
    showToast(`播放模式: ${titles[currentMode]}`);
}

/** 当歌词数据改变时，重新渲染歌词列表 */
function onLyricsChanged(parsedLyrics) {
    if (!dom.lyricsList) return;
    dom.lyricsList.innerHTML = '';
    dom.lyricsList.style.transform = 'translateY(0)';
    if (!parsedLyrics || parsedLyrics.length === 0) {
        dom.lyricsList.appendChild(getTemplate('template-no-lyrics'));
        return;
    }
    const fragment = document.createDocumentFragment();
    parsedLyrics.forEach(line => {
        const p = getTemplate('template-lyric-line').querySelector('p');
        p.textContent = line.text || '...';
        fragment.appendChild(p);
    });
    dom.lyricsList.appendChild(fragment);
    lastActiveLyricIndex = -1; // 重置上次高亮索引
}

/** 当背景渐变色提取成功后，应用到主视图背景 */
function onGradientColorsChanged(colors) {
    if (!dom.mainView) return;
    if (colors) {
        const [c1, c2] = colors;
        dom.mainView.style.background = `linear-gradient(145deg, rgb(${c1.join(',')}), rgb(${c2.join(',')}))`;
    } else {
        dom.mainView.style.background = ''; // 恢复默认背景
    }
}

// =========================================================================
// --- UI 组件与辅助函数 ---
// =========================================================================

/**
 * 将播放器UI重置到初始或空状态。
 */
export function resetPlayerUI() {
    updateTrackInfoUI(null);
    onTimeChanged({ currentTime: 0, duration: 0 });
    onLyricsChanged([]);
    onGradientColorsChanged(null);
    dom.playerContainer?.classList.remove('video-mode');
    if (dom.albumArtContainer) dom.albumArtContainer.style.display = 'flex';
    if (dom.mediaPlayer) dom.mediaPlayer.style.display = 'none';
    if (dom.audioVisualizer) dom.audioVisualizer.style.display = 'block';
}

/**
 * 根据当前轨道信息更新UI（标题、歌手、封面图）。
 * @param {object|null} track - 当前轨道对象，或 null。
 */
export function updateTrackInfoUI(track) {
    dom.trackTitleEl.textContent = track?.title || '选择媒体';
    dom.trackArtistEl.textContent = track?.artist || '开始播放';
    const artUrl = track?.albumArt || DEFAULT_ART;
    if (dom.albumArtEl) dom.albumArtEl.src = artUrl;
    if (dom.controlAlbumArtEl) dom.controlAlbumArtEl.src = artUrl;
}

/**
 * 渲染整个播放列表。
 * @param {Array<object>} playlist - 播放列表数组。
 */
export function renderPlaylist(playlist) {
    if (!dom.playlistEl) return;
    dom.playlistEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    playlist.forEach((track, index) => {
        const itemEl = getTemplate('template-playlist-item').querySelector('.playlist-item');
        itemEl.dataset.index = index;
        itemEl.querySelector('.playlist-icon').textContent = track.type === 'video' ? '🎬' : '🎵';
        itemEl.querySelector('.playlist-title').textContent = track.title;
        itemEl.querySelector('.playlist-artist').textContent = track.artist;
        fragment.appendChild(itemEl);
    });
    // 追加“无结果”的模板项，用于搜索过滤
    fragment.appendChild(getTemplate('template-playlist-no-results'));
    dom.playlistEl.appendChild(fragment);
}

/**
 * 更新播放列表中当前活动项的高亮状态。
 */
export function updatePlaylistActiveItemUI() {
    // 移除旧的高亮
    dom.playlistEl?.querySelector('.active')?.classList.remove('active');
    dom.searchResultsList?.querySelector('.active')?.classList.remove('active');

    const track = getters.currentTrack();
    if (!track) return;

    // 根据是临时曲目还是列表曲目，在高亮不同的列表
    const item = getters.temporaryPlayingTrack()
        ? dom.searchResultsList?.querySelector(`[data-src="${track.originalSrc || track.src}"]`)
        : dom.playlistEl?.querySelector(`[data-index="${getters.currentTrackIndex()}"]`);
    item?.classList.add('active');
}

/**
 * 根据当前播放时间同步歌词滚动和高亮。
 * @param {number} currentTime - 当前播放时间（秒）。
 */
export function syncLyrics(currentTime) {
    const parsedLyrics = getters.parsedLyrics();
    if (getters.isDraggingLyrics() || !parsedLyrics || parsedLyrics.length === 0) return;

    const allLyricLines = dom.getLyricLines();
    // 找到当前时间对应的歌词行索引
    const activeIndex = parsedLyrics.findIndex((line, i) => currentTime >= line.time && (!parsedLyrics[i + 1] || currentTime < parsedLyrics[i + 1].time));

    // 仅在索引变化时更新DOM，优化性能
    if (activeIndex !== -1 && activeIndex !== lastActiveLyricIndex) {
        if (lastActiveLyricIndex !== -1) allLyricLines[lastActiveLyricIndex]?.classList.remove('active');
        allLyricLines[activeIndex]?.classList.add('active');
        lastActiveLyricIndex = activeIndex;
    }

    // 平滑滚动到当前行
    if (activeIndex !== -1 && allLyricLines[activeIndex]) {
        const wrapperHeight = dom.lyricsListWrapper?.clientHeight || 0;
        const lineOffsetTop = allLyricLines[activeIndex].offsetTop;
        const lineHeight = allLyricLines[activeIndex].clientHeight;
        const translateY = wrapperHeight / 2 - lineOffsetTop - lineHeight / 2;
        if(dom.lyricsList) dom.lyricsList.style.transform = `translateY(${translateY}px)`;
    }
}

/**
 * 显示一个短暂的提示消息（Toast）。
 * @param {string} message - 要显示的消息。
 * @param {'info'|'success'|'error'} type - 消息类型。
 */
export function showToast(message, type = 'info') {
    clearTimeout(toastTimeout);
    dom.toastEl.textContent = message;
    dom.toastEl.className = `toast show ${type}`;
    toastTimeout = setTimeout(() => dom.toastEl.classList.remove('show'), 3000);
}

/**
 * 显示快进/快退的视觉反馈。
 * @param {string|number} feedback - 要显示的反馈文本或秒数。
 */
export function showSeekFeedback(feedback) {
    clearTimeout(seekFeedbackTimeout);
    dom.seekFeedbackEl.textContent = typeof feedback === 'number' ? `${feedback > 0 ? '»' : '«'} ${Math.abs(feedback)}s` : feedback;
    dom.seekFeedbackEl.classList.add('visible');
    seekFeedbackTimeout = setTimeout(() => dom.seekFeedbackEl.classList.remove('visible'), 1000);
}

/**
 * 显示播放速度变化的视觉反馈。
 */
export function showSpeedFeedback() {
    clearTimeout(speedFeedbackTimeout);
    dom.speedFeedbackEl.textContent = `${getters.playbackRate().toFixed(1)}x`;
    dom.speedFeedbackEl.classList.add('visible');
    speedFeedbackTimeout = setTimeout(() => dom.speedFeedbackEl.classList.remove('visible'), 1500);
}

/**
 * 显示一个确认对话框。
 * @param {string} message - 对话框内容。
 * @param {object} [options] - 配置项，如按钮文本。
 * @returns {Promise<void>} - 用户点击确认时 resolve，点击取消时 reject。
 */
export function showConfirmationModal(message, options = {}) {
    return new Promise((resolve, reject) => {
        dom.confirmationMessage.textContent = message;
        dom.confirmBtn.textContent = options.confirmText || '确认';
        dom.cancelBtn.textContent = options.cancelText || '取消';
        dom.confirmationModal?.classList.add('visible');

        const cleanup = (cb) => {
            dom.confirmationModal?.classList.remove('visible');
            removeListeners();
            cb();
        };

        const onConfirm = () => cleanup(resolve);
        const onCancel = () => cleanup(() => reject('cancel'));

        const removeListeners = () => {
            dom.confirmBtn?.removeEventListener('click', onConfirm);
            dom.cancelBtn?.removeEventListener('click', onCancel);
        };

        dom.confirmBtn?.addEventListener('click', onConfirm, { once: true });
        dom.cancelBtn?.addEventListener('click', onCancel, { once: true });
    });
}

/**
 * 切换空状态视图的显示。
 * @param {boolean} isEmpty - 是否显示空状态。
 */
export function toggleEmptyState(isEmpty) {
    dom.mainView?.classList.toggle('is-empty', isEmpty);
    dom.playerControls?.classList.toggle('disabled', isEmpty);
    if (isEmpty) {
        resetPlayerUI();
    }
}

/**
 * 根据搜索关键词过滤播放列表的显示。
 */
export function filterPlaylist() {
    const query = dom.playlistSearchInput?.value.toLowerCase().replace(/\s/g, '') || '';
    let hasVisibleItems = false;
    const playlist = getters.playlist();

    dom.getAllPlaylistItems().forEach((item) => {
        const index = parseInt(item.dataset.index, 10);
        const track = playlist[index];
        if (!track) return;

        // 匹配逻辑：标题、歌手、全拼、首字母
        const isMatch = !query ||
            (track.title || '').toLowerCase().includes(query) ||
            (track.artist || '').toLowerCase().includes(query) ||
            track.pinyin.includes(query) ||
            track.initials.includes(query);

        item.classList.toggle('hidden', !isMatch);
        if (isMatch) hasVisibleItems = true;
    });

    const noResultsEl = document.getElementById('playlist-no-results');
    if (noResultsEl) {
        noResultsEl.style.display = hasVisibleItems ? 'none' : 'block';
    }
}

/**
 * 清空搜索结果列表。
 */
export function clearSearchResults() {
    if (dom.searchResultsList) dom.searchResultsList.innerHTML = '';
}

/**
 * 创建单个搜索结果项的 DOM 元素。
 * @param {object} track - 轨道数据。
 * @param {number} index - 轨道索引。
 * @param {boolean} [isCached=false] - 是否已缓存。
 * @returns {DocumentFragment} - 包含列表项的文档片段。
 */
function createResultItem(track, index, isCached = false) {
    const itemNode = getTemplate('template-search-result-item');
    const itemEl = itemNode.querySelector('.playlist-item');
    itemEl.dataset.index = index;
    itemEl.dataset.src = track.originalSrc || track.src; // 存储唯一标识符
    itemEl.querySelector('.playlist-icon').textContent = '🎵';
    itemEl.querySelector('.playlist-title').textContent = track.title || '未知标题';
    itemEl.querySelector('.playlist-artist').textContent = track.artist || '未知艺术家';

    // 动态加载SVG图标
    const placeholders = itemEl.querySelectorAll('.icon-placeholder');
    placeholders.forEach(ph => {
        const iconName = ph.dataset.icon;
        if (iconName === 'DOWNLOAD') ph.outerHTML = `<svg class="download-icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`;
        if (iconName === 'SPINNER') ph.outerHTML = `<svg class="spinner-icon" viewBox="0 0 24 24"><path d="M12,4a8,8,0,0,1,7.89,6.7A1.53,1.53,0,0,0,21.38,12h0a1.5,1.5,0,0,0,1.48-1.75,11,11,0,0,0-21.72,0A1.5,1.5,0,0,0,2.62,12h0a1.53,1.53,0,0,0,1.49-1.3A8,8,0,0,1,12,4Z"></path></svg>`;
        if (iconName === 'CACHED') ph.outerHTML = `<svg class="cached-icon" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>`;
    });

    const downloadBtn = itemEl.querySelector('.playlist-download-btn');
    downloadBtn.classList.toggle('cached', isCached);
    return itemNode;
}

/**
 * 渲染在线搜索结果。
 * @param {Array<object>} tracks - 搜索结果轨道数组。
 */
export function renderSearchResults(tracks) {
    clearSearchResults();
    const fragment = document.createDocumentFragment();
    const localPlaylist = getters.playlist();
    tracks.forEach((track, index) => {
        // 检查该在线曲目是否已被缓存到本地
        const isAlreadyInPlaylist = localPlaylist.some(pTrack =>
            pTrack.id === track.id && pTrack.source === track.source && !pTrack.src.startsWith('http')
        );
        fragment.appendChild(createResultItem(track, index, isAlreadyInPlaylist));
    });
    dom.searchResultsList?.appendChild(fragment);
}

/**
 * 更新单个搜索结果项的下载状态（例如：下载中、已缓存）。
 * @param {HTMLElement} itemElement - 列表项元素。
 * @param {'downloading'|'cached'|'default'} status - 新的状态。
 */
export function updateSearchResultItemStatus(itemElement, status) {
    const downloadBtn = itemElement?.querySelector('.playlist-download-btn');
    if (!downloadBtn) return;
    downloadBtn.classList.remove('downloading', 'cached');
    if (status === 'downloading') downloadBtn.classList.add('downloading');
    else if (status === 'cached') downloadBtn.classList.add('cached');
}

/**
 * 渲染分页控制按钮。
 * @param {number} currentPage - 当前页码。
 * @param {number} totalPages - 总页数。
 */
export function renderPaginationControls(currentPage, totalPages) {
    const container = dom.paginationControls;
    if (!container) return;
    container.innerHTML = '';
    if (totalPages <= 1) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = `
        <button id="prev-page-btn" class="pagination-btn" title="上一页" ${currentPage <= 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path></svg>
        </button>
        <span class="page-info">${currentPage} / ${totalPages}</span>
        <button id="next-page-btn" class="pagination-btn" title="下一页" ${currentPage >= totalPages ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"></path></svg>
        </button>
    `;
}

/**
 * 隐藏上下文菜单。
 */
export function hideContextMenu() {
    if (dom.contextMenu) dom.contextMenu.style.display = 'none';
}

/**
 * 渲染上下文菜单。
 * @param {object} [context={}] - 上下文信息，如点击的元素类型和索引。
 */
export function renderContextMenu(context = {}) {
    const menuList = dom.getContextMenuList();
    if (!menuList) return;
    menuList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const playlist = getters.playlist();

    if (context.type === 'playlist-item' && typeof context.index !== 'undefined') {
        const track = playlist[context.index];
        // 动态添加菜单项
        if (track?.type === 'video') {
            const li = document.createElement('li');
            li.textContent = '分离音视频';
            li.dataset.action = 'separate-video';
            li.dataset.index = context.index;
            fragment.appendChild(li);
        }
        const li = document.createElement('li');
        li.textContent = '删除';
        li.dataset.action = 'delete-track';
        li.dataset.index = context.index;
        fragment.appendChild(li);
    }
    menuList.appendChild(fragment);
}

/**
 * 关闭所有活动的侧边面板。
 */
export function closeActivePanels() {
    dom.allSidePanels.forEach(panel => panel?.classList.remove('active'));
    dom.moreOptionsMenu?.classList.remove('visible');
}

/**
 * 管理侧边面板的显示与隐藏，确保同一时间只有一个面板打开。
 * @param {HTMLElement} panelToToggle - 要切换的面板元素。
 */
function manageSidePanel(panelToToggle) {
    if (!panelToToggle) return;
    const isActive = panelToToggle.classList.contains('active');
    closeActivePanels();
    if (!isActive) {
        panelToToggle.classList.add('active');
    }
}

/**
 * 切换“更多选项”菜单的可见性。
 */
export function toggleMoreOptionsMenu() {
    if (dom.allSidePanels.some(p => p.classList.contains('active'))) {
        closeActivePanels();
    }
    dom.moreOptionsMenu?.classList.toggle('visible');
}

/**
 * 切换各个面板的显示状态。
 */
export function toggleLyricsPanel() { dom.lyricsContainer?.classList.toggle('active'); }
export function togglePlaylistPanel() { manageSidePanel(dom.playlistPanel); }
export function toggleInfoPanel() { manageSidePanel(dom.infoPanel); }
export function toggleShortcutPanel() { manageSidePanel(dom.shortcutPanel); }
export function toggleDownloadPanel() { manageSidePanel(dom.downloadPanel); }

/**
 * 初始化歌词拖拽交互。
 */
export function setupLyricsDragHandler() {
    let wasPlayingBeforeDrag = false;
    let dragStartY = 0;
    let initialTranslateY = 0;
    let targetTimeOnDragEnd = 0;

    function onLyricsDragStart(e) {
        if (getters.parsedLyrics().length === 0 || e.button !== 0) return;
        e.preventDefault();
        mutations.setIsDraggingLyrics(true);
        wasPlayingBeforeDrag = getters.isPlaying();
        if (wasPlayingBeforeDrag) mutations.setIsPlaying(false);

        dom.lyricsList?.classList.add('dragging');
        dom.lyricsDragIndicator?.classList.add('active');
        dragStartY = e.clientY;
        const transform = dom.lyricsList.style.transform;
        initialTranslateY = transform ? parseFloat(transform.match(/-?[\d.]+/)[0]) : 0;
        window.addEventListener('mousemove', onLyricsDragMove);
        window.addEventListener('mouseup', onLyricsDragEnd);
    }

    function onLyricsDragMove(e) {
        if (!getters.isDraggingLyrics()) return;
        e.preventDefault();
        dom.lyricsList.style.transform = `translateY(${initialTranslateY + e.clientY - dragStartY}px)`;
        const centerLineY = dom.lyricsListWrapper.getBoundingClientRect().top + dom.lyricsListWrapper.clientHeight / 2;
        let closestIndex = -1, minDistance = Infinity;

        // 寻找离中心线最近的歌词行
        dom.getLyricLines().forEach((line, index) => {
            const lineRect = line.getBoundingClientRect();
            const distance = Math.abs((lineRect.top + lineRect.height / 2) - centerLineY);
            if (distance < minDistance) {
                minDistance = distance;
                closestIndex = index;
            }
        });

        // 更新拖拽指示器的时间
        if (closestIndex !== -1 && getters.parsedLyrics()[closestIndex]) {
            targetTimeOnDragEnd = getters.parsedLyrics()[closestIndex].time;
            dom.lyricsDragTime.textContent = formatTime(targetTimeOnDragEnd);
        }
    }

    function onLyricsDragEnd(e) {
        if (!getters.isDraggingLyrics()) return;
        e.preventDefault();
        mutations.setIsDraggingLyrics(false);
        dom.lyricsList?.classList.remove('dragging');
        dom.lyricsDragIndicator?.classList.remove('active');
        window.removeEventListener('mousemove', onLyricsDragMove);
        window.removeEventListener('mouseup', onLyricsDragEnd);

        // 跳转到目标时间
        if (targetTimeOnDragEnd >= 0) {
            window.dispatchEvent(new CustomEvent('seekTo', { detail: targetTimeOnDragEnd }));
        }
        if (wasPlayingBeforeDrag) mutations.setIsPlaying(true);
        syncLyrics(getters.currentTime()); // 立即同步一次UI
    }

    dom.lyricsListWrapper?.addEventListener('mousedown', onLyricsDragStart);
}

// --- 初始化 ---
export function init() {
    // 订阅所有与UI相关的状态变化
    subscribe('isPlayingChanged', onIsPlayingChanged);
    subscribe('currentTrackChanged', onCurrentTrackChanged);
    subscribe('timeChanged', onTimeChanged);
    subscribe('volumeChanged', onVolumeChanged);
    subscribe('playlistChanged', onPlaylistChanged);
    subscribe('playModeChanged', onPlayModeChanged);
    subscribe('lyricsChanged', onLyricsChanged);
    subscribe('gradientColorsChanged', onGradientColorsChanged);

    // =========================================================================
    // 【核心修复】初始化时，立即根据当前状态设置UI。
    // 这确保了应用加载时，播放模式按钮和音量条能正确显示其初始状态。
    // =========================================================================
    onPlayModeChanged(getters.currentModeIndex());
    onVolumeChanged({ volume: getters.volume(), isMuted: getters.isMuted() });
    // =========================================================================

    // 监听来自其他模块派发的自定义UI事件
    window.addEventListener('showSkeleton', () => dom.skeletonOverlay?.classList.add('active'));
    window.addEventListener('hideSkeleton', () => dom.skeletonOverlay?.classList.remove('active'));
    window.addEventListener('showToast', (e) => showToast(e.detail.message, e.detail.type));

    // 初始化交互逻辑
    setupLyricsDragHandler();

    console.log("UI View initialized.");
}