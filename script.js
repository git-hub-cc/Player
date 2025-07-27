document.addEventListener('DOMContentLoaded', () => {
    // --- 1. DOM 元素获取 (新增关于面板元素) ---
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
    // 新增: 获取关于面板相关元素
    const infoBtn = document.getElementById('info-btn');
    const infoPanel = document.getElementById('info-panel');
    const closeInfoBtn = document.getElementById('close-info-btn');
    // 获取移动端专属按钮
    const mobilePlaylistBtn = document.getElementById('mobile-playlist-btn');
    const mobileLyricsBtn = document.getElementById('mobile-lyrics-btn');


    const DEFAULT_ART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI0IzQjNCMyI+PHBhdGggZD0iTTEyIDNBOS45OSA5Ljk5IDAgMCAwIDIgMTJoLjAyYzAgNC45NyA0LjAzIDkgOC45OCA5czguOTgtNC4wMyA4Ljk4LTlBOS45OSA5Ljk5IDAgMCAwIDEyIDptMCAxNmMyLjYyIDAgNC43NS0yLjEyIDQuNzUtNC43NVMyMSAxMC42MyAyMSAxMGMwLTEuMDQtLjM1LTEuOTktLjkzLTIuNzlsLTYgNEMxMy40MyAxNy42NSA5LjUgMTYgOS41IDEyLjVDOS41IDguMzYgMTIuODYgNSA5LjUgNSBjLTEuOTggMC0zLjY5Ljg1LTQuNzggMi4yMkw2LjA4IDZDNy41IDQuMzQgOS42MiAzIDEyIDN6bS0uNS00YzEuMzggMCAyLjUtMS4xMiAyLjUtMi41UzEzLjg4IDUgMTIuNSA1IDcgNi4xMiA3IDcuNXMyLjEyIDIuNSAyLjUgMi41eiIvPjwvc3ZnPg==";

    // --- 2. 状态管理 ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false;
    let parsedLyrics = [];

    // --- 背景色提取功能 ---
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

    // --- 3. 核心播放器功能 ---
    async function loadTrack(trackIndex) {
        if (playlist.length === 0) return;
        currentTrackIndex = trackIndex;
        const track = playlist[trackIndex];

        // 清理旧的事件监听器，防止内存泄漏或重复执行
        mediaPlayer.oncanplay = null;
        albumArtEl.onload = null;

        resetMainViewBackground();
        trackTitleEl.textContent = track.title;
        trackArtistEl.textContent = track.artist;
        albumArtEl.src = DEFAULT_ART;
        controlAlbumArtEl.src = DEFAULT_ART;
        parsedLyrics = parseLRC(track.lyrics);
        renderLyrics();
        updatePlaylistUI();

        mediaPlayer.src = track.src;

        if (track.type === 'audio') {
            albumArtContainer.style.display = 'flex';
            mediaPlayer.style.display = 'none';
            try {
                const tags = await getID3Tags(track.src);
                updateUITags(tags, track);
                console.log(`成功读取 ${track.src} 的元数据。`);
            } catch (error) {
                console.warn(`无法读取 ${track.src} 的元数据:`, error.message);
            }
        } else {
            albumArtContainer.style.display = 'none';
            mediaPlayer.style.display = 'block';

            // --- MODIFICATION START ---
            // 使用 oncanplay 事件代替 onloadeddata 和 setTimeout
            // oncanplay 更可靠，因为它在视频帧准备好播放时触发
            mediaPlayer.oncanplay = () => {
                extractAndApplyGradient(mediaPlayer);
                // 清理监听器，确保它只对当前加载的轨道触发一次
                mediaPlayer.oncanplay = null;
            };
            // --- MODIFICATION END ---
        }
    }
    const togglePlayPause = () => isPlaying ? pauseTrack() : playTrack();
    function playTrack() { if (playlist.length === 0) return; isPlaying = true; playPauseBtn.classList.add('playing'); playPauseBtn.title = '暂停'; mediaPlayer.play().catch(e => { if (e.name !== 'AbortError') { console.error("播放失败:", e); }}); }
    function pauseTrack() { isPlaying = false; playPauseBtn.classList.remove('playing'); playPauseBtn.title = '播放'; mediaPlayer.pause(); }
    function changeTrack(direction) { if (playlist.length === 0) return; currentTrackIndex = (currentTrackIndex + direction + playlist.length) % playlist.length; loadTrack(currentTrackIndex).then(playTrack); }
    function updateProgress() { const { duration, currentTime } = mediaPlayer; if (!isNaN(duration)) { progressBar.value = (currentTime / duration) * 100; durationEl.textContent = formatTime(duration); currentTimeEl.textContent = formatTime(currentTime); syncLyrics(currentTime); } }

    // --- 4. 元数据与歌词处理 ---
    async function getID3Tags(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const fileBlob = await response.blob();
            return new Promise((resolve, reject) => {
                window.jsmediatags.read(fileBlob, {
                    onSuccess: (tag) => resolve(tag.tags),
                    onError: (error) => reject(error)
                });
            });
        } catch (fetchError) {
            throw new Error(`Failed to fetch media for metadata reading: ${fetchError.message}`);
        }
    }

    function updateUITags(tags, track) {
        trackTitleEl.textContent = tags.title || track.title;
        trackArtistEl.textContent = tags.artist || track.artist;
        if (tags.picture) {
            const { data, format } = tags.picture;
            let base64String = "";
            for (let i = 0; i < data.length; i++) {
                base64String += String.fromCharCode(data[i]);
            }
            const artUrl = `data:${format};base64,${window.btoa(base64String)}`;
            albumArtEl.src = artUrl;
            controlAlbumArtEl.src = artUrl;
            albumArtEl.onload = () => extractAndApplyGradient(albumArtEl);
        }
    }
    function parseLRC(lrcText) { if (!lrcText || lrcText.trim() === '') return []; return lrcText.split('\n').map(line => { const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/); if (match) { const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 1000; return { time, text: match[4].trim() }; } return null; }).filter(Boolean); }
    function renderLyrics() { lyricsList.style.transform = 'translateY(0)'; if (parsedLyrics.length === 0) { lyricsList.innerHTML = '<p class="no-lyrics">暂无歌词</p>'; return; } lyricsList.innerHTML = parsedLyrics.map(line => `<p>${line.text || '...'}</p>`).join(''); }
    let lastActiveLyricIndex = -1;
    function syncLyrics(currentTime) { if (parsedLyrics.length === 0) return; const activeIndex = parsedLyrics.findIndex((line, i) => { const nextLine = parsedLyrics[i + 1]; return currentTime >= line.time && (!nextLine || currentTime < nextLine.time); }); if (activeIndex !== -1 && activeIndex !== lastActiveLyricIndex) { const allLyricLines = lyricsList.querySelectorAll('p'); if (lastActiveLyricIndex !== -1 && allLyricLines[lastActiveLyricIndex]) { allLyricLines[lastActiveLyricIndex].classList.remove('active'); } const activeLineElement = allLyricLines[activeIndex]; if (activeLineElement) { activeLineElement.classList.add('active'); const listWrapper = document.getElementById('lyrics-list-wrapper'); const listHeight = listWrapper.clientHeight; const lineTop = activeLineElement.offsetTop; const lineHeight = activeLineElement.clientHeight; const translateY = listHeight / 2 - lineTop - lineHeight / 2; lyricsList.style.transform = `translateY(${translateY}px)`; } lastActiveLyricIndex = activeIndex; } }

    // --- 5. UI 与辅助功能 ---
    function formatTime(seconds) { const mins = Math.floor(seconds / 60); const secs = Math.floor(seconds % 60); return `${mins}:${String(secs).padStart(2, '0')}`; }
    function renderPlaylist() {
        playlistEl.innerHTML = playlist.map((track, index) => `
            <li class="playlist-item" data-index="${index}">
                <div class="playlist-icon">${track.type === 'video' ? '🎬' : '🎵'}</div>
                <div class="playlist-details">
                    <div class="playlist-title">${track.title}</div>
                    <div class="playlist-artist">${track.artist}</div>
                </div>
            </li>
        `).join('');
    }
    function updatePlaylistUI() { document.querySelectorAll('.playlist-item').forEach(item => { item.classList.toggle('active', parseInt(item.dataset.index) === currentTrackIndex); }); }

    // --- 6. 事件监听器 (适配移动端) ---
    function togglePlaylistPanel() { playlistPanel.classList.toggle('active'); }
    function toggleLyricsPanel() { lyricsContainer.classList.toggle('active'); }
    // 新增: "关于"面板切换函数
    function toggleInfoPanel() { infoPanel.classList.toggle('active'); }

    playPauseBtn.addEventListener('click', togglePlayPause);
    prevBtn.addEventListener('click', () => changeTrack(-1));
    nextBtn.addEventListener('click', () => changeTrack(1));
    mediaPlayer.addEventListener('timeupdate', updateProgress);
    mediaPlayer.addEventListener('loadedmetadata', updateProgress);
    mediaPlayer.addEventListener('ended', () => changeTrack(1));
    progressBar.addEventListener('input', (e) => { if (!isNaN(mediaPlayer.duration)) { mediaPlayer.currentTime = (e.target.value / 100) * mediaPlayer.duration; } });

    // 绑定桌面和移动端按钮到同一个处理函数
    lyricsBtn.addEventListener('click', toggleLyricsPanel);
    mobileLyricsBtn.addEventListener('click', toggleLyricsPanel);
    playlistBtn.addEventListener('click', togglePlaylistPanel);
    mobilePlaylistBtn.addEventListener('click', togglePlaylistPanel);

    // 新增: 绑定"关于"面板的事件
    infoBtn.addEventListener('click', toggleInfoPanel);
    closeInfoBtn.addEventListener('click', () => infoPanel.classList.remove('active'));
    infoPanel.addEventListener('click', (e) => {
        if (e.target === infoPanel) infoPanel.classList.remove('active');
    });

    lyricsContainer.addEventListener('click', (e) => { if (e.target === lyricsContainer) lyricsContainer.classList.remove('active'); });
    volumeBtn.addEventListener('click', () => { mediaPlayer.muted = !mediaPlayer.muted; volumeBtn.classList.toggle('muted', mediaPlayer.muted); volumeBar.value = mediaPlayer.muted ? 0 : mediaPlayer.volume; });
    volumeBar.addEventListener('input', (e) => { mediaPlayer.volume = e.target.value; mediaPlayer.muted = e.target.value == 0; volumeBtn.classList.toggle('muted', mediaPlayer.muted); });
    playlistEl.addEventListener('click', (e) => { const item = e.target.closest('.playlist-item'); if (item) { loadTrack(parseInt(item.dataset.index, 10)).then(playTrack); } });
    closePlaylistBtn.addEventListener('click', () => { playlistPanel.classList.remove('active'); });
    playlistPanel.addEventListener('click', (e) => { if (e.target === playlistPanel) { playlistPanel.classList.remove('active'); } });

    // --- 7. 初始化 ---
    async function init() {
        try {
            const response = await fetch('playlist.json');
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            playlist = await response.json();
            console.log("播放列表加载成功。");
        } catch (error) {
            console.error("无法加载播放列表:", error);
            trackTitleEl.textContent = "错误";
            trackArtistEl.textContent = "无法加载播放列表";
            return;
        }

        if (playlist.length > 0) {
            renderPlaylist();
            await loadTrack(currentTrackIndex);
        } else {
            trackTitleEl.textContent = "播放列表为空";
        }

        volumeBar.value = mediaPlayer.volume;
        volumeBtn.classList.toggle('muted', mediaPlayer.muted);
    }

    init();
});