// src/backend/providers/m3u8-direct.js
//
// 直接下载 M3U8 链接的 Provider。
// 当用户输入的 URL 以 .m3u8 结尾时生效，
// 无需启动虚拟浏览器，直接将链接交给 yt-dlp 下载。

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BaseProvider } from './base-provider.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class M3u8DirectProvider extends BaseProvider {
    /**
     * 匹配以 .m3u8 结尾的 URL（含可选查询参数）。
     */
    isApplicable(url) {
        try {
            const pathname = new URL(url).pathname;
            return pathname.endsWith('.m3u8');
        } catch {
            return url.includes('.m3u8');
        }
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) return;

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '检测到 M3U8 直链，正在调用 yt-dlp 直接下载...', type: 'default' });

            const uniqueFilenameBase = `media_m3u8_${Date.now()}`;

            const finalFilePath = await this._downloadM3u8WithYtDlp(
                videoUrl,
                this.config.VIDEOS_DIR,
                uniqueFilenameBase,
                (progress) => this.sendMessage('download-status', {
                    message: `下载进度: ${(progress * 100).toFixed(1)}%`,
                    progress,
                    type: 'progress'
                }),
                signal
            );

            this._checkCancelled(signal);

            // 从 URL 路径尝试提取一个可读标题
            let title = 'M3U8 视频';
            try {
                const segments = new URL(videoUrl).pathname.split('/').filter(Boolean);
                // 取路径中倒数第二节（通常是节目/频道名）
                const candidate = segments.length >= 2 ? segments[segments.length - 2] : segments[0];
                if (candidate && candidate !== 'index.m3u8' && candidate !== 'playlist.m3u8') {
                    title = decodeURIComponent(candidate);
                }
            } catch { }

            await this._addTrackToPlaylist({
                title,
                artist: 'M3U8 直链',
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: '',
                type: 'video'
            });

            this.sendMessage('download-status', { message: `M3U8 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[M3u8Direct Provider] 错误:', error);
            throw new Error(`M3U8 直链下载失败: ${error.message}`);
        }
    }

    _downloadM3u8WithYtDlp(m3u8Url, outputDir, filename, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const outputTemplate = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--no-playlist',
                '--force-ipv4',
                '--socket-timeout', '60',
                '-f', 'best',
                '--ffmpeg-location', ffmpegDir,
                '--merge-output-format', 'mp4',
                '--add-header', `User-Agent:${DEFAULT_UA}`,
                '--output', outputTemplate,
                '--no-warnings',
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);

            args.push(m3u8Url);

            const emitter = ytDlpWrap.exec(args);

            emitter.on('progress', (progress) => {
                if (onProgress && progress.percent) onProgress(progress.percent / 100);
            });
            emitter.on('error', (error) => reject(error));
            emitter.on('close', (code) => {
                if (signal && signal.aborted) return reject(new Error('Download aborted by user'));
                if (code !== 0) return reject(new Error(`yt-dlp 退出码: ${code}`));

                const mp4Path = path.join(outputDir, `${filename}.mp4`);
                if (fs.existsSync(mp4Path)) return resolve(mp4Path);

                const files = fs.readdirSync(outputDir);
                const match = files.find(f => f.startsWith(filename) && ['.mp4', '.mkv', '.webm', '.ts'].some(e => f.endsWith(e)));
                resolve(match ? path.join(outputDir, match) : mp4Path);
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }

    _killProcess(proc) {
        if (!proc) return;
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', proc.pid, '/f', '/t']);
            else proc.kill('SIGKILL');
        } catch { }
    }
}
