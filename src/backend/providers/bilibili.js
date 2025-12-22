// src/backend/providers/bilibili.js

import path from 'path';
import fs from 'fs';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

/**
 * @class BilibiliProvider
 * @description Bilibili 视频下载服务提供者 (基于 yt-dlp 重构版)。
 *              利用 yt-dlp 强大的解析能力，支持下载更高分辨率(1080P+/4K)的视频，
 *              并自动处理音视频轨道的合并。
 * @extends BaseProvider
 */
export class BilibiliProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否能处理给定的 URL。
     * @param {string} url - 用户输入的 URL。
     * @returns {boolean} - 如果是 Bilibili 视频链接则返回 true。
     */
    isApplicable(url) {
        return url.includes('bilibili.com/video/') || url.includes('b23.tv');
    }

    /**
     * 执行 Bilibili 视频的下载和处理流程。
     * @param {string} videoUrl - Bilibili 视频链接。
     * @returns {Promise<void>}
     */
    async execute(videoUrl) {
        // 1. 前置检查：B站高清视频通常音视频分离，必须同时存在 yt-dlp 和 FFmpeg 才能合并
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) {
            return;
        }

        try {
            this.sendMessage('download-status', { message: '正在获取 B站 视频信息...', type: 'default' });

            // 2. 使用 yt-dlp 获取视频元信息 (标题, UP主, 封面等)
            const info = await this._getVideoInfo(videoUrl);
            const safeFilename = this._sanitizeFilename(info.title);

            // 3. 下载封面 (非阻塞，即使失败也不影响视频下载)
            if (info.thumbnail) {
                downloadFile(info.thumbnail, this.config.ALBUMART_DIR, `${safeFilename}.jpg`)
                    .catch(e => console.warn('[Bilibili Provider] 封面下载轻微错误:', e.message));
            }

            this.sendMessage('download-status', { message: '正在调用 yt-dlp 下载并合并...', type: 'default' });

            // 4. 执行核心下载流程
            // yt-dlp 会自动处理分段下载和 FFmpeg 合并
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
                artist: info.uploader || 'Bilibili',
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: `albumArt/${safeFilename}.jpg`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            console.error('[Bilibili Provider] Error:', error);
            throw new Error(`B站下载失败: ${error.message}`);
        }
    }

    /**
     * @private
     * 调用 yt-dlp 获取视频 JSON 元数据。
     * @param {string} videoUrl
     * @returns {Promise<Object>}
     */
    async _getVideoInfo(videoUrl) {
        try {
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--dump-json',
                '--no-playlist', // 仅获取单集信息，防止解析整个列表
                '--force-ipv4',  // 强制 IPv4，减少国内网络环境下的解析超时
                '--socket-timeout', '60'
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            console.log(`[Bilibili Provider] 获取信息命令:`, args);
            const stdout = await ytDlpWrap.execPromise(args);
            const info = JSON.parse(stdout);

            return {
                title: info.title,
                uploader: info.uploader,
                thumbnail: info.thumbnail, // B站通常提供高质量封面
                duration: info.duration,
            };
        } catch (error) {
            console.error('[Bilibili Provider] 获取信息失败:', error);
            throw new Error(`解析视频信息失败: ${error.message}`);
        }
    }

    /**
     * @private
     * 调用 yt-dlp 下载视频。
     * @param {string} videoUrl
     * @param {string} outputDir
     * @param {string} filename
     * @param {function} onProgress
     * @returns {Promise<string>} 最终文件路径
     */
    _downloadVideoWithYtDlp(videoUrl, outputDir, filename, onProgress) {
        return new Promise((resolve, reject) => {
            // 使用模板以支持自动扩展名 (通常合并后是 mp4 或 mkv)
            const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);

            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--force-ipv4',
                '--socket-timeout', '60',
                '--no-playlist',
                // 下载最佳视频流和最佳音频流并合并，如果失败则回退到最佳单一文件
                '-f', 'bestvideo+bestaudio/best',
                // 指定 FFmpeg 路径，这是合并音视频的关键
                '--ffmpeg-location', ffmpegDir,
                // 如果需要合并，优先合并为 mp4 容器
                '--merge-output-format', 'mp4',
                '--output', outputPath,
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            console.log(`[Bilibili Provider] 下载命令:`, args);

            const ytDlpEventEmitter = ytDlpWrap.exec(args);

            ytDlpEventEmitter.on('progress', (progress) => {
                if (onProgress && progress.percent) {
                    onProgress(progress.percent / 100);
                }
            });

            ytDlpEventEmitter.on('error', (error) => {
                console.error('[Bilibili Provider] 下载流错误:', error);
                reject(error);
            });

            ytDlpEventEmitter.on('close', () => {
                console.log('[Bilibili Provider] 下载进程结束。');
                // 检查最终生成的文件
                // yt-dlp 可能会根据配置生成 .mp4 或 .mkv
                const possibleExts = ['.mp4', '.mkv', '.webm'];
                let foundPath = null;

                // 优先检查 mp4
                const mp4Path = path.join(outputDir, `${filename}.mp4`);
                if (fs.existsSync(mp4Path)) {
                    foundPath = mp4Path;
                } else {
                    // 扫描目录下匹配的文件
                    const files = fs.readdirSync(outputDir);
                    const match = files.find(f => f.startsWith(filename) && possibleExts.some(ext => f.endsWith(ext)));
                    if (match) {
                        foundPath = path.join(outputDir, match);
                    }
                }

                if (foundPath) {
                    resolve(foundPath);
                } else {
                    // 虽然进程正常退出，但没找到文件，通常是不可能的，除非磁盘写入失败
                    // 尝试 resolve 预期的 mp4 路径，让后续逻辑处理错误
                    resolve(mp4Path);
                }
            });
        });
    }
}