// src/backend/providers/jable.js

import { BrowserWindow, session } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createDecipheriv } from 'crypto';
import { exec } from 'child_process';
import * as m3u8Parser from 'm3u8-parser';
import pLimit from 'p-limit';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

const CONCURRENT_LIMIT = 64;
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://jable.tv/',
    'Origin': 'https://jable.tv',
    'Connection': 'keep-alive'
};

function extractM3u8(html, pageUrl) {
    const text = html.replace(/\\\//g, '/').replace(/\\u002f/gi, '/').replace(/&amp;/g, '&');
    const absolute = text.match(/https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?/i);
    const relative = text.match(/["']([^"']+\.m3u8(?:\?[^"']*)?)["']/i);
    const candidate = absolute?.[0] || relative?.[1];
    return candidate ? new URL(candidate, pageUrl).toString() : null;
}

function pageMeta(html, name) {
    const tag = html.match(new RegExp(`<meta\\b(?=[^>]*\\b(?:property|name)=["']${name}["'])[^>]*>`, 'i'))?.[0];
    return tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1] || '';
}

export class JableProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('jable.tv/videos/');
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['ffmpeg'])) return;
        try {
            this._checkCancelled(signal);
            const number = new URL(videoUrl).pathname.match(/\/videos\/([^/]+)/i)?.[1]?.toUpperCase();
            if (!number) throw new Error('Cannot identify video number from Jable URL');
            this.sendMessage('download-status', { message: 'Parsing Jable video information...', type: 'default' });

            const info = await this._getVideoInfo(videoUrl, signal);
            this.sendMessage('download-status', { message: `Parsed: ${number}`, type: 'default' });
            this._checkCancelled(signal);
            if (!info.m3u8Url) throw new Error('m3u8 playback URL not found');

            const uniqueFilenameBase = await this.libraryService.getNextOrdinal();

            if (info.coverUrl) {
                // 封面也使用唯一文件名
                await downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`, {}, () => {}, 3, signal);
            }

            this.sendMessage('download-status', { message: 'Starting to download and decrypt video segments...', type: 'default' });

            await this._downloadAndProcessM3u8(
                info.m3u8Url,
                this.config.VIDEOS_DIR,
                `${uniqueFilenameBase}.mp4`, // 传递唯一文件名
                (progress) => this.sendMessage('download-status', {
                    message: `Download progress: ${(progress * 100).toFixed(1)}%`,
                    progress: progress,
                    type: 'progress'
                }),
                info.cookieString,
                signal // 传递 signal
            );

            this._checkCancelled(signal);

            await this._addTrackToPlaylist({
                title: number,
                artist: 'Jable TV',
                src: `videos/${uniqueFilenameBase}.mp4`,
                albumArt: fs.existsSync(path.join(this.config.ALBUMART_DIR, `${uniqueFilenameBase}.jpg`)) ? `albumArt/${uniqueFilenameBase}.jpg` : '',
                type: "video",
                originalUrl: videoUrl
            });

            this.sendMessage('download-status', { message: `"${number}" download successful!`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[Jable Provider] Error:', error);
            throw new Error(`Jable download failed: ${error.message}`);
        }
    }

    async _getVideoInfo(videoUrl, signal) {
        console.log(`[Jable Provider] Fetching video info: ${videoUrl}`);
        const number = new URL(videoUrl).pathname.match(/\/videos\/([^/]+)/i)?.[1]?.toUpperCase();
        try {
            const response = await axios.get(videoUrl, {
                headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
                httpsAgent, timeout: 10000, signal
            });
            const m3u8Url = extractM3u8(response.data, videoUrl);
            if (m3u8Url) {
                return {
                    m3u8Url,
                    title: number,
                    coverUrl: pageMeta(response.data, 'og:image'),
                    cookieString: (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ')
                };
            }
        } catch (error) {
            if (signal?.aborted) throw error;
            console.warn('[Jable Provider] Direct page request failed, using browser:', error.message);
        }
        this._checkCancelled(signal);
        const partition = `persist:jable_session_${Date.now()}`;
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                offscreen: true,
                sandbox: true,
                contextIsolation: true,
                partition: partition,
            }
        });

        if (signal) {
            signal.addEventListener('abort', () => { if (!win.isDestroyed()) win.close(); });
        }

        try {
            const jableSession = session.fromPartition(partition);
            jableSession.webRequest.onHeadersReceived((details, callback) => {
                if (details.responseHeaders['Content-Security-Policy']) {
                    delete details.responseHeaders['Content-Security-Policy'];
                }
                callback({ responseHeaders: details.responseHeaders });
            });

            let m3u8Url = null;
            const m3u8Promise = new Promise((resolve) => {
                const filter = { urls: ['*://*/*.m3u8'] };
                jableSession.webRequest.onBeforeRequest(filter, (details, callback) => {
                    if (details.url.includes('.m3u8') && !details.url.includes('preview')) {
                        m3u8Url = details.url;
                        resolve(m3u8Url);
                    }
                    callback({ cancel: false });
                });
            });

            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Fetching m3u8 timeout (30s)')), 30000));
            await win.loadURL(videoUrl);
            await win.webContents.executeJavaScript('document.readyState === "complete"');

            const metaData = await win.webContents.executeJavaScript(`
                (() => ({
                    cover: document.querySelector('video')?.poster || document.querySelector('meta[property="og:image"]')?.content
                }))();
            `);

            m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);
            const cookies = await jableSession.cookies.get({ url: videoUrl });
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            return {
                m3u8Url,
                title: number,
                coverUrl: metaData.cover,
                cookieString
            };

        } catch (error) {
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            throw error;
        } finally {
            if (win && !win.isDestroyed()) win.close();
        }
    }

    async _downloadAndProcessM3u8(m3u8Url, outputDir, filename, onProgress, cookieString, signal) {
        const tempDir = path.join(outputDir, 'temp_' + Date.now());
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const requestHeaders = { ...BASE_HEADERS, 'Cookie': cookieString || '' };

        try {
            this._checkCancelled(signal);
            const m3u8Response = await axios.get(m3u8Url, { headers: requestHeaders, httpsAgent, signal });
            const parser = new m3u8Parser.Parser();
            parser.push(m3u8Response.data);
            parser.end();
            const segments = parser.manifest.segments;
            if (!segments || segments.length === 0) throw new Error('m3u8 parsing failed: No video segments found');

            const { key, iv } = await this._getDecryptionKey(segments[0], m3u8Url, requestHeaders, signal);

            const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
            const totalSegments = segments.length;
            let downloadedCount = 0;
            const limit = pLimit(CONCURRENT_LIMIT);

            const segmentFileNames = [];
            const tasks = segments.map((seg, index) => {
                const segFilename = `${String(index).padStart(5, '0')}.ts`;
                segmentFileNames.push(segFilename);
                const segPath = path.join(tempDir, segFilename);
                const segUrl = seg.uri.startsWith('http') ? seg.uri : new URL(seg.uri, baseUrl).toString();
                return limit(async () => {
                    this._checkCancelled(signal);
                    await this._downloadSegmentWithRetry(segUrl, segPath, key, iv, requestHeaders, 1, signal);
                    downloadedCount++;
                    if (onProgress) onProgress(downloadedCount / totalSegments);
                });
            });
            await Promise.all(tasks);

            this._checkCancelled(signal);
            console.log(`[Jable Provider] Download complete, performing binary merge...`);
            const combinedTsPath = path.join(outputDir, `combined_${Date.now()}.ts`);
            await this._mergeFiles(tempDir, segmentFileNames.sort(), combinedTsPath);

            console.log(`[Jable Provider] Merge complete, remuxing to MP4...`);
            const finalMp4Path = path.join(outputDir, filename);
            await this._remuxToMp4(combinedTsPath, finalMp4Path);

            if (fs.existsSync(combinedTsPath)) fs.unlinkSync(combinedTsPath);
            return finalMp4Path;

        } finally {
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    async _getDecryptionKey(segment, m3u8Url, headers, signal) {
        if (!segment.key || segment.key.method !== 'AES-128') return { key: null, iv: null };
        const keyObj = segment.key;
        const keyUrl = new URL(keyObj.uri, m3u8Url).toString();
        const keyResponse = await axios.get(keyUrl, { responseType: 'arraybuffer', headers, httpsAgent, signal });
        const key = Buffer.from(keyResponse.data);
        let iv = Buffer.alloc(16, 0);

        if (keyObj.iv) {
            if (typeof keyObj.iv === 'string') {
                iv = Buffer.from(keyObj.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
            } else {
                const tempIv = Buffer.from(keyObj.iv);
                if (tempIv.length !== 16) tempIv.copy(iv);
                else iv = tempIv;
            }
        }
        return { key, iv };
    }

    async _downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt = 1, signal) {
        if (signal && signal.aborted) throw new Error('Download aborted by user');
        if (fs.existsSync(destPath) && (await fs.promises.stat(destPath)).size > 0) return;
        try {
            const response = await axios({ url, method: 'GET', responseType: 'arraybuffer', headers, httpsAgent, timeout: 20000, signal });
            let data = Buffer.from(response.data);
            if (key && iv) {
                const decipher = createDecipheriv('aes-128-cbc', key, iv);
                data = Buffer.concat([decipher.update(data), decipher.final()]);
            }
            await fs.promises.writeFile(destPath, data);
        } catch (error) {
            if (signal && signal.aborted) throw error;
            const maxRetries = 5;
            if (attempt <= maxRetries) {
                const delay = (error.response?.status === 429) ? 2000 * attempt : 1000;
                await new Promise(r => setTimeout(r, delay));
                return this._downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt + 1, signal);
            }
            throw error;
        }
    }

    async _mergeFiles(tempDir, fileNames, outputPath) {
        const writeStream = fs.createWriteStream(outputPath);
        for (const fileName of fileNames) {
            const filePath = path.join(tempDir, fileName);
            if (!fs.existsSync(filePath)) continue;
            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(filePath);
                readStream.pipe(writeStream, { end: false });
                readStream.on('end', resolve);
                readStream.on('error', reject);
            });
        }
        return new Promise((resolve, reject) => {
            writeStream.end();
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    async _remuxToMp4(inputTs, outputMp4) {
        const command = `"${this.ffmpegPath}" -y -i "${inputTs}" -c copy -bsf:a aac_adtstoasc -movflags +faststart "${outputMp4}"`;
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) reject(new Error(`Remuxing failed: ${error.message}`));
                else resolve();
            });
        });
    }
}