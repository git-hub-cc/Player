// src/backend/providers/youtube.js

import path from 'path';
import fs from 'fs';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

/**
 * @class YoutubeProvider
 * @description YouTube 视频下载服务提供者。
 * @extends BaseProvider
 */
export class YoutubeProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否能处理给定的 URL。
     * @param {string} url - 用户输入的 URL。
     * @returns {boolean} - 如果是 YouTube 视频链接则返回 true。
     */
    isApplicable(url) {
        return url.includes('youtube.com/') || url.includes('youtu.be/');
    }

    /**
     * 执行 YouTube 视频的下载和处理流程。
     * @param {string} videoUrl - YouTube 视频链接。
     * @returns {Promise<void>}
     */
    async execute(videoUrl) {
        // 1. 前置检查：确保 yt-dlp 和 FFmpeg 都存在
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) {
            return;
        }

        try {
            this.sendMessage('download-status', { message: '正在获取 YouTube 视频信息...', type: 'default' });

            // 2. 获取视频元信息
            const info = await this._getVideoInfo(videoUrl);
            const safeFilename = this._sanitizeFilename(info.title);

            // 3. 下载封面
            if (info.thumbnail) {
                await downloadFile(info.thumbnail, this.config.ALBUMART_DIR, `${safeFilename}.jpg`);
            }

            this.sendMessage('download-status', { message: '开始调用 yt-dlp 下载...', type: 'default' });

            // 4. 执行核心下载流程
            const finalFilePath = await this._downloadVideoWithYtDlp(
                videoUrl,
                this.config.VIDEOS_DIR,
                safeFilename,
                (progress) => this.sendMessage('download-status', {
                    message: `下载进度: ${(progress * 100).toFixed(1)}%`,
                    progress: progress,
                    type: 'progress'
                })
            );

            // 5. 添加到媒体库
            await this._addTrackToPlaylist({
                title: info.title,
                artist: info.uploader || 'YouTube',
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: `albumArt/${safeFilename}.jpg`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            console.error('[YouTube Provider] Error:', error);
            throw new Error(`YouTube 下载失败: ${error.message}`);
        }
    }

    /**
     * @private
     * 获取 YouTube 视频信息 (标题, 封面等)。
     */
    async _getVideoInfo(videoUrl) {
        try {
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);
            const args = ['--dump-json', '--force-ipv4', '--socket-timeout', '60'];
            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            console.log(`[YouTube Provider] 准备执行 yt-dlp (获取信息)，参数:`, args);
            const stdout = await ytDlpWrap.execPromise(args);
            const info = JSON.parse(stdout);

            console.log(`[YouTube Provider] 成功解析视频信息:`, { title: info.title, uploader: info.uploader });
            return {
                title: info.title,
                uploader: info.uploader,
                thumbnail: info.thumbnail,
                duration: info.duration,
            };
        } catch (error) {
            console.error('[YouTube Provider] 执行 yt-dlp (获取信息) 失败:', error);
            throw new Error(`获取视频信息失败: ${error.message}`);
        }
    }

    /**
     * @private
     * 使用 yt-dlp 下载 YouTube 视频。
     */
    _downloadVideoWithYtDlp(videoUrl, outputDir, filename, onProgress) {
        return new Promise((resolve, reject) => {
            const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--force-ipv4', '--socket-timeout', '60',
                '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--ffmpeg-location', ffmpegDir,
                '--output', outputPath,
                '--no-playlist',
            ];
            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            console.log(`[YouTube Provider] 准备执行 yt-dlp (下载)，参数:`, args);

            const ytDlpEventEmitter = ytDlpWrap.exec(args);

            ytDlpEventEmitter.on('progress', (progress) => {
                if (onProgress && progress.percent) onProgress(progress.percent / 100);
            });
            ytDlpEventEmitter.on('error', (error) => {
                console.error('[YouTube Provider] 执行 yt-dlp (下载) 失败:', error);
                reject(error);
            });
            ytDlpEventEmitter.on('close', () => {
                console.log('[YouTube Provider] yt-dlp 进程成功关闭。');
                const finalMp4Path = path.join(outputDir, `${filename}.mp4`);
                if (fs.existsSync(finalMp4Path)) {
                    resolve(finalMp4Path);
                } else {
                    const files = fs.readdirSync(outputDir);
                    const match = files.find(f => f.startsWith(filename) && ['.mp4', '.mkv', '.webm'].some(ext => f.endsWith(ext)));
                    if (match) {
                        resolve(path.join(outputDir, match));
                    } else {
                        // 即使找不到，也 resolve 预期的路径，让后续逻辑处理
                        resolve(finalMp4Path);
                    }
                }
            });
        });
    }
}