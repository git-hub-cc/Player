document.addEventListener('DOMContentLoaded', () => {
    // --- 1. DOM 元素获取 ---
    const playerContainer = document.querySelector('.player-container');
    const mainView = document.querySelector('.main-view');
    const mediaPlayer = document.getElementById('media-player');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const progressBar = document.getElementById('progress-bar');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    const trackTitleEl = document.getElementById('track-title');
    const trackArtistEl = document.getElementById('track-artist');
    const albumArtEl = document.getElementById('album-art');
    const controlAlbumArtEl = document.getElementById('control-album-art');
    const albumArtContainer = document.getElementById('album-art-container');
    const lyricsBtn = document.getElementById('lyrics-btn');
    const lyricsContainer = document.getElementById('lyrics-container');
    const lyricsList = document.getElementById('lyrics-list');
    const volumeBtn = document.getElementById('volume-btn');
    const volumeBar = document.getElementById('volume-bar');
    const playlistEl = document.getElementById('playlist');
    const playlistPanel = document.getElementById('playlist-panel');
    const playlistBtn = document.getElementById('playlist-btn');
    const closePlaylistBtn = document.getElementById('close-playlist-btn');
    const infoBtn = document.getElementById('info-btn');
    const infoPanel = document.getElementById('info-panel');
    const closeInfoBtn = document.getElementById('close-info-btn');
    const mobilePlaylistBtn = document.getElementById('mobile-playlist-btn');
    const mobileLyricsBtn = document.getElementById('mobile-lyrics-btn');
    const skeletonOverlay = document.getElementById('skeleton-overlay');
    const shortcutBtn = document.getElementById('shortcut-btn');
    const shortcutPanel = document.getElementById('shortcut-panel');
    const closeShortcutBtn = document.getElementById('close-shortcut-btn');
    const shortcutListEl = document.getElementById('shortcut-list');
    const shortcutModalOverlayEl = document.getElementById('shortcut-modal-overlay');
    const shortcutKeyPreviewEl = document.getElementById('shortcut-key-preview');
    const toastEl = document.getElementById('toast-notification');
    const modeBtn = document.getElementById('mode-btn');
    const playlistSearchInput = document.getElementById('playlist-search');
    const immersiveBtn = document.getElementById('immersive-btn');

    const DEFAULT_ART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI0IzQjNCMyI+PHBhdGggZD0iTTEyIDNBOS45OSA5Ljk5IDAgMCAwIDIgMTJoLjAyYzAgNC45NyA0LjAzIDkgOC45OCA5czguOTgtNC4wMyA4Ljk4LTlBOS45OSA5Ljk5IDAgMCAwIDEyIDptMCAxNmMyLjYyIDAgNC43NS0yLjEyIDQuNzUtNC43NVMyMSAxMC42MyAyMSAxMGMwLTEuMDQtLjM1LTEuOTktLjkzLTIuNzlsLTYgNEMxMy40MyAxNy42NSA5LjUgMTYgOS41IDEyLjVDOS41IDguMzYgMTIuODYgNSA5LjUgNSBjLTEuOTggMC0zLjY5Ljg1LTQuNzggMi4yMkw2LjA4IDZDNy41IDQuMzQgOS42MiAzIDEyIDN6bS0uNS00YzEuMzggMCAyLjUtMS4xMiAyLjUtMi41UzEzLjg4IDUgMTIuNSA1IDcgNi4xMiA3IDcuNXMyLjEyIDIuNSAyLjUgMi41eiIvPjwvc3ZnPg==";

    // --- 2. 状态管理 ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false;
    let parsedLyrics = [];
    let toastTimeout;
    const PLAY_MODES = ['list', 'single', 'shuffle'];
    let currentModeIndex = 0;

    // --- 3. 背景色提取功能 ---
    const bgCanvas = document.createElement('canvas');
    const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
    function extractAndApplyGradient(sourceElement) {
        if (!sourceElement || (sourceElement.tagName === 'IMG' && (!sourceElement.complete || sourceElement.naturalWidth === 0)) || (sourceElement.tagName === 'VIDEO' && sourceElement.readyState < 2)) {
            resetMainViewBackground();
            return;
        }
        try {
            const w = bgCanvas.width = 100;
            const h = bgCanvas.height = 100;
            bgCtx.drawImage(sourceElement, 0, 0, w, h);
            const p1 = bgCtx.getImageData(1, 1, 1, 1).data;
            const p2 = bgCtx.getImageData(w - 2, 1, 1, 1).data;
            const p3 = bgCtx.getImageData(1, h - 2, 1, 1).data;
            const p4 = bgCtx.getImageData(w - 2, h - 2, 1, 1).data;
            const color1 = `rgba(${p1[0]}, ${p1[1]}, ${p1[2]}, 0.8)`;
            const color2 = `rgba(${p2[0]}, ${p2[1]}, ${p2[2]}, 0.7)`;
            const color3 = `rgba(${p3[0]}, ${p3[1]}, ${p3[2]}, 0.7)`;
            const color4 = `rgba(${p4[0]}, ${p4[1]}, ${p4[2]}, 0.8)`;
            mainView.style.background = `linear-gradient(145deg, ${color1}, ${color2} 45%, ${color3} 55%, ${color4}), #121212`;
        } catch (e) {
            console.error("Error extracting colors:", e);
            resetMainViewBackground();
        }
    }
    function resetMainViewBackground() {
        mainView.style.background = '';
    }

    // --- 4. 骨架屏显示/隐藏函数 ---
    function showSkeleton() {
        playerContainer.classList.add('loading');
        skeletonOverlay.classList.add('active');
    }
    function hideSkeleton() {
        skeletonOverlay.classList.remove('active');
        playerContainer.classList.remove('loading');
    }

    // --- 5. 核心播放器功能 ---
    async function loadTrack(trackIndex) {
        if (playlist.length === 0) return;
        showSkeleton();
        currentTrackIndex = trackIndex;
        const track = playlist[trackIndex];

        trackTitleEl.textContent = track.title || "未知标题";
        trackArtistEl.textContent = track.artist || "未知艺术家";
        const artUrl = track.albumArt || DEFAULT_ART;
        albumArtEl.src = artUrl;
        controlAlbumArtEl.src = artUrl;

        parsedLyrics = parseLRC(track.lyrics || '');
        renderLyrics();
        updatePlaylistUI();

        let loadedOnce = false;
        const handleMediaReady = () => {
            if (!loadedOnce) {
                hideSkeleton();
                updateProgress();
                if (isPlaying) {
                    mediaPlayer.play().catch(e => {
                        if (e.name !== 'AbortError') console.error("播放失败:", e);
                    });
                }
                loadedOnce = true;
            }
        };

        mediaPlayer.oncanplay = null;
        mediaPlayer.onloadedmetadata = null;
        albumArtEl.onload = null;
        mediaPlayer.onerror = null;

        mediaPlayer.onerror = (e) => {
            console.error("媒体加载错误:", e);
            trackTitleEl.textContent = "错误";
            trackArtistEl.textContent = "无法播放此媒体";
            hideSkeleton();
            resetMainViewBackground();
        };

        if (track.type === 'audio') {
            albumArtContainer.style.display = 'flex';
            mediaPlayer.style.display = 'none';
            albumArtEl.onload = () => extractAndApplyGradient(albumArtEl);
            if (albumArtEl.complete && albumArtEl.naturalWidth > 0) {
                extractAndApplyGradient(albumArtEl);
            } else {
                resetMainViewBackground();
            }
        } else { // 'video'
            albumArtContainer.style.display = 'none';
            mediaPlayer.style.display = 'block';
            resetMainViewBackground();
            mediaPlayer.addEventListener('canplay', () => {
                extractAndApplyGradient(mediaPlayer);
            }, { once: true });
        }

        mediaPlayer.src = track.src;
        mediaPlayer.load();

        mediaPlayer.oncanplay = handleMediaReady;
        mediaPlayer.onloadedmetadata = updateProgress;

        if (isPlaying) {
            mediaPlayer.play().catch(e => { /* Ignore initial autoplay error, it will be handled by 'canplay' */ });
        }
    }

    const togglePlayPause = () => isPlaying ? pauseTrack() : playTrack();

    function playTrack() {
        if (playlist.length === 0 || !mediaPlayer.src) return;
        const playPromise = mediaPlayer.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                isPlaying = true;
                playPauseBtn.classList.add('playing');
                playPauseBtn.title = '暂停';
            }).catch(e => {
                if (e.name !== 'AbortError') console.error("播放失败:", e);
                isPlaying = false;
                playPauseBtn.classList.remove('playing');
                playPauseBtn.title = '播放';
            });
        }
    }

    function pauseTrack() {
        mediaPlayer.pause();
        isPlaying = false;
        playPauseBtn.classList.remove('playing');
        playPauseBtn.title = '播放';
    }

    function changeTrack(direction) {
        if (playlist.length === 0) return;
        currentTrackIndex = (currentTrackIndex + direction + playlist.length) % playlist.length;
        loadTrack(currentTrackIndex);
    }

    function updateProgress() {
        const { duration, currentTime } = mediaPlayer;
        if (!isNaN(duration)) {
            progressBar.value = (currentTime / duration) * 100;
            durationEl.textContent = formatTime(duration);
        } else {
            durationEl.textContent = "0:00";
        }
        currentTimeEl.textContent = formatTime(currentTime);
        syncLyrics(currentTime);
    }

    // --- 6. 元数据与歌词处理 ---
    function parseLRC(lrcText) {
        if (!lrcText || lrcText.trim() === '') return [];
        return lrcText.split('\n').map(line => {
            const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
            if (match) {
                const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 1000;
                return { time, text: match[4].trim() };
            }
            return null;
        }).filter(Boolean);
    }
    function renderLyrics() {
        lyricsList.style.transform = 'translateY(0)';
        if (parsedLyrics.length === 0) {
            lyricsList.innerHTML = '<p class="no-lyrics">暂无歌词</p>';
            return;
        }
        lyricsList.innerHTML = parsedLyrics.map(line => `<p>${line.text || '...'}</p>`).join('');
    }
    let lastActiveLyricIndex = -1;
    function syncLyrics(currentTime) {
        if (parsedLyrics.length === 0) return;
        const allLyricLines = lyricsList.querySelectorAll('p');
        const activeIndex = parsedLyrics.findIndex((line, i) => {
            const nextLine = parsedLyrics[i + 1];
            return currentTime >= line.time && (!nextLine || currentTime < nextLine.time);
        });
        if (activeIndex !== -1 && activeIndex !== lastActiveLyricIndex) {
            if (lastActiveLyricIndex !== -1 && allLyricLines[lastActiveLyricIndex]) {
                allLyricLines[lastActiveLyricIndex].classList.remove('active');
            }
            const activeLineElement = allLyricLines[activeIndex];
            if (activeLineElement) {
                activeLineElement.classList.add('active');
                const listWrapper = document.getElementById('lyrics-list-wrapper');
                const listHeight = listWrapper.clientHeight;
                const lineTop = activeLineElement.offsetTop;
                const lineHeight = activeLineElement.clientHeight;
                const translateY = listHeight / 2 - lineTop - lineHeight / 2;
                lyricsList.style.transform = `translateY(${translateY}px)`;
            }
            lastActiveLyricIndex = activeIndex;
        }
    }

    // --- 7. UI 与辅助功能 ---
    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${String(secs).padStart(2, '0')}`;
    }
    function renderPlaylist() {
        playlistEl.innerHTML = playlist.map((track, index) => ` <li class="playlist-item" data-index="${index}"> <div class="playlist-icon">${track.type === 'video' ? '🎬' : '🎵'}</div> <div class="playlist-details"> <div class="playlist-title">${track.title || '未知标题'}</div> <div class="playlist-artist">${track.artist || '未知艺术家'}</div> </div> </li> `).join('') + `<li id="playlist-no-results" class="no-results-message" style="display: none;">未找到结果</li>`;
    }
    function updatePlaylistUI() {
        document.querySelectorAll('.playlist-item').forEach(item => {
            item.classList.toggle('active', parseInt(item.dataset.index) === currentTrackIndex);
        });
    }
    function togglePlaylistPanel() {
        playlistPanel.classList.toggle('active');
    }
    function toggleLyricsPanel() {
        lyricsContainer.classList.toggle('active');
    }
    function toggleInfoPanel() {
        infoPanel.classList.toggle('active');
    }
    function toggleShortcutPanel() {
        shortcutPanel.classList.toggle('active');
    }
    function showToast(message) {
        clearTimeout(toastTimeout);
        toastEl.textContent = message;
        toastEl.classList.add('show');
        toastTimeout = setTimeout(() => {
            toastEl.classList.remove('show');
        }, 3000);
    }
    const desktopTourSteps = [{
        element: '#play-pause-btn',
        title: '主控制区',
        content: '点击这里可以播放或暂停当前媒体。您也可以使用快捷键。',
        position: 'top'
    }, {
        element: '.progress-container',
        title: '播放进度',
        content: '这里显示播放进度，您可以拖动滑块来快进或快退。',
        position: 'top'
    }, {
        element: '#lyrics-btn',
        title: '同步歌词',
        content: '点击此按钮可以显示或隐藏同步歌词界面。',
        position: 'top'
    }, {
        element: '#playlist-btn',
        title: '播放列表',
        content: '在这里查看和切换播放队列中的所有媒体。',
        position: 'top'
    }, {
        element: '#shortcut-btn',
        title: '快捷键设置',
        content: '点击这里可以自定义控制播放器的键盘快捷键。',
        position: 'top'
    }, {
        element: '.track-info',
        title: '尽情享受吧！',
        content: '现在您可以开始使用了。所有功能都已介绍完毕。',
        position: 'top'
    }];
    const mobileTourSteps = [{
        element: '#play-pause-btn',
        title: '主控制区',
        content: '点击这里可以播放或暂停当前媒体。',
        position: 'top'
    }, {
        element: '.progress-container',
        title: '播放进度',
        content: '这里显示播放进度，您可以拖动滑块来快进或快退。',
        position: 'top'
    }, {
        element: '#mobile-lyrics-btn',
        title: '同步歌词',
        content: '点击此按钮可以显示或隐藏同步歌词界面。',
        position: 'top'
    }, {
        element: '#mobile-playlist-btn',
        title: '播放列表',
        content: '在这里查看和切换播放队列中的所有媒体。',
        position: 'top'
    }, {
        element: '.main-controls',
        title: '尽情享受吧！',
        content: '现在您可以开始使用了。所有功能都已介绍完毕。',
        position: 'top'
    }];
    class FeatureTour {
        constructor(steps) {
            this.steps = steps;
            this.currentStepIndex = 0;
            this.domElements = {};
            this.start = this.start.bind(this);
            this.end = this.end.bind(this);
            this.nextStep = this.nextStep.bind(this);
            this.prevStep = this.prevStep.bind(this);
            this.handleResize = this.handleResize.bind(this);
        }
        createDOMElements() {
            this.domElements.overlay = document.createElement('div');
            this.domElements.overlay.id = 'tour-overlay';
            this.domElements.overlay.onclick = this.end;
            this.domElements.highlightBox = document.createElement('div');
            this.domElements.highlightBox.id = 'tour-highlight-box';
            this.domElements.tooltip = document.createElement('div');
            this.domElements.tooltip.id = 'tour-tooltip';
            this.domElements.tooltip.innerHTML = `<div class="tour-tooltip-header"><span class="tour-tooltip-title"></span><span class="tour-tooltip-step-counter"></span></div><div class="tour-tooltip-content"></div><div class="tour-tooltip-footer"><button class="tour-skip-button">跳过</button><div class="tour-nav-buttons"><button class="tour-prev-button">上一步</button><button class="tour-next-button">下一步</button></div></div>`;
            document.body.appendChild(this.domElements.overlay);
            document.body.appendChild(this.domElements.highlightBox);
            document.body.appendChild(this.domElements.tooltip);
            this.domElements.title = this.domElements.tooltip.querySelector('.tour-tooltip-title');
            this.domElements.content = this.domElements.tooltip.querySelector('.tour-tooltip-content');
            this.domElements.stepCounter = this.domElements.tooltip.querySelector('.tour-tooltip-step-counter');
            this.domElements.skipButton = this.domElements.tooltip.querySelector('.tour-skip-button');
            this.domElements.prevButton = this.domElements.tooltip.querySelector('.tour-prev-button');
            this.domElements.nextButton = this.domElements.tooltip.querySelector('.tour-next-button');
        }
        attachEventListeners() {
            this.domElements.skipButton.addEventListener('click', this.end);
            this.domElements.nextButton.addEventListener('click', this.nextStep);
            this.domElements.prevButton.addEventListener('click', this.prevStep);
            window.addEventListener('resize', this.handleResize);
        }
        handleResize() {
            this.showStep(this.currentStepIndex);
        }
        start() {
            if (this.steps.length === 0) return;
            this.createDOMElements();
            this.attachEventListeners();
            this.currentStepIndex = 0;
            document.body.style.overflow = 'hidden';
            this.domElements.overlay.classList.add('active');
            this.showStep(this.currentStepIndex);
        }
        end() {
            localStorage.setItem('player_tour_completed', 'true');
            document.body.style.overflow = '';
            this.domElements.overlay.classList.remove('active');
            this.domElements.tooltip.classList.remove('active');
            setTimeout(() => {
                if (this.domElements.overlay) this.domElements.overlay.remove();
                if (this.domElements.highlightBox) this.domElements.highlightBox.remove();
                if (this.domElements.tooltip) this.domElements.tooltip.remove();
                window.removeEventListener('resize', this.handleResize);
            }, 300);
        }
        nextStep() {
            if (this.currentStepIndex < this.steps.length - 1) {
                this.currentStepIndex++;
                this.showStep(this.currentStepIndex);
            } else {
                this.end();
            }
        }
        prevStep() {
            if (this.currentStepIndex > 0) {
                this.currentStepIndex--;
                this.showStep(this.currentStepIndex);
            }
        }
        showStep(index) {
            const step = this.steps[index];
            if (!step) return;
            const targetElement = document.querySelector(step.element);
            if (!targetElement || targetElement.offsetParent === null) {
                console.warn(`Tour element "${step.element}" not found or not visible.`);
                this.nextStep();
                return;
            }
            targetElement.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
            const targetRect = targetElement.getBoundingClientRect();
            const highlightBox = this.domElements.highlightBox;
            highlightBox.style.width = `${targetRect.width + 10}px`;
            highlightBox.style.height = `${targetRect.height + 10}px`;
            highlightBox.style.top = `${targetRect.top - 5}px`;
            highlightBox.style.left = `${targetRect.left - 5}px`;
            const targetStyle = window.getComputedStyle(targetElement);
            highlightBox.style.borderRadius = targetStyle.borderRadius;
            this.domElements.title.textContent = step.title;
            this.domElements.content.textContent = step.content;
            this.domElements.stepCounter.textContent = `${index + 1} / ${this.steps.length}`;
            const tooltip = this.domElements.tooltip;
            tooltip.className = 'tour-tooltip';
            setTimeout(() => {
                const tooltipRect = tooltip.getBoundingClientRect();
                let top, left;
                const margin = 15;
                switch (step.position) {
                    case 'top':
                        top = targetRect.top - tooltipRect.height - margin;
                        left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                        tooltip.classList.add('tour-tooltip-top');
                        break;
                    case 'left':
                        top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                        left = targetRect.left - tooltipRect.width - margin;
                        tooltip.classList.add('tour-tooltip-left');
                        break;
                    case 'right':
                        top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2);
                        left = targetRect.right + margin;
                        tooltip.classList.add('tour-tooltip-right');
                        break;
                    default:
                        top = targetRect.bottom + margin;
                        left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                        tooltip.classList.add('tour-tooltip-bottom');
                        break;
                }
                if (left < 10) left = 10;
                if (top < 10) top = 10;
                if (left + tooltipRect.width > window.innerWidth - 10) {
                    left = window.innerWidth - tooltipRect.width - 10;
                }
                if (top + tooltipRect.height > window.innerHeight - 10) {
                    top = window.innerHeight - tooltipRect.height - 10;
                }
                tooltip.style.top = `${top}px`;
                tooltip.style.left = `${left}px`;
                tooltip.classList.add('active');
            }, 10);
            this.domElements.prevButton.disabled = index === 0;
            this.domElements.nextButton.textContent = (index === this.steps.length - 1) ? '完成' : '下一步';
        }
    }
    let shortcutSettings = {};
    let isRecordingShortcut = false;
    let currentRecordingAction = null;
    let pressedShortcutKeys = new Set();
    const defaultShortcuts = {
        'toggle-play': {
            label: '播放/暂停',
            keys: ['Space']
        },
        'next-track': {
            label: '下一首',
            keys: ['→']
        },
        'prev-track': {
            label: '上一首',
            keys: ['←']
        },
        'volume-up': {
            label: '音量+',
            keys: ['↑']
        },
        'volume-down': {
            label: '音量-',
            keys: ['↓']
        },
        'toggle-mute': {
            label: '静音/取消',
            keys: ['M']
        },
        'toggle-lyrics': {
            label: '切换歌词',
            keys: ['L']
        },
        'toggle-playlist': {
            label: '切换播放列表',
            keys: ['P']
        }
    };
    function saveShortcuts() {
        localStorage.setItem('player-shortcuts', JSON.stringify(shortcutSettings));
    }
    function loadShortcuts() {
        const saved = localStorage.getItem('player-shortcuts');
        shortcutSettings = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(defaultShortcuts));
        renderShortcutList();
    }
    function formatKeysToHTML(keys) {
        if (!keys || keys.length === 0) {
            return '<span class="placeholder">未设置</span>';
        }
        return keys.map(key => `<kbd>${key}</kbd>`).join(' + ');
    }
    function renderShortcutList() {
        shortcutListEl.innerHTML = '';
        for (const actionId in shortcutSettings) {
            const setting = shortcutSettings[actionId];
            const item = document.createElement('li');
            item.className = 'shortcut-item';
            item.dataset.action = actionId;
            item.innerHTML = ` <span class="action-label">${setting.label}</span> <div class="shortcut-display"> ${formatKeysToHTML(setting.keys)} </div> <div class="actions"> <button class="set-btn">设置</button> <button class="clear-btn">清除</button> </div> `;
            shortcutListEl.appendChild(item);
        }
    }
    function normalizeKey(key) {
        const keyMap = {
            'Control': 'Ctrl',
            'Meta': 'Cmd',
            ' ': 'Space',
            'ArrowUp': '↑',
            'ArrowDown': '↓',
            'ArrowLeft': '←',
            'ArrowRight': '→'
        };
        return keyMap[key] || key.charAt(0).toUpperCase() + key.slice(1);
    }
    function startRecording(actionId) {
        currentRecordingAction = actionId;
        isRecordingShortcut = true;
        pressedShortcutKeys.clear();
        shortcutKeyPreviewEl.innerHTML = '<span class="placeholder">等待输入...</span>';
        shortcutModalOverlayEl.classList.add('visible');
        window.addEventListener('keydown', handleShortcutKeyDown);
        window.addEventListener('keyup', handleShortcutKeyUp);
    }
    function stopRecording() {
        isRecordingShortcut = false;
        currentRecordingAction = null;
        pressedShortcutKeys.clear();
        shortcutModalOverlayEl.classList.remove('visible');
        window.removeEventListener('keydown', handleShortcutKeyDown);
        window.removeEventListener('keyup', handleShortcutKeyUp);
    }
    function handleShortcutKeyDown(e) {
        if (!isRecordingShortcut) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
            stopRecording();
            return;
        }
        pressedShortcutKeys.add(normalizeKey(e.key));
        shortcutKeyPreviewEl.innerHTML = formatKeysToHTML(Array.from(pressedShortcutKeys));
    }
    function handleShortcutKeyUp(e) {
        if (!isRecordingShortcut || pressedShortcutKeys.size === 0) return;
        const modifierKeys = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
        const hasNonModifierKey = Array.from(pressedShortcutKeys).some(k => !modifierKeys.includes(k));
        if (hasNonModifierKey) {
            shortcutSettings[currentRecordingAction].keys = Array.from(pressedShortcutKeys);
            saveShortcuts();
            stopRecording();
            renderShortcutList();
        }
    }
    function executeShortcut(actionId) {
        switch (actionId) {
            case 'toggle-play':
                togglePlayPause();
                break;
            case 'next-track':
                playNextTrack();
                break;
            case 'prev-track':
                playPrevTrack();
                break;
            case 'volume-up':
                mediaPlayer.volume = Math.min(1, mediaPlayer.volume + 0.1);
                volumeBar.value = mediaPlayer.volume;
                break;
            case 'volume-down':
                mediaPlayer.volume = Math.max(0, mediaPlayer.volume - 0.1);
                volumeBar.value = mediaPlayer.volume;
                break;
            case 'toggle-mute':
                volumeBtn.click();
                break;
            case 'toggle-lyrics':
                toggleLyricsPanel();
                break;
            case 'toggle-playlist':
                togglePlaylistPanel();
                break;
        }
    }
    function updateModeButton() {
        const currentMode = PLAY_MODES[currentModeIndex];
        modeBtn.className = 'control-btn';
        modeBtn.classList.add(`mode-${currentMode}`);
        let title = '';
        if (currentMode === 'list') title = '列表循环';
        else if (currentMode === 'single') title = '单曲循环';
        else if (currentMode === 'shuffle') title = '随机播放';
        modeBtn.title = title;
    }
    function cyclePlayMode() {
        currentModeIndex = (currentModeIndex + 1) % PLAY_MODES.length;
        updateModeButton();
        showToast(`播放模式: ${modeBtn.title}`);
    }
    function playNextTrack() {
        if (playlist.length === 0) return;
        const currentMode = PLAY_MODES[currentModeIndex];
        if (currentMode === 'shuffle') {
            let nextIndex;
            if (playlist.length === 1) {
                nextIndex = 0;
            } else {
                do {
                    nextIndex = Math.floor(Math.random() * playlist.length);
                } while (nextIndex === currentTrackIndex);
            }
            loadTrack(nextIndex);
        } else {
            changeTrack(1);
        }
    }
    function playPrevTrack() {
        changeTrack(-1);
    }
    function filterPlaylist() {
        const query = playlistSearchInput.value.toLowerCase().replace(/\s/g, '');
        const playlistItems = playlistEl.querySelectorAll('.playlist-item');
        let hasVisibleItems = false;

        if (!query) {
            playlistItems.forEach(item => {
                item.style.display = 'flex';
            });
            document.getElementById('playlist-no-results').style.display = 'none';
            return;
        }

        playlist.forEach((track, index) => {
            const title = track.title || '';
            const artist = track.artist || '';
            const pinyin = track.pinyin || '';
            const initials = track.initials || '';
            const isMatch = title.toLowerCase().includes(query) || artist.toLowerCase().includes(query) || pinyin.includes(query) || initials.includes(query);
            if (isMatch) {
                playlistItems[index].style.display = 'flex';
                hasVisibleItems = true;
            } else {
                playlistItems[index].style.display = 'none';
            }
        });

        document.getElementById('playlist-no-results').style.display = hasVisibleItems ? 'none' : 'block';
    }

    // --- NEW: Immersive Mode Logic ---
    function toggleImmersiveMode() {
        const isCurrentlyImmersive = playerContainer.classList.contains('immersive-mode');

        if (!isCurrentlyImmersive) {
            // --- Enter immersive mode ---
            playerContainer.classList.add('immersive-mode');
            immersiveBtn.title = "退出沉浸模式";
            // Request fullscreen on the entire page
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                    // If fullscreen fails, revert the state
                    playerContainer.classList.remove('immersive-mode');
                    immersiveBtn.title = "沉浸模式";
                });
            }
        } else {
            // --- Exit immersive mode ---
            playerContainer.classList.remove('immersive-mode');
            immersiveBtn.title = "沉浸模式";
            // Exit fullscreen if the document is currently in it
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }
        }
    }

    /**
     * Syncs the UI state if the user exits fullscreen using the 'Esc' key
     * instead of the dedicated button.
     */
    function handleFullscreenChange() {
        const isInFullscreen = !!document.fullscreenElement;
        const isImmersiveClassActive = playerContainer.classList.contains('immersive-mode');

        if (!isInFullscreen && isImmersiveClassActive) {
            // We have exited fullscreen, so ensure our immersive mode UI is also turned off
            playerContainer.classList.remove('immersive-mode');
            immersiveBtn.title = "沉浸模式";
        }
    }


    // --- 8. Event Listeners ---
    const currentlyPressedKeys = new Set();
    window.addEventListener('keydown', (e) => {
        if (isRecordingShortcut || ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) {
            return;
        }
        currentlyPressedKeys.add(normalizeKey(e.key));
        for (const actionId in shortcutSettings) {
            const requiredKeys = new Set(shortcutSettings[actionId].keys);
            if (requiredKeys.size > 0 && requiredKeys.size === currentlyPressedKeys.size && [...requiredKeys].every(key => currentlyPressedKeys.has(key))) {
                e.preventDefault();
                executeShortcut(actionId);
                break;
            }
        }
    });
    window.addEventListener('keyup', (e) => {
        currentlyPressedKeys.delete(normalizeKey(e.key));
    });

    immersiveBtn.addEventListener('click', toggleImmersiveMode);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange); // For Safari/Chrome
    document.addEventListener('mozfullscreenchange', handleFullscreenChange); // For Firefox
    document.addEventListener('MSFullscreenChange', handleFullscreenChange); // For IE/Edge

    playPauseBtn.addEventListener('click', togglePlayPause);
    prevBtn.addEventListener('click', playPrevTrack);
    nextBtn.addEventListener('click', playNextTrack);
    mediaPlayer.addEventListener('ended', () => {
        const currentMode = PLAY_MODES[currentModeIndex];
        if (currentMode === 'single') {
            mediaPlayer.currentTime = 0;
            mediaPlayer.play();
        } else {
            playNextTrack();
        }
    });
    mediaPlayer.addEventListener('timeupdate', updateProgress);
    mediaPlayer.addEventListener('loadedmetadata', updateProgress);
    progressBar.addEventListener('input', (e) => {
        if (!isNaN(mediaPlayer.duration)) {
            mediaPlayer.currentTime = (e.target.value / 100) * mediaPlayer.duration;
        }
    });
    lyricsBtn.addEventListener('click', toggleLyricsPanel);
    mobileLyricsBtn.addEventListener('click', toggleLyricsPanel);
    playlistBtn.addEventListener('click', togglePlaylistPanel);
    mobilePlaylistBtn.addEventListener('click', togglePlaylistPanel);
    infoBtn.addEventListener('click', toggleInfoPanel);
    closeInfoBtn.addEventListener('click', () => infoPanel.classList.remove('active'));
    infoPanel.addEventListener('click', (e) => {
        if (e.target === infoPanel) infoPanel.classList.remove('active');
    });
    lyricsContainer.addEventListener('click', (e) => {
        if (e.target === lyricsContainer) lyricsContainer.classList.remove('active');
    });
    volumeBtn.addEventListener('click', () => {
        mediaPlayer.muted = !mediaPlayer.muted;
        volumeBtn.classList.toggle('muted', mediaPlayer.muted);
        volumeBar.value = mediaPlayer.muted ? 0 : mediaPlayer.volume;
    });
    volumeBar.addEventListener('input', (e) => {
        mediaPlayer.volume = e.target.value;
        mediaPlayer.muted = e.target.value == 0;
        volumeBtn.classList.toggle('muted', mediaPlayer.muted);
    });
    playlistEl.addEventListener('click', (e) => {
        const item = e.target.closest('.playlist-item');
        if (item) {
            loadTrack(parseInt(item.dataset.index, 10));
        }
    });
    closePlaylistBtn.addEventListener('click', () => {
        playlistPanel.classList.remove('active');
    });
    playlistPanel.addEventListener('click', (e) => {
        if (e.target === playlistPanel) {
            playlistPanel.classList.remove('active');
        }
    });
    shortcutBtn.addEventListener('click', toggleShortcutPanel);
    closeShortcutBtn.addEventListener('click', toggleShortcutPanel);
    shortcutPanel.addEventListener('click', e => {
        if (e.target === shortcutPanel) toggleShortcutPanel();
    });
    shortcutListEl.addEventListener('click', (e) => {
        const target = e.target;
        const item = target.closest('.shortcut-item');
        if (!item) return;
        const actionId = item.dataset.action;
        if (target.classList.contains('set-btn')) {
            startRecording(actionId);
        }
        if (target.classList.contains('clear-btn')) {
            shortcutSettings[actionId].keys = [];
            saveShortcuts();
            renderShortcutList();
        }
    });
    shortcutModalOverlayEl.addEventListener('click', (e) => {
        if (e.target === shortcutModalOverlayEl) {
            stopRecording();
        }
    });
    modeBtn.addEventListener('click', cyclePlayMode);
    playlistSearchInput.addEventListener('input', filterPlaylist);

    // --- 9. Initialization ---
    async function init() {
        showSkeleton();
        try {
            const response = await fetch('playlist.json');
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            let fetchedPlaylist = await response.json();
            const {
                pinyin
            } = window.pinyinPro;
            playlist = fetchedPlaylist.map(track => {
                const title = track.title || '';
                const pinyinStr = pinyin(title, {
                    toneType: 'none'
                }).replace(/\s/g, '');
                const initialsStr = pinyin(title, {
                    pattern: 'initial',
                    toneType: 'none'
                }).replace(/\s/g, '');
                return { ...track,
                    pinyin: pinyinStr,
                    initials: initialsStr
                };
            });
        } catch (error) {
            console.error("无法加载或处理播放列表:", error);
            trackTitleEl.textContent = "错误";
            trackArtistEl.textContent = "无法加载播放列表";
            hideSkeleton();
            return;
        }
        if (playlist.length > 0) {
            renderPlaylist();
            await loadTrack(currentTrackIndex);
        } else {
            trackTitleEl.textContent = "播放列表为空";
            hideSkeleton();
        }
        volumeBar.value = mediaPlayer.volume;
        volumeBtn.classList.toggle('muted', mediaPlayer.muted);
        loadShortcuts();
        updateModeButton();
        if (!localStorage.getItem('player_tour_completed')) {
            setTimeout(() => {
                const isMobile = window.innerWidth <= 900;
                const tourStepsToRun = isMobile ? mobileTourSteps : desktopTourSteps;
                const playerTour = new FeatureTour(tourStepsToRun);
                playerTour.start();
            }, 500);
        }
    }
    init();
});