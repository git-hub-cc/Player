// js/features/downloader.js

import * as dom from '../dom.js';

/**
 * 处理发送到后端的下载请求。
 */
async function handleDownloadRequest() {
    const urlText = dom.douyinUrlInput.value;
    if (!urlText.trim()) {
        dom.downloadStatusEl.textContent = '错误：请输入有效的分享文本。';
        dom.downloadStatusEl.className = 'download-status error';
        dom.downloadStatusEl.style.display = 'block';
        return;
    }

    // 1. 更新UI为加载状态
    dom.startDownloadBtn.disabled = true;
    dom.startDownloadBtn.classList.add('loading');
    dom.downloadStatusEl.textContent = '正在连接服务器并处理请求，请稍候...\n这可能需要一些时间，特别是首次运行。';
    dom.downloadStatusEl.className = 'download-status'; // 恢复默认样式
    dom.downloadStatusEl.style.display = 'block';

    try {
        // 2. 发送 fetch 请求到后端
        const response = await fetch('/download-douyin', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ urlText: urlText }),
        });

        const result = await response.json();

        // 3. 根据后端返回结果更新UI
        if (response.ok && result.success) {
            // 根据后端消息显示更详细的成功提示
            let successMessage = '下载成功！\n文件已保存到服务器的 "videos" 和 "albumArt" 文件夹中。';
            if (result.message.includes('Playlist updated')) {
                successMessage = '下载成功！\n文件已保存到服务器，播放列表已更新。请刷新页面查看新内容。';
            }
            dom.downloadStatusEl.textContent = successMessage;
            dom.downloadStatusEl.className = 'download-status success';
        } else {
            // 失败时，显示详细日志用于排错
            const errorMessage = result.output || result.error || result.message || '未知错误';
            dom.downloadStatusEl.textContent = `下载失败: ${result.message}\n\n详细信息:\n${errorMessage}`;
            dom.downloadStatusEl.className = 'download-status error';
        }

    } catch (error) {
        // 网络错误或服务器未运行
        console.error('Download request failed:', error);
        dom.downloadStatusEl.textContent = '请求失败！无法连接到本地服务器。\n请确保您已在项目根目录运行 `node server.js`。';
        dom.downloadStatusEl.className = 'download-status error';
    } finally {
        // 4. 恢复按钮状态
        dom.startDownloadBtn.disabled = false;
        dom.startDownloadBtn.classList.remove('loading');
    }
}

/**
 * 为下载面板设置所有相关的事件监听器。
 */
export function setupDownloaderListeners() {
    dom.startDownloadBtn.addEventListener('click', handleDownloadRequest);

    // 允许在文本框中使用 Ctrl+Enter 或 Cmd+Enter 触发下载
    dom.douyinUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); // 防止换行
            handleDownloadRequest();
        }
    });
}