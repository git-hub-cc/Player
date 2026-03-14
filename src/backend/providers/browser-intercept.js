// src/backend/providers/browser-intercept.js
//
// 通用浏览器拦截 Provider（兜底策略）。
// 对未被专用 Provider 匹配的任意 HTTP 页面，启动隐身 BrowserWindow，
// 监听网络请求，捕获 .m3u8 地址后交给 yt-dlp 下载。
// 注册顺序应在所有专用 Provider 之后，generic-ytdlp 之前。
// 注意：yt-dlp 原生支持的网站（Bilibili、YouTube 等）会被排除，由 GenericYtDlpProvider 处理。

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

/**
 * yt-dlp 原生支持、应优先使用 GenericYtDlpProvider 处理的域名列表。
 * 这些网站不需要浏览器拦截，yt-dlp 能直接解析。
 */
const YTDLP_SUPPORTED_DOMAINS = [
    // 视频平台
    'bilibili.com', 'b23.tv',                        // B站
    'youtube.com', 'youtu.be',                        // YouTube
    'vimeo.com',                                      // Vimeo
    'dailymotion.com',                                // Dailymotion
    'twitch.tv',                                      // Twitch
    'nicovideo.jp', 'nico.ms',                        // NicoNico
    'tiktok.com',                                     // TikTok
    'twitter.com', 'x.com',                           // Twitter/X
    'facebook.com', 'fb.watch',                       // Facebook
    'instagram.com',                                  // Instagram
    'reddit.com', 'v.redd.it',                        // Reddit
    'soundcloud.com',                                 // SoundCloud
    'bandcamp.com',                                   // Bandcamp
    'mixcloud.com',                                   // Mixcloud
    'weibo.com',                                      // 微博
    'ixigua.com',                                     // 西瓜
    'kuaishou.com', 'gifshow.com',                    // 快手
    'huya.com', 'douyu.com', 'live.bilibili.com',     // 直播平台（非浏览器拦截专用）
];

export class BrowserInterceptProvider extends BaseProvider {
    /**
     * 匹配所有 HTTP/HTTPS URL，但排除 yt-dlp 原生支持的网站（让它们走 GenericYtDlpProvider）。
     * 优先级应低于所有专用 Provider，且在 GenericYtDlpProvider 之前注册。
     */
    isApplicable(url) {
        if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            // 如果是 yt-dlp 已知支持的域名，跳过，交给 GenericYtDlpProvider
            const isYtDlpSupported = YTDLP_SUPPORTED_DOMAINS.some(
                domain => hostname === domain || hostname.endsWith('.' + domain)
            );
            if (isYtDlpSupported) {
                console.log(`[BrowserIntercept] Skipping yt-dlp supported site: ${hostname}`);
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['yt-dlp', 'ffmpeg'])) return;

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: 'Launching browser to intercept M3U8 URL...', type: 'default' });

            const info = await this._interceptM3u8FromPage(videoUrl, signal);
            this._checkCancelled(signal);

            if (!info.m3u8Url) throw new Error('Failed to intercept M3U8 URL from page, please try yt-dlp direct download.');

            this.sendMessage('download-status', { message: `Intercepted successfully, preparing download: ${info.title}`, type: 'default' });

            const uniqueFilenameBase = `media_browser_${Date.now()}`;
            const referer = new URL(videoUrl).origin + '/';
            const headers = { 'User-Agent': DEFAULT_UA, 'Referer': referer, 'Cookie': info.cookieString || '' };

            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, headers, () => { }, 3, signal)
                    .catch(e => { if (!signal?.aborted) console.warn('[BrowserIntercept] Thumbnail download failed:', e.message); });
            }

            const finalFilePath = await this._downloadWithYtDlp(
                info.m3u8Url,
                this.config.VIDEOS_DIR,
                uniqueFilenameBase,
                info.cookieString,
                referer,
                (progress) => this.sendMessage('download-status', {
                    message: `Download progress: ${(progress * 100).toFixed(1)}%`,
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

            this.sendMessage('download-status', { message: `"${info.title}" download successful!`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[BrowserIntercept Provider] Error:', error);
            throw new Error(`Browser intercept download failed: ${error.message}`);
        }
    }

    /**
     * Launches a virtual browser to load the page, intercepts the first non-preview .m3u8 request,
     * and simultaneously retrieves the page title, cover, and cookies.
     */
    async _interceptM3u8FromPage(pageUrl, signal) {
        console.log(`[BrowserIntercept] Starting browser intercept: ${pageUrl}`);
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

            // Inject User-Agent
            browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
                details.requestHeaders['User-Agent'] = DEFAULT_UA;
                callback({ cancel: false, requestHeaders: details.requestHeaders });
            });

            // Intercept m3u8 / HLS stream requests
            // Use a broad URL filter, then make precise judgments in the callback,
            // to be compatible with URLs that contain the m3u8 keyword but do not end with .m3u8.
            const m3u8Promise = new Promise((resolve) => {
                // Listen for both standard paths and URLs containing m3u8 parameters
                const filter = { urls: ['<all_urls>'] };
                let resolved = false;
                browserSession.webRequest.onBeforeRequest(filter, (details, callback) => {
                    const url = details.url;
                    // Determine if it's an m3u8/HLS stream address
                    const isM3u8 = (
                        url.includes('.m3u8') ||
                        url.includes('/hls/') ||
                        url.includes('playlist.m3u8') ||
                        (url.includes('m3u8') && (details.resourceType === 'xhr' || details.resourceType === 'fetch' || details.resourceType === 'media'))
                    );
                    const isPreview = url.toLowerCase().includes('preview') || url.includes('_small') || url.includes('tiny');
                    if (!resolved && isM3u8 && !isPreview) {
                        resolved = true;
                        console.log(`[BrowserIntercept] Intercepted m3u8/HLS stream: ${url}`);
                        resolve(url);
                    }
                    callback({ cancel: false });
                });
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Intercept m3u8 timeout (${INTERCEPT_TIMEOUT_MS / 1000}s), the page might not contain HLS stream.`)), INTERCEPT_TIMEOUT_MS)
            );

            await win.loadURL(pageUrl);
            const m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);

            // Get page metadata
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
            console.error('[BrowserIntercept] Page load or intercept failed:', error);
            throw error;
        } finally {
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    /**
     * Downloads m3u8 using yt-dlp, with cookies and referer obtained from the browser.
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
                if (code !== 0) return reject(new Error(`yt-dlp download failed, exit code: ${code}`));

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
