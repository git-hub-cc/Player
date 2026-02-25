// src/backend/providers/iyf.js

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

const IYF_REFERER = 'https://www.iyf.lv/';
const IYF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class IyfProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('iyf.lv') || url.includes('iyf.tv');
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) return;

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '正在启动隐身窗口拦截 M3U8 地址...', type: 'default' });

            const info = await this._getVideoInfo(videoUrl, signal);
            this._checkCancelled(signal);

            if (!info.m3u8Url) throw new Error('未能在页面中拦截到有效的 M3U8 地址');

            this.sendMessage('download-status', { message: `解析成功: ${info.title}`, type: 'default' });

            const uniqueFilenameBase = `media_iyf_${Date.now()}`;
            const headers = {
                'User-Agent': IYF_USER_AGENT,
                'Referer': IYF_REFERER,
                'Cookie': info.cookieString || ''
            };

            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, headers, () => { }, 3, signal)
                    .catch(e => { if (!signal.aborted) console.warn('[Iyf Provider] 封面下载失败:', e.message); });
            }

            this.sendMessage('download-status', { message: '正在调用 yt-dlp 下载视频...', type: 'default' });

            const finalFilePath = await this._downloadWithYtDlp(
                info.m3u8Url,
                this.config.VIDEOS_DIR,
                uniqueFilenameBase,
                info.cookieString,
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
                artist: 'IYF',
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`)) ? `albumArt/${uniqueFilenameBase}.jpg` : '',
                type: 'video'
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[Iyf Provider] 错误:', error);
            throw new Error(`IYF 下载失败: ${error.message}`);
        }
    }

    /**
     * 启动虚拟浏览器，注册网络请求拦截来捕获 m3u8 URL，同时获取标题、封面和 Cookie。
     */
    async _getVideoInfo(videoUrl, signal) {
        console.log(`[Iyf Provider] 正在启动浏览器拦截 m3u8: ${videoUrl}`);

        const partition = `persist:iyf_session_${Date.now()}`;
        const win = new BrowserWindow({
            show: false,
            width: 1280,
            height: 800,
            webPreferences: {
                offscreen: true,
                partition: partition,
                sandbox: true,
                contextIsolation: true,
                webSecurity: false
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                if (!win.isDestroyed()) win.destroy();
            });
        }

        try {
            const iyfSession = session.fromPartition(partition);

            // 修改请求头，注入 User-Agent 和 Referer
            iyfSession.webRequest.onBeforeSendHeaders((details, callback) => {
                details.requestHeaders['User-Agent'] = IYF_USER_AGENT;
                if (details.url.includes('iyf')) {
                    details.requestHeaders['Referer'] = IYF_REFERER;
                }
                callback({ cancel: false, requestHeaders: details.requestHeaders });
            });

            // 注册 m3u8 URL 拦截
            let resolveM3u8;
            const m3u8Promise = new Promise((resolve) => {
                resolveM3u8 = resolve;
                const filter = { urls: ['*://*/*.m3u8', '*://*/*.m3u8?*'] };
                iyfSession.webRequest.onBeforeRequest(filter, (details, callback) => {
                    const url = details.url;
                    // 过滤预览片段，只捕获真正的播放列表
                    if (url.includes('.m3u8') && !url.includes('preview')) {
                        console.log(`[Iyf Provider] 拦截到 m3u8: ${url}`);
                        resolve(url);
                    }
                    callback({ cancel: false });
                });
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('拦截 m3u8 超时 (60秒)，请确认页面可以正常播放视频。')), 60000)
            );

            // 加载页面，触发播放器初始化
            await win.loadURL(videoUrl);

            // 等待 m3u8 URL 出现（或超时）
            const m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);
            this.sendMessage('download-status', { message: `拦截成功，准备下载...`, type: 'default' });

            // 获取页面元数据和 Cookie
            const metaData = await win.webContents.executeJavaScript(`
                (() => ({
                    title: document.querySelector('meta[property="og:title"]')?.content || document.title || 'Unknown',
                    cover: document.querySelector('meta[property="og:image"]')?.content || null
                }))();
            `).catch(() => ({ title: 'IYF Video', cover: null }));

            const cookies = await iyfSession.cookies.get({ url: videoUrl });
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            let title = metaData.title.replace(/[-|]?\s*爱壹帆.*/, '').trim() || 'IYF Video';
            let coverUrl = metaData.cover;
            if (coverUrl && coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;

            return { title, coverUrl, m3u8Url, cookieString };

        } catch (error) {
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            console.error('[Iyf Provider] BrowserWindow 解析失败:', error);
            throw error;
        } finally {
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    /**
     * 调用 yt-dlp 下载 m3u8 视频流，携带 Cookie 和 Referer 以通过鉴权。
     */
    _downloadWithYtDlp(m3u8Url, outputDir, filename, cookieString, onProgress, signal) {
        return new Promise((resolve, reject) => {
            // 使用 %(ext)s 占位符让 yt-dlp 决定最终扩展名，再 remux 到 mp4
            const outputTemplate = path.join(outputDir, `${filename}.%(ext)s`);
            const ffmpegDir = path.dirname(this.ffmpegPath);
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(this.ytDlpPath);

            const args = [
                '--no-playlist',
                '--force-ipv4',
                '--socket-timeout', '60',
                // 下载最佳质量
                '-f', 'best',
                // 用 ffmpeg 重封装为真正的 mp4（moov atom 在文件头，浏览器可直接播放）
                '--ffmpeg-location', ffmpegDir,
                '--merge-output-format', 'mp4',
                // 传递鉴权信息
                '--add-header', `Referer:${IYF_REFERER}`,
                '--add-header', `User-Agent:${IYF_USER_AGENT}`,
                '--output', outputTemplate,
                '--no-warnings',
            ];

            // 传入 Cookie
            if (cookieString) {
                args.push('--add-header', `Cookie:${cookieString}`);
            }

            // 传入代理
            if (this.systemProxy) {
                args.push('--proxy', this.systemProxy);
            }

            args.push(m3u8Url);

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
                if (code !== 0) {
                    return reject(new Error(`yt-dlp 下载失败，退出码: ${code}`));
                }

                // 按优先级查找生成的文件：mp4 > mkv > webm > ts
                const mp4Path = path.join(outputDir, `${filename}.mp4`);
                if (fs.existsSync(mp4Path)) {
                    resolve(mp4Path);
                } else {
                    const files = fs.readdirSync(outputDir);
                    const match = files.find(f =>
                        f.startsWith(filename) && ['.mp4', '.mkv', '.webm', '.ts'].some(ext => f.endsWith(ext))
                    );
                    resolve(match ? path.join(outputDir, match) : mp4Path);
                }
            });

            if (signal) {
                signal.addEventListener('abort', () => {
                    this._killProcess(emitter.ytDlpProcess);
                    reject(new Error('Download aborted by user'));
                });
            }
        });
    }

    /**
     * 强力终止 yt-dlp 进程（包括子进程），兼容 Windows 和 Unix。
     */
    _killProcess(processInstance) {
        if (!processInstance) return;
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', processInstance.pid, '/f', '/t']);
            } else {
                processInstance.kill('SIGKILL');
            }
            console.log(`[Iyf Provider] 已终止进程 PID: ${processInstance.pid}`);
        } catch (e) {
            console.error('[Iyf Provider] 终止进程失败:', e);
        }
    }
}