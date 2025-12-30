// src/backend/providers/bilibili.js

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process'; // 【核心新增】导入 spawn 用于执行 taskkill
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

/**
 * @class BilibiliProvider
 * @description Bilibili 视频下载服务提供者 (基于 yt-dlp 重构版)。
 *              【修复】使用 taskkill 彻底杀死 Windows 下的 yt-dlp 进程树。
 * @extends BaseProvider
 */
export class BilibiliProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('bilibili.com/video/') || url.includes('b23.tv');
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) {
            return;
        }

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '正在获取 B站 视频信息...', type: 'default' });

            const info = await this._getVideoInfo(videoUrl, signal);
            this._checkCancelled(signal);

            const safeFilename = this._sanitizeFilename(info.title);

            if (info.thumbnail) {
                downloadFile(info.thumbnail, this.config.ALBUMART_DIR, `${safeFilename}.jpg`, {}, () => {}, 3, signal)
                    .catch(e => {
                        if (!signal || !signal.aborted) console.warn('[Bilibili Provider] 封面下载轻微错误:', e.message);
                    });
            }

            this.sendMessage('download-status', { message: '正在调用 yt-dlp 下载并合并...', type: 'default' });

            const finalFilePath = await this._downloadVideoWithYtDlp(
                videoUrl,
                this.config.VIDEOS_DIR,
                safeFilename,
                (progress) => this.sendMessage('download-status', {
                    message: `下载进度: ${(progress * 100).toFixed(1)}%`,
                    progress: progress,
                    type: 'progress'
                }),
                signal
            );

            this._checkCancelled(signal);

            await this._addTrackToPlaylist({
                title: info.title,
                artist: info.uploader || 'Bilibili',
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: `albumArt/${safeFilename}.jpg`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[Bilibili Provider] Error:', error);
            throw new Error(`B站下载失败: ${error.message}`);
        }
    }

    /**
     * 强力终止进程的辅助方法
     */
    _killProcess(processInstance) {
        if (!processInstance) return;

        try {
            const pid = processInstance.pid;
            if (process.platform === 'win32') {
                // Windows: 使用 taskkill /F (强制) /T (包括子进程) /PID
                // 这能确保连同 yt-dlp 启动的 ffmpeg 一起杀掉
                spawn('taskkill', ['/pid', pid, '/f', '/t']);
            } else {
                // Unix/Linux/macOS
                processInstance.kill('SIGKILL');
            }
            console.log(`[Bilibili] 已强力终止进程 PID: ${pid}`);
        } catch (e) {
            console.error('[Bilibili] 终止进程失败:', e);
        }
    }

    async _getVideoInfo(videoUrl, signal) {
        return new Promise((resolve, reject) => {
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--dump-json',
                '--no-playlist',
                '--force-ipv4',
                '--socket-timeout', '60',
                '--no-warnings'
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            const emitter = ytDlpWrap.exec(args);
            let stdout = '';
            let stderr = '';

            if (emitter.ytDlpProcess) {
                if (emitter.ytDlpProcess.stdout) {
                    emitter.ytDlpProcess.stdout.on('data', (chunk) => {
                        stdout += chunk.toString();
                    });
                }
                if (emitter.ytDlpProcess.stderr) {
                    emitter.ytDlpProcess.stderr.on('data', (chunk) => {
                        stderr += chunk.toString();
                    });
                }
            }

            emitter.on('close', (code) => {
                if (signal && signal.aborted) return reject(new Error('Download aborted by user'));

                if (code === 0) {
                    try {
                        let info;
                        const trimmedOutput = stdout.trim();
                        if (!trimmedOutput) throw new Error('yt-dlp 返回了空数据');

                        try {
                            info = JSON.parse(trimmedOutput);
                        } catch (e) {
                            const lines = trimmedOutput.split(/\r?\n/);
                            const jsonLine = lines.find(line => line.trim().startsWith('{') && line.trim().endsWith('}'));
                            if (jsonLine) info = JSON.parse(jsonLine);
                            else throw e;
                        }

                        resolve({
                            title: info.title || '未知标题',
                            uploader: info.uploader || '未知UP主',
                            thumbnail: info.thumbnail,
                            duration: info.duration,
                        });
                    } catch (e) {
                        console.error('[Bilibili Provider] JSON 解析失败。Stderr:', stderr);
                        reject(new Error(`解析视频元数据失败: ${e.message}`));
                    }
                } else {
                    reject(new Error(`yt-dlp 进程异常退出 (Code ${code}): ${stderr}`));
                }
            });

            emitter.on('error', (err) => reject(err));

            if (signal) {
                signal.addEventListener('abort', () => {
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }

    _downloadVideoWithYtDlp(videoUrl, outputDir, filename, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--force-ipv4',
                '--socket-timeout', '60',
                '--no-playlist',
                '-f', 'bestvideo+bestaudio/best',
                '--ffmpeg-location', ffmpegDir,
                '--merge-output-format', 'mp4',
                '--output', outputPath,
                '--no-warnings'
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            args.push(videoUrl);

            const emitter = ytDlpWrap.exec(args);

            emitter.on('progress', (progress) => {
                if (onProgress && progress.percent) {
                    onProgress(progress.percent / 100);
                }
            });

            emitter.on('error', (error) => reject(error));

            emitter.on('close', (code) => {
                if (signal && signal.aborted) {
                    return reject(new Error('Download aborted by user'));
                }

                const possibleExts = ['.mp4', '.mkv', '.webm'];
                let foundPath = null;
                const mp4Path = path.join(outputDir, `${filename}.mp4`);
                if (fs.existsSync(mp4Path)) {
                    foundPath = mp4Path;
                } else {
                    const files = fs.readdirSync(outputDir);
                    const match = files.find(f => f.startsWith(filename) && possibleExts.some(ext => f.endsWith(ext)));
                    if (match) foundPath = path.join(outputDir, match);
                }

                if (foundPath) resolve(foundPath);
                else resolve(mp4Path);
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    // 【核心修复】调用强力终止方法
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }
}