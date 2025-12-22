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

// --- 常量配置 ---
const IYF_REFERER = 'https://www.iyf.lv/';
const IYF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CONCURRENT_LIMIT = 32; // 并发下载限制

// --- 网络配置修正 ---
// 创建一个宽松的 Agent，解决 SSL 握手失败和 socket hang up 问题
const insecureAgent = new https.Agent({
    rejectUnauthorized: false, // 忽略自签名或过期证书错误
    keepAlive: true,           // 保持连接
    ciphers: 'DEFAULT@SECLEVEL=0', // 允许旧版加密算法 (关键修复 SSL error code 1)
    minVersion: 'TLSv1'        // 允许旧版 TLS
});

/**
 * @class IyfProvider
 * @description 爱壹帆 (iyf.lv / iyf.tv) 视频下载服务提供者。
 *              v3.0 重构修复:
 *              针对 "画面一顿一顿" 的问题，放弃 FFmpeg concat demuxer (文本列表合并)，
 *              改用 **二进制合并 + FFmpeg Remux (genpts)** 方案。
 *              该方案能重构视频时间戳 (PTS)，彻底解决分片间隙导致的卡顿。
 * @extends BaseProvider
 */
export class IyfProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否能处理给定的 URL。
     */
    isApplicable(url) {
        return url.includes('iyf.lv') || url.includes('iyf.tv');
    }

    /**
     * 执行下载和处理流程。
     */
    async execute(videoUrl) {
        // 1. 前置检查
        if (!this._checkTools(['ffmpeg'])) {
            return;
        }

        let tempDir = null;

        try {
            this.sendMessage('download-status', { message: '正在启动隐身窗口解析 IYF 页面...', type: 'default' });

            // 2. 获取视频元信息 (使用 BrowserWindow)
            const info = await this._getVideoInfo(videoUrl);

            if (!info.m3u8Url) {
                throw new Error('未能在页面中提取到有效的 M3U8 地址');
            }

            const safeFilename = this._sanitizeFilename(info.title);
            // 构造请求头，带上 Cookie 和 Referer
            const headers = {
                'User-Agent': IYF_USER_AGENT,
                'Referer': IYF_REFERER,
                'Cookie': info.cookieString || ''
            };

            this.sendMessage('download-status', { message: `解析成功: ${info.title}`, type: 'default' });

            // 3. 下载封面
            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${safeFilename}.jpg`, headers)
                    .catch(e => console.warn('[Iyf Provider] 封面下载失败，跳过:', e.message));
            }

            // 4. 深度解析 M3U8
            this.sendMessage('download-status', { message: '分析播放列表结构...', type: 'default' });
            const { segments, keyInfo } = await this._parseM3u8Recursive(info.m3u8Url, headers);

            if (!segments || segments.length === 0) {
                throw new Error('未找到有效的视频分片');
            }

            // 5. 准备临时目录
            tempDir = path.join(this.config.MEDIA_ROOT, `temp_iyf_${Date.now()}`);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            // 6. 如果有加密，获取解密 Key
            let decryptionKey = null;
            if (keyInfo && keyInfo.method === 'AES-128' && keyInfo.uri) {
                this.sendMessage('download-status', { message: '检测到加密内容，获取解密密钥...', type: 'default' });
                // 使用宽松的网络配置获取 Key
                decryptionKey = await this._downloadKey(keyInfo.uri, info.m3u8Url, headers);
            }

            this.sendMessage('download-status', { message: `开始多线程下载 (${CONCURRENT_LIMIT}线程)...`, type: 'default' });

            // 7. 多线程并发下载 (并解密) TS 分片
            // 返回按顺序排列的文件名列表
            const downloadedFiles = await this._downloadSegmentsParallel(segments, tempDir, info.m3u8Url, decryptionKey, keyInfo?.iv, headers);

            // 8. 二进制合并文件
            // 【核心修复】不再使用 ffmpeg concat 协议，而是直接将 TS 文件的二进制数据首尾相连
            // 这样可以避免 FFmpeg 在处理不规范 HLS 分片时产生的时间戳跳变（导致卡顿）
            this.sendMessage('download-status', { message: '正在进行二进制流合并...', type: 'default' });
            const combinedTsPath = path.join(tempDir, 'combined.ts');
            await this._mergeFiles(tempDir, downloadedFiles, combinedTsPath);

            // 9. 使用 FFmpeg 转封装并重建时间戳
            // 【核心修复】添加 -fflags +genpts 参数，强制 FFmpeg 重新计算 Presentation Time Stamps
            this.sendMessage('download-status', { message: '正在修复时间戳并封装为 MP4...', type: 'default' });
            const finalPath = path.join(this.config.VIDEOS_DIR, `${safeFilename}.mp4`);
            await this._remuxToMp4(combinedTsPath, finalPath);

            // 10. 添加到媒体库
            await this._addTrackToPlaylist({
                title: info.title,
                artist: 'IYF',
                src: `videos/${path.basename(finalPath)}`,
                albumArt: `albumArt/${safeFilename}.jpg`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${info.title}" 下载成功！`, type: 'success' });

        } catch (error) {
            console.error('[Iyf Provider] 错误:', error);
            throw new Error(`IYF 下载失败: ${error.message}`);
        } finally {
            // 清理临时目录
            if (tempDir && fs.existsSync(tempDir)) {
                // 稍微延迟删除，确保文件句柄已释放
                setTimeout(() => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (e) {
                        console.warn('[Iyf Provider] 清理临时文件失败 (非致命):', e.message);
                    }
                }, 2000);
            }
        }
    }

    /**
     * @private
     * 使用 BrowserWindow 获取视频信息。
     */
    async _getVideoInfo(videoUrl) {
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

        try {
            const iyfSession = session.fromPartition(partition);

            // 拦截请求头，注入 Referer
            iyfSession.webRequest.onBeforeSendHeaders((details, callback) => {
                details.requestHeaders['User-Agent'] = IYF_USER_AGENT;
                if (details.url.includes('iyf')) {
                    details.requestHeaders['Referer'] = IYF_REFERER;
                }
                callback({ cancel: false, requestHeaders: details.requestHeaders });
            });

            // 加载页面
            await win.loadURL(videoUrl);

            // 等待页面关键数据加载
            const script = `
                new Promise((resolve, reject) => {
                    let attempts = 0;
                    const interval = setInterval(() => {
                        attempts++;
                        // 检查 player_aaaa 配置是否存在，这通常意味着页面主体已加载
                        if (window.player_aaaa) {
                            clearInterval(interval);
                            const title = document.title || document.querySelector('meta[property="og:title"]')?.content || 'Unknown';
                            const cover = document.querySelector('meta[property="og:image"]')?.content;
                            // 【核心新增】获取集数信息，用于防止文件名冲突
                            const episode = window.vod_part || '';
                            
                            resolve({
                                title: title,
                                coverUrl: cover,
                                playerConfig: window.player_aaaa,
                                episode: episode
                            });
                        }
                        if (attempts > 150) { // 30s timeout
                            clearInterval(interval);
                            reject('Timeout waiting for player_aaaa');
                        }
                    }, 200);
                });
            `;

            const result = await win.webContents.executeJavaScript(script);

            // 获取 Cookie
            const cookies = await iyfSession.cookies.get({ url: videoUrl });
            const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            // 解析 M3U8
            const playerBlock = result.playerConfig;
            let m3u8Url = playerBlock.url;
            const encryptType = playerBlock.encrypt || 0;

            if (m3u8Url) {
                if (encryptType === 1) {
                    m3u8Url = unescape(m3u8Url);
                } else if (encryptType === 2) {
                    try {
                        const decodedBase64 = Buffer.from(m3u8Url, 'base64').toString('binary');
                        m3u8Url = unescape(decodedBase64);
                    } catch (e) {
                        console.warn('[Iyf Provider] Base64 解码异常:', e);
                    }
                }
                m3u8Url = m3u8Url.replace(/\\\//g, '/');
            }

            let coverUrl = result.coverUrl;
            if (coverUrl && coverUrl.startsWith('//')) {
                coverUrl = 'https:' + coverUrl;
            }

            let title = result.title;
            // 清理标题中的后缀
            title = title.replace(/- 爱壹帆.*/, '').trim();

            // 【核心新增】如果获取到了集数，将其拼接到标题中，避免多集文件名重复
            if (result.episode) {
                title = `${title} - ${result.episode}`;
            }

            console.log(`[Iyf Provider] 解析完成: ${title}`);
            return {
                title,
                coverUrl,
                m3u8Url,
                cookieString
            };

        } catch (error) {
            console.error('[Iyf Provider] BrowserWindow 解析失败:', error);
            throw new Error('页面加载超时，请检查网络连接');
        } finally {
            if (win && !win.isDestroyed()) {
                win.destroy();
            }
        }
    }

    /**
     * @private
     * 递归解析 M3U8，使用宽松的 Axios 配置。
     */
    async _parseM3u8Recursive(url, headers) {
        const response = await axios.get(url, {
            headers: headers,
            ...this._getAxiosConfig() // 使用宽松配置
        });

        const parser = new m3u8Parser.Parser();
        parser.push(response.data);
        parser.end();

        const manifest = parser.manifest;

        if (manifest.playlists && manifest.playlists.length > 0) {
            const bestPlaylist = manifest.playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0))[0];
            const nextUrl = new URL(bestPlaylist.uri, url).toString();
            return this._parseM3u8Recursive(nextUrl, headers);
        }

        if (manifest.segments && manifest.segments.length > 0) {
            const segments = manifest.segments.map(seg => {
                return {
                    uri: new URL(seg.uri, url).toString(),
                    key: seg.key
                };
            });
            const firstKey = segments[0].key;
            return { segments: segments, keyInfo: firstKey };
        }

        throw new Error('无法解析 M3U8 内容：格式不正确');
    }

    /**
     * @private
     * 下载解密密钥
     */
    async _downloadKey(keyUri, m3u8Url, headers) {
        try {
            const absoluteKeyUrl = new URL(keyUri, m3u8Url).toString();
            const response = await axios.get(absoluteKeyUrl, {
                responseType: 'arraybuffer',
                headers: headers,
                ...this._getAxiosConfig()
            });
            return Buffer.from(response.data);
        } catch (e) {
            console.error('[Iyf Provider] 获取解密 Key 失败:', e.message);
            throw new Error('无法下载解密密钥');
        }
    }

    /**
     * @private
     * 并发下载并解密分片。
     */
    async _downloadSegmentsParallel(segments, tempDir, refererUrl, globalKey, globalIv, headers) {
        const limit = pLimit(CONCURRENT_LIMIT);
        const total = segments.length;
        let completed = 0;

        const tasks = segments.map((seg, index) => {
            return limit(async () => {
                const filename = `${String(index).padStart(5, '0')}.ts`;
                const filePath = path.join(tempDir, filename);

                const key = (seg.key && seg.key.method === 'AES-128') ?
                    (seg.key.uri ? await this._downloadKey(seg.key.uri, refererUrl, headers) : globalKey)
                    : globalKey;

                let iv = globalIv;
                if (seg.key && seg.key.iv) {
                    iv = Buffer.from(seg.key.iv.buffer);
                } else if (key && !iv) {
                    const ivBuffer = Buffer.alloc(16);
                    ivBuffer.writeUInt32BE(index, 12);
                    iv = ivBuffer;
                }

                await this._downloadAndDecryptSegment(seg.uri, filePath, refererUrl, key, iv, headers);

                completed++;
                if (completed % 10 === 0 || completed === total) {
                    this.sendMessage('download-status', {
                        message: `下载中: ${((completed / total) * 100).toFixed(1)}% (${completed}/${total})`,
                        progress: completed / total,
                        type: 'progress'
                    });
                }
                return filename; // 返回文件名，用于后续按顺序合并
            });
        });

        // Promise.all 返回的数组顺序与 tasks 顺序一致，即按 segments 顺序一致
        return await Promise.all(tasks);
    }

    /**
     * @private
     * 下载单个分片
     */
    async _downloadAndDecryptSegment(url, destPath, referer, key, iv, headers) {
        for (let i = 0; i < 3; i++) {
            try {
                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'arraybuffer',
                    headers: { ...headers, 'Referer': referer },
                    timeout: 20000,
                    ...this._getAxiosConfig()
                });

                let data = Buffer.from(response.data);

                if (key && iv) {
                    try {
                        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                        decipher.setAutoPadding(true);
                        data = Buffer.concat([decipher.update(data), decipher.final()]);
                    } catch (decryptErr) {
                        console.warn(`[Iyf Provider] 解密分片失败 ${url}:`, decryptErr.message);
                        throw decryptErr;
                    }
                }

                fs.writeFileSync(destPath, data);
                if (data.length === 0) throw new Error('分片数据为空');
                return;
            } catch (error) {
                if (i === 2) throw error;
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }

    /**
     * @private
     * 获取宽松的 Axios 配置
     */
    _getAxiosConfig() {
        return {
            httpsAgent: insecureAgent,
            proxy: undefined // 允许 Axios 自动读取环境变量中的代理设置
        };
    }

    /**
     * @private
     * 【核心方法】二进制合并文件
     * 相比于 FFmpeg 的 concat demuxer，直接的二进制合并能消除分片间的 metadata 差异，
     * 为后续的 genpts 重建时间戳提供更纯净的输入流。
     */
    async _mergeFiles(tempDir, fileNames, outputPath) {
        const writeStream = fs.createWriteStream(outputPath);

        // 必须严格按顺序写入
        for (const fileName of fileNames) {
            const filePath = path.join(tempDir, fileName);
            if (!fs.existsSync(filePath)) continue;

            await new Promise((resolve, reject) => {
                const readStream = fs.createReadStream(filePath);
                readStream.pipe(writeStream, { end: false }); // 写入后不关闭写入流
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

    /**
     * @private
     * 【核心方法】使用 FFmpeg 转封装并重建时间戳
     * 1. -fflags +genpts: 强制重新生成 Presentation Timestamp，这是解决卡顿的关键。
     * 2. -c:v copy: 复制视频流，不重编码，保证速度和原画质。
     * 3. -c:a aac: 重新编码音频。IYF 的源音频流有时会有 glitch，重新编码能平滑处理，确保同步。
     */
    async _remuxToMp4(inputTs, outputMp4) {
        const args = [
            '-y',
            '-fflags', '+genpts', // 关键参数：重建时间戳
            '-i', inputTs,
            '-c:v', 'copy',       // 视频流直接复制，解决卡顿依靠 genpts
            '-c:a', 'aac',        // 音频重编码，确保音频容器完整性
            '-movflags', '+faststart',
            outputMp4
        ];

        console.log(`[Iyf Provider] 执行 FFmpeg 重建时间戳与转封装:`, args);

        return new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, args);
            let stderrData = '';

            proc.stderr.on('data', (data) => stderrData += data.toString());

            proc.on('close', (code) => {
                if (code === 0) {
                    console.log('[Iyf Provider] 封装成功。');
                    resolve();
                } else {
                    console.error('[Iyf Provider] FFmpeg 错误输出:', stderrData);
                    reject(new Error(`FFmpeg 封装失败，退出码: ${code}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }
}