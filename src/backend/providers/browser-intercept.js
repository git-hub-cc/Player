// src/backend/providers/browser-intercept.js
//
// 通用浏览器拦截 Provider（兜底策略）。
// 对未被专用 Provider 匹配的任意 HTTP 页面，启动隐身 BrowserWindow，
// 监听网络请求，捕获 .m3u8 地址后交给 yt-dlp 下载。
// 注册顺序应在所有专用 Provider 之后，generic-ytdlp 之前。

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import YTDlpWrap from 'yt-dlp-wrap-plus';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 等待 m3u8 出现的超时时间（毫秒）
const INTERCEPT_TIMEOUT_MS = 60000;

export class BrowserInterceptProvider extends BaseProvider {
    /**
     * 匹配所有 HTTP/HTTPS URL，作为兜底。
     * 优先级应低于所有专用 Provider（在注册时放在倒数第二，generic-ytdlp 最后）。
     */
    isApplicable(url) {
        return url.startsWith('http://') || url.startsWith('https://');
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) return;

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '正在启动浏览器拦截 M3U8 地址...', type: 'default' });

            const info = await this._interceptM3u8FromPage(videoUrl, signal);
            this._checkCancelled(signal);

            if (!info.m3u8Url) throw new Error('未能从页面中拦截到 M3U8 地址，请尝试使用 yt-dlp 直接下载。');

            this.sendMessage('download-status', { message: `拦截成功，准备下载: ${info.title}`, type: 'default' });

            const uniqueFilenameBase = `media_browser_${Date.now()}`;
            const referer = new URL(videoUrl).origin + '/';
            const headers = { 'User-Agent': DEFAULT_UA, 'Referer': referer, 'Cookie': info.cookieString || '' };

            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, headers, () => { }, 3, signal)
                    .catch(e => { if (!signal?.aborted) console.warn('[BrowserIntercept] 封面下载失败:', e.message); });
            }

            const finalFilePath = await this._downloadWithYtDlp(
                info.m3u8Url,
                this.config.VIDEOS_DIR,
                uniqueFilenameBase,
                info.cookieString,
                referer,
                (progress) => this.sendMessage('download-status', {
                    message: `下载进度: ${(progress * 100).toFixed(1)}%`,
                    progress,
                    type: 'progress'
                }),
                signal
            );

            this._checkCancelled(signal);

            await this._addTrackToPlaylist({
                title: info.title,
                artist: new URL(videoUrl).hostname,
                src: `videos/${path.basename(finalFilePath)}`,
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`))
                    ? `albumArt/${uniqueFilenameBase}.jpg` : '',
                type: 'video'
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[BrowserIntercept Provider] 错误:', error);
            throw new Error(`浏览器拦截下载失败: ${error.message}`);
        }
    }

    /**
     * 启动虚拟浏览器加载页面，拦截第一个非预览 .m3u8 请求，
     * 同时获取页面标题、封面和 Cookie。
     */
    async _interceptM3u8FromPage(pageUrl, signal) {
        console.log(`[BrowserIntercept] 正在启动浏览器拦截: ${pageUrl}`);
        const partition = `persist:browser_intercept_${Date.now()}`;
        const win = new BrowserWindow({
            show: false,
            width: 1280,
            height: 800,
            webPreferences: {
                offscreen: true,
                partition,
                sandbox: true,
                contextIsolation: true,
                webSecurity: false
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => { if (!win.isDestroyed()) win.destroy(); });
        }

        try {
            const browserSession = session.fromPartition(partition);

            // 注入 User-Agent
            browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
                details.requestHeaders['User-Agent'] = DEFAULT_UA;
                callback({ cancel: false, requestHeaders: details.requestHeaders });
            });

            // 拦截 m3u8 请求
            const m3u8Promise = new Promise((resolve) => {
                const filter = { urls: ['*://*/*.m3u8', '*://*/*.m3u8?*'] };
                browserSession.webRequest.onBeforeRequest(filter, (details, callback) => {
                    const url = details.url;
                    if (url.includes('.m3u8') && !url.toLowerCase().includes('preview')) {
                        console.log(`[BrowserIntercept] 拦截到 m3u8: ${url}`);
                        resolve(url);
                    }
                    callback({ cancel: false });
                });
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`拦截 m3u8 超时 (${INTERCEPT_TIMEOUT_MS / 1000}秒)，该页面可能不包含 HLS 视频流。`)), INTERCEPT_TIMEOUT_MS)
            );

            await win.loadURL(pageUrl);
            const m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);

            // 获取页面元数据
            const metaData = await win.webContents.executeJavaScript(`
                (() => ({
                    title: document.querySelector('meta[property="og:title"]')?.content
                           || document.title
                           || 'Unknown',
                    cover: document.querySelector('meta[property="og:image"]')?.content || null
                }))();
            `).catch(() => ({ title: 'Web Video', cover: null }));

            const cookies = await browserSession.cookies.get({ url: pageUrl });
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            let title = (metaData.title || 'Web Video').trim();
            let coverUrl = metaData.cover;
            if (coverUrl && coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;

            return { title, coverUrl, m3u8Url, cookieString };

        } catch (error) {
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            console.error('[BrowserIntercept] 页面加载或拦截失败:', error);
            throw error;
        } finally {
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    /**
     * 使用 yt-dlp 下载 m3u8，附带从浏览器获取的 Cookie 和 Referer。
     */
    _downloadWithYtDlp(m3u8Url, outputDir, filename, cookieString, referer, onProgress, signal) {
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
                '--add-header', `Referer:${referer}`,
                '--add-header', `User-Agent:${DEFAULT_UA}`,
                '--output', outputTemplate,
                '--no-warnings',
            ];

            if (cookieString) args.push('--add-header', `Cookie:${cookieString}`);
            if (this.systemProxy) args.push('--proxy', this.systemProxy);

            args.push(m3u8Url);

            const emitter = ytDlpWrap.exec(args);

            emitter.on('progress', (progress) => {
                if (onProgress && progress.percent) onProgress(progress.percent / 100);
            });
            emitter.on('error', (error) => reject(error));
            emitter.on('close', (code) => {
                if (signal && signal.aborted) return reject(new Error('Download aborted by user'));
                if (code !== 0) return reject(new Error(`yt-dlp 下载失败，退出码: ${code}`));

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
