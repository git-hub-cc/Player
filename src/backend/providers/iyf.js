// src/backend/providers/iyf.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import https from 'https';
import { spawn } from 'child_process';
import pLimit from 'p-limit';
import crypto from 'crypto';
import * as m3u8Parser from 'm3u8-parser';
import { BrowserWindow, session } from 'electron';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

const IYF_REFERER = 'https://www.iyf.lv/';
const IYF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CONCURRENT_LIMIT = 32;

const insecureAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    ciphers: 'DEFAULT@SECLEVEL=0',
    minVersion: 'TLSv1'
});

export class IyfProvider extends BaseProvider {
    isApplicable(url) {
        return url.includes('iyf.lv') || url.includes('iyf.tv');
    }

    async execute(videoUrl, signal) {
        if (!this._checkTools(['ffmpeg'])) return;

        let tempDir = null;

        try {
            this._checkCancelled(signal);
            this.sendMessage('download-status', { message: '正在启动隐身窗口解析 IYF 页面...', type: 'default' });

            const info = await this._getVideoInfo(videoUrl, signal);
            this._checkCancelled(signal);

            if (!info.m3u8Url) throw new Error('未能在页面中提取到有效的 M3U8 地址');

            const safeFilename = this._sanitizeFilename(info.title);
            const headers = {
                'User-Agent': IYF_USER_AGENT,
                'Referer': IYF_REFERER,
                'Cookie': info.cookieString || ''
            };

            this.sendMessage('download-status', { message: `解析成功: ${info.title}`, type: 'default' });

            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${safeFilename}.jpg`, headers, () => {}, 3, signal)
                    .catch(e => { if(!signal.aborted) console.warn('[Iyf Provider] 封面下载失败:', e.message) });
            }

            this.sendMessage('download-status', { message: '分析播放列表结构...', type: 'default' });
            const { segments, keyInfo } = await this._parseM3u8Recursive(info.m3u8Url, headers, signal);
            this._checkCancelled(signal);

            if (!segments || segments.length === 0) throw new Error('未找到有效的视频分片');

            tempDir = path.join(this.config.MEDIA_ROOT, `temp_iyf_${Date.now()}`);
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            let decryptionKey = null;
            if (keyInfo && keyInfo.method === 'AES-128' && keyInfo.uri) {
                this.sendMessage('download-status', { message: '检测到加密内容，获取解密密钥...', type: 'default' });
                decryptionKey = await this._downloadKey(keyInfo.uri, info.m3u8Url, headers, signal);
            }
            this._checkCancelled(signal);

            this.sendMessage('download-status', { message: `开始多线程下载 (${CONCURRENT_LIMIT}线程)...`, type: 'default' });

            const downloadedFiles = await this._downloadSegmentsParallel(segments, tempDir, info.m3u8Url, decryptionKey, keyInfo?.iv, headers, signal);
            this._checkCancelled(signal);

            this.sendMessage('download-status', { message: '正在进行二进制流合并...', type: 'default' });
            const combinedTsPath = path.join(tempDir, 'combined.ts');
            await this._mergeFiles(tempDir, downloadedFiles, combinedTsPath);

            this.sendMessage('download-status', { message: '正在修复时间戳并封装为 MP4...', type: 'default' });
            const finalPath = path.join(this.config.VIDEOS_DIR, `${safeFilename}.mp4`);
            await this._remuxToMp4(combinedTsPath, finalPath);

            await this._addTrackToPlaylist({
                title: info.title,
                artist: 'IYF',
                src: `videos/${path.basename(finalPath)}`,
                albumArt: `albumArt/${safeFilename}.jpg`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            if (signal && signal.aborted) throw error;
            console.error('[Iyf Provider] 错误:', error);
            throw new Error(`IYF 下载失败: ${error.message}`);
        } finally {
            if (tempDir && fs.existsSync(tempDir)) {
                setTimeout(() => {
                    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
                }, 2000);
            }
        }
    }

    async _getVideoInfo(videoUrl, signal) {
        console.log(`[Iyf Provider] 正在启动浏览器获取信息: ${videoUrl}`);

        const partition = `persist:iyf_session_${Date.now()}`;
        const win = new BrowserWindow({
            show: false,
            width: 1024,
            height: 768,
            webPreferences: {
                offscreen: true,
                partition: partition,
                sandbox: true,
                contextIsolation: true,
                webSecurity: false
            }
        });

        // 监听 signal，关闭窗口
        if (signal) {
            signal.addEventListener('abort', () => {
                if (!win.isDestroyed()) win.destroy();
            });
        }

        try {
            const iyfSession = session.fromPartition(partition);
            iyfSession.webRequest.onBeforeSendHeaders((details, callback) => {
                details.requestHeaders['User-Agent'] = IYF_USER_AGENT;
                if (details.url.includes('iyf')) {
                    details.requestHeaders['Referer'] = IYF_REFERER;
                }
                callback({ cancel: false, requestHeaders: details.requestHeaders });
            });

            await win.loadURL(videoUrl);

            const script = `
                new Promise((resolve, reject) => {
                    let attempts = 0;
                    const interval = setInterval(() => {
                        attempts++;
                        if (window.player_aaaa) {
                            clearInterval(interval);
                            const title = document.title || document.querySelector('meta[property="og:title"]')?.content || 'Unknown';
                            const cover = document.querySelector('meta[property="og:image"]')?.content;
                            const episode = window.vod_part || '';
                            resolve({
                                title: title,
                                coverUrl: cover,
                                playerConfig: window.player_aaaa,
                                episode: episode
                            });
                        }
                        if (attempts > 150) { 
                            clearInterval(interval);
                            reject('Timeout waiting for player_aaaa');
                        }
                    }, 200);
                });
            `;

            const result = await win.webContents.executeJavaScript(script);
            const cookies = await iyfSession.cookies.get({ url: videoUrl });
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            const playerBlock = result.playerConfig;
            let m3u8Url = playerBlock.url;
            const encryptType = playerBlock.encrypt || 0;

            if (m3u8Url) {
                if (encryptType === 1) m3u8Url = unescape(m3u8Url);
                else if (encryptType === 2) {
                    try {
                        const decodedBase64 = Buffer.from(m3u8Url, 'base64').toString('binary');
                        m3u8Url = unescape(decodedBase64);
                    } catch (e) {}
                }
                m3u8Url = m3u8Url.replace(/\\\//g, '/');
            }

            let coverUrl = result.coverUrl;
            if (coverUrl && coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;

            let title = result.title.replace(/- 爱壹帆.*/, '').trim();
            if (result.episode) title = `${title} - ${result.episode}`;

            return { title, coverUrl, m3u8Url, cookieString };

        } catch (error) {
            // 如果是被 signal 销毁导致的错误
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            console.error('[Iyf Provider] BrowserWindow 解析失败:', error);
            throw new Error('页面加载超时，请检查网络连接');
        } finally {
            if (win && !win.isDestroyed()) win.destroy();
        }
    }

    async _parseM3u8Recursive(url, headers, signal) {
        const response = await axios.get(url, {
            headers: headers,
            ...this._getAxiosConfig(),
            signal: signal // 传递 signal
        });

        const parser = new m3u8Parser.Parser();
        parser.push(response.data);
        parser.end();
        const manifest = parser.manifest;

        if (manifest.playlists && manifest.playlists.length > 0) {
            const bestPlaylist = manifest.playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0))[0];
            const nextUrl = new URL(bestPlaylist.uri, url).toString();
            return this._parseM3u8Recursive(nextUrl, headers, signal);
        }

        if (manifest.segments && manifest.segments.length > 0) {
            const segments = manifest.segments.map(seg => ({
                uri: new URL(seg.uri, url).toString(),
                key: seg.key
            }));
            return { segments: segments, keyInfo: segments[0].key };
        }
        throw new Error('无法解析 M3U8 内容：格式不正确');
    }

    async _downloadKey(keyUri, m3u8Url, headers, signal) {
        try {
            const absoluteKeyUrl = new URL(keyUri, m3u8Url).toString();
            const response = await axios.get(absoluteKeyUrl, {
                responseType: 'arraybuffer',
                headers: headers,
                ...this._getAxiosConfig(),
                signal: signal
            });
            return Buffer.from(response.data);
        } catch (e) {
            if (signal && signal.aborted) throw e;
            console.error('[Iyf Provider] 获取解密 Key 失败:', e.message);
            throw new Error('无法下载解密密钥');
        }
    }

    async _downloadSegmentsParallel(segments, tempDir, refererUrl, globalKey, globalIv, headers, signal) {
        const limit = pLimit(CONCURRENT_LIMIT);
        const total = segments.length;
        let completed = 0;

        const tasks = segments.map((seg, index) => {
            return limit(async () => {
                this._checkCancelled(signal); // 每个任务开始前检查
                const filename = `${String(index).padStart(5, '0')}.ts`;
                const filePath = path.join(tempDir, filename);

                const key = (seg.key && seg.key.method === 'AES-128') ?
                    (seg.key.uri ? await this._downloadKey(seg.key.uri, refererUrl, headers, signal) : globalKey)
                    : globalKey;

                let iv = globalIv;
                if (seg.key && seg.key.iv) {
                    iv = Buffer.from(seg.key.iv.buffer);
                } else if (key && !iv) {
                    const ivBuffer = Buffer.alloc(16);
                    ivBuffer.writeUInt32BE(index, 12);
                    iv = ivBuffer;
                }

                await this._downloadAndDecryptSegment(seg.uri, filePath, refererUrl, key, iv, headers, signal);

                completed++;
                if (completed % 10 === 0 || completed === total) {
                    this.sendMessage('download-status', {
                        message: `下载中: ${((completed / total) * 100).toFixed(1)}% (${completed}/${total})`,
                        progress: completed / total,
                        type: 'progress'
                    });
                }
                return filename;
            });
        });

        return await Promise.all(tasks);
    }

    async _downloadAndDecryptSegment(url, destPath, referer, key, iv, headers, signal) {
        for (let i = 0; i < 3; i++) {
            if (signal && signal.aborted) throw new Error('Download aborted by user');
            try {
                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'arraybuffer',
                    headers: { ...headers, 'Referer': referer },
                    timeout: 20000,
                    ...this._getAxiosConfig(),
                    signal: signal
                });

                let data = Buffer.from(response.data);

                if (key && iv) {
                    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                    decipher.setAutoPadding(true);
                    data = Buffer.concat([decipher.update(data), decipher.final()]);
                }

                fs.writeFileSync(destPath, data);
                if (data.length === 0) throw new Error('分片数据为空');
                return;
            } catch (error) {
                if (signal && signal.aborted) throw error;
                if (i === 2) throw error;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }

    _getAxiosConfig() {
        return {
            httpsAgent: insecureAgent,
            proxy: undefined
        };
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
        const args = ['-y', '-fflags', '+genpts', '-i', inputTs, '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', outputMp4];
        return new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, args);
            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg 封装失败，退出码: ${code}`));
            });
            proc.on('error', (err) => reject(err));
        });
    }
}