// src/backend/providers/generic-ytdlp.js

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

/**
 * @class GenericYtDlpProvider
 * @description 通用的 yt-dlp 下载提供者。
 *              作为一个“兜底”策略，它尝试处理所有未被专用 Provider 捕获的 URL。
 *              支持 Bilibili, YouTube, SoundCloud, Vimeo 等数千个网站。
 * @extends BaseProvider
 */
export class GenericYtDlpProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否适用于给定的 URL。
     * 作为通用 Provider，它总是返回 true，但应该在 ProviderRegistry 中排在最后，
     * 以便让专用 Provider（如抖音、IYF）优先处理。
     * 排除非 HTTP 协议（如 file://）。
     */
    isApplicable(url) {
        return url.startsWith('http://') || url.startsWith('https://');
    }

    /**
     * 执行下载任务。
     * @param {string} videoUrl - 视频链接
     * @param {AbortSignal} signal - 取消信号
     */
    async execute(videoUrl, signal) {
        // 1. 检查核心工具是否存在
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) {
            return;
        }

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '正在解析视频元数据...', type: 'default' });

            // 2. 获取视频信息 (JSON)
            const info = await this._getVideoInfo(videoUrl, signal);
            this._checkCancelled(signal);

            // 3. 准备文件名和封面
            // 优先使用 title，如果没有则使用 ID，最后使用 fallback
            const title = info.title || info.id || 'Unknown_Video';
            // 【核心修改】使用时间戳和视频ID生成唯一文件名，而不是清理后的标题
            const uniqueFilenameBase = `media_ytdlp_${info.id || Date.now()}`;


            // 下载封面 (如果有)
            if (info.thumbnail) {
                // 异步下载封面，不阻塞主流程，但会响应取消信号
                downloadFile(info.thumbnail, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, {}, () => {}, 3, signal)
                    .catch(e => {
                        if (!signal || !signal.aborted) console.warn('[GenericYtDlp] 封面下载轻微错误:', e.message);
                    });
            }

            this.sendMessage('download-status', { message: `解析成功: ${title}，准备下载...`, type: 'default' });

            // 4. 调用 yt-dlp 进行下载
            const finalFilePath = await this._downloadVideoWithYtDlp(
                videoUrl,
                this.config.VIDEOS_DIR,
                uniqueFilenameBase, // 使用唯一文件名
                (progress) => this.sendMessage('download-status', {
                    message: `下载进度: ${(progress * 100).toFixed(1)}%`,
                    progress: progress,
                    type: 'progress'
                }),
                signal
            );

            this._checkCancelled(signal);

            // 5. 添加到媒体库播放列表
            await this._addTrackToPlaylist({
                title: title,
                // 尝试获取上传者名称，顺序: uploader -> channel -> uploader_id -> 未知
                artist: info.uploader || info.channel || info.uploader_id || 'Unknown Artist',
                src: `videos/${path.basename(finalFilePath)}`,
                // 检查封面文件是否存在，如果存在则设置路径
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`))
                    ? `albumArt/${uniqueFilenameBase}.jpg`
                    : '',
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${title}" 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[GenericYtDlp] Error:', error);
            // 提取 yt-dlp 的错误信息简化显示
            let msg = error.message;
            if (msg.includes('ERROR:')) {
                msg = msg.split('ERROR:')[1].split('\n')[0].trim();
            }
            throw new Error(`下载失败: ${msg}`);
        }
    }

    /**
     * 强力终止进程的辅助方法 (兼容 Windows/Unix)
     * 用于在用户取消时彻底杀死 yt-dlp 及其子进程(ffmpeg)
     */
    _killProcess(processInstance) {
        if (!processInstance) return;

        try {
            const pid = processInstance.pid;
            if (process.platform === 'win32') {
                // Windows: 使用 taskkill /F (强制) /T (包括子进程) /PID
                spawn('taskkill', ['/pid', pid, '/f', '/t']);
            } else {
                // Unix/Linux/macOS
                processInstance.kill('SIGKILL');
            }
            console.log(`[GenericYtDlp] 已强力终止进程 PID: ${pid}`);
        } catch (e) {
            console.error('[GenericYtDlp] 终止进程失败:', e);
        }
    }

    /**
     * 获取视频元数据
     */
    async _getVideoInfo(videoUrl, signal) {
        return new Promise((resolve, reject) => {
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--dump-json',       // 仅输出 JSON
                '--no-playlist',     // 仅处理单个视频，不处理列表
                '--force-ipv4',      // 强制 IPv4 提高兼容性
                '--socket-timeout', '60',
                '--no-warnings',
                '--ignore-errors'    // 忽略非致命错误
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);

            // 传递配置的 User-Agent
            if (this.spoofedUserAgent) args.push('--user-agent', this.spoofedUserAgent);

            args.push(videoUrl);

            const emitter = ytDlpWrap.exec(args);
            let stdout = '';
            let stderr = '';

            // 收集输出流
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
                // 如果用户已取消，直接返回
                if (signal && signal.aborted) return reject(new Error('Download aborted by user'));

                if (code === 0) {
                    try {
                        let info;
                        const trimmedOutput = stdout.trim();
                        if (!trimmedOutput) throw new Error('yt-dlp 返回了空数据');

                        try {
                            info = JSON.parse(trimmedOutput);
                        } catch (e) {
                            // 处理可能的多行 JSON (例如播放列表混合输出)
                            // 尝试找到第一行看起来像 JSON 的
                            const lines = trimmedOutput.split(/\r?\n/);
                            const jsonLine = lines.find(line => line.trim().startsWith('{') && line.trim().endsWith('}'));
                            if (jsonLine) info = JSON.parse(jsonLine);
                            else throw e;
                        }

                        // 返回标准化的信息对象
                        resolve({
                            id: info.id,
                            title: info.title,
                            uploader: info.uploader,
                            uploader_id: info.uploader_id,
                            channel: info.channel,
                            thumbnail: info.thumbnail,
                            duration: info.duration,
                        });
                    } catch (e) {
                        console.error('[GenericYtDlp] JSON 解析失败。Stderr:', stderr);
                        reject(new Error(`无法解析视频信息: ${e.message}`));
                    }
                } else {
                    reject(new Error(`yt-dlp 进程异常退出 (Code ${code}): ${stderr}`));
                }
            });

            emitter.on('error', (err) => reject(err));

            // 监听取消信号
            if (signal) {
                signal.addEventListener('abort', () => {
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }

    /**
     * 执行下载
     */
    _downloadVideoWithYtDlp(videoUrl, outputDir, filename, onProgress, signal) {
        return new Promise((resolve, reject) => {
            // 使用占位符，让 yt-dlp 自动处理后缀
            const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--force-ipv4',
                '--socket-timeout', '60',
                '--no-playlist',
                // 格式选择策略：优先 MP4 视频+M4A 音频，或者是最佳 MP4，或者任意最佳格式
                '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--ffmpeg-location', ffmpegDir,
                // 如果需要合并，指定输出容器为 mp4
                '--merge-output-format', 'mp4',
                '--output', outputPath,
                '--no-warnings'
            ];

            if (this.systemProxy) args.push('--proxy', this.systemProxy);
            if (this.spoofedUserAgent) args.push('--user-agent', this.spoofedUserAgent);

            args.push(videoUrl);

            const emitter = ytDlpWrap.exec(args);

            // 监听进度
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

                if (code !== 0) {
                    return reject(new Error(`下载进程退出码非零: ${code}`));
                }

                // 查找最终生成的文件
                // 优先查找 .mp4，其次是 .mkv, .webm
                const possibleExts = ['.mp4', '.mkv', '.webm'];
                let foundPath = null;
                const mp4Path = path.join(outputDir, `${filename}.mp4`);

                if (fs.existsSync(mp4Path)) {
                    foundPath = mp4Path;
                } else {
                    // 模糊匹配
                    const files = fs.readdirSync(outputDir);
                    const match = files.find(f => f.startsWith(filename) && possibleExts.some(ext => f.endsWith(ext)));
                    if (match) foundPath = path.join(outputDir, match);
                }

                if (foundPath) resolve(foundPath);
                else resolve(mp4Path); // 如果没找到，返回预期的 mp4 路径（虽然可能不存在，由上层处理错误）
            });

            // 监听取消信号
            if (signal) {
                signal.addEventListener('abort', () => {
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }
}