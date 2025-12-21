// src/backend/providers/iyf.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { spawn } from 'child_process';
import pLimit from 'p-limit';
import crypto from 'crypto';
import * as m3u8Parser from 'm3u8-parser'; // 需要引入 m3u8-parser
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

// --- 常量配置 ---
const IYF_REFERER = 'https://www.iyf.lv/';
const IYF_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CONCURRENT_LIMIT = 16; // 稍微降低并发数以保证稳定性

/**
 * @class IyfProvider
 * @description 爱壹帆 (iyf.lv / iyf.tv) 视频下载服务提供者。
 *              v2.2: 修复合并后时长不足问题。
 *              1. 递归解析 M3U8，支持 Master/Media 多级列表。
 *              2. 支持 AES-128 分片解密。
 *              3. 使用 FFmpeg concat demuxer 替代二进制拼接，修复时间戳问题。
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
            this.sendMessage('download-status', { message: '正在解析 IYF 页面信息...', type: 'default' });

            // 2. 获取视频元信息
            const info = await this._getVideoInfo(videoUrl);
            const safeFilename = this._sanitizeFilename(info.title);

            this.sendMessage('download-status', { message: `解析成功: ${info.title}`, type: 'default' });

            // 3. 下载封面 (非阻塞)
            if (info.coverUrl) {
                downloadFile(info.coverUrl, this.config.ALBUMART_DIR, `${safeFilename}.jpg`, {
                    'Referer': IYF_REFERER,
                    'User-Agent': IYF_USER_AGENT
                }).catch(e => console.warn('[Iyf Provider] 封面下载失败，跳过:', e.message));
            }

            // 4. 深度解析 M3U8，处理多级列表，获取分片和解密信息
            this.sendMessage('download-status', { message: '分析播放列表结构...', type: 'default' });
            const { segments, keyInfo } = await this._parseM3u8Recursive(info.m3u8Url);

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
                decryptionKey = await this._downloadKey(keyInfo.uri, info.m3u8Url);
            }

            this.sendMessage('download-status', { message: `开始多线程下载 (${CONCURRENT_LIMIT}线程)...`, type: 'default' });

            // 7. 多线程并发下载 (并解密) TS 分片
            const downloadedFiles = await this._downloadSegmentsParallel(segments, tempDir, info.m3u8Url, decryptionKey, keyInfo?.iv);

            this.sendMessage('download-status', { message: '分片下载完成，正在合并...', type: 'default' });

            // 8. 生成 FFmpeg Concat 列表文件
            const fileListPath = path.join(tempDir, 'files.txt');
            const fileListContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
            fs.writeFileSync(fileListPath, fileListContent);

            // 9. 使用 FFmpeg Concat 模式合并
            const finalPath = path.join(this.config.VIDEOS_DIR, `${safeFilename}.mp4`);
            await this._concatAndRemux(fileListPath, finalPath);

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
                setTimeout(() => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (e) {
                        console.warn('[Iyf Provider] 清理临时文件失败 (非致命):', e.message);
                    }
                }, 1000);
            }
        }
    }

    /**
     * @private
     * 递归解析 M3U8，处理 Master Playlist -> Media Playlist 的跳转。
     */
    async _parseM3u8Recursive(url) {
        const response = await axios.get(url, {
            headers: { 'User-Agent': IYF_USER_AGENT, 'Referer': IYF_REFERER }
        });
        const parser = new m3u8Parser.Parser();
        parser.push(response.data);
        parser.end();

        const manifest = parser.manifest;

        // 情况1: Master Playlist (包含子流)
        if (manifest.playlists && manifest.playlists.length > 0) {
            console.log('[Iyf Provider] 检测到多级列表，选择最佳画质...');
            // 简单策略：选择带宽最大的流，或者第一个
            const bestPlaylist = manifest.playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0))[0];
            const nextUrl = new URL(bestPlaylist.uri, url).toString();
            return this._parseM3u8Recursive(nextUrl);
        }

        // 情况2: Media Playlist (包含实际分片)
        if (manifest.segments && manifest.segments.length > 0) {
            const segments = manifest.segments.map(seg => {
                return {
                    uri: new URL(seg.uri, url).toString(),
                    key: seg.key // 每个分片可能有独立的 Key 定义，或者继承全局
                };
            });

            // 提取全局 Key 信息 (通常在第一个分片或头部定义)
            // m3u8-parser 会将 key 信息附加在 segment 对象上
            // 我们假设整个列表使用同一个 Key，或者取第一个分片的 Key 作为参考
            const firstKey = segments[0].key;

            return {
                segments: segments,
                keyInfo: firstKey
            };
        }

        throw new Error('无法解析 M3U8 内容：既不是 Master 也不是 Media 列表');
    }

    /**
     * @private
     * 下载 AES-128 解密密钥。
     */
    async _downloadKey(keyUri, m3u8Url) {
        try {
            const absoluteKeyUrl = new URL(keyUri, m3u8Url).toString();
            const response = await axios.get(absoluteKeyUrl, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': IYF_USER_AGENT, 'Referer': IYF_REFERER }
            });
            return Buffer.from(response.data);
        } catch (e) {
            console.error('[Iyf Provider] 获取解密 Key 失败:', e);
            throw new Error('无法下载解密密钥');
        }
    }

    /**
     * @private
     * 并发下载并解密分片。
     */
    async _downloadSegmentsParallel(segments, tempDir, refererUrl, globalKey, globalIv) {
        const limit = pLimit(CONCURRENT_LIMIT);
        const total = segments.length;
        let completed = 0;

        const tasks = segments.map((seg, index) => {
            return limit(async () => {
                const filename = `${String(index).padStart(5, '0')}.ts`;
                const filePath = path.join(tempDir, filename);

                // 优先使用分片自带的 Key，否则使用全局 Key
                const key = (seg.key && seg.key.method === 'AES-128') ?
                    (seg.key.uri ? await this._downloadKey(seg.key.uri, refererUrl) : globalKey)
                    : globalKey;

                // IV 处理：如果有显示 IV 则使用，否则使用序列号
                let iv = globalIv;
                if (seg.key && seg.key.iv) {
                    iv = Buffer.from(seg.key.iv.buffer);
                } else if (key && !iv) {
                    // 默认 IV 为序列号 (Sequence Number)，填充至 16 字节
                    const ivBuffer = Buffer.alloc(16);
                    ivBuffer.writeUInt32BE(index, 12); // 假设 index 就是 sequence number
                    iv = ivBuffer;
                }

                await this._downloadAndDecryptSegment(seg.uri, filePath, refererUrl, key, iv);

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

    /**
     * @private
     * 下载单个分片，如果提供了 Key 则进行解密。
     */
    async _downloadAndDecryptSegment(url, destPath, referer, key, iv) {
        for (let i = 0; i < 3; i++) {
            try {
                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'arraybuffer', // 获取原始二进制数据
                    headers: { 'User-Agent': IYF_USER_AGENT, 'Referer': referer },
                    timeout: 20000
                });

                let data = Buffer.from(response.data);

                // 解密逻辑
                if (key && iv) {
                    try {
                        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
                        decipher.setAutoPadding(true); // PKCS7 padding
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
     * 使用 FFmpeg Concat Demuxer 合并文件。
     * 这种方式对时间戳的处理比二进制拼接更安全。
     */
    async _concatAndRemux(fileListPath, outputMp4) {
        const args = [
            '-y',
            '-f', 'concat',
            '-safe', '0', // 允许读取任意路径的文件
            '-i', fileListPath,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc', // 修复 AAC 音频流
            '-movflags', '+faststart',
            outputMp4
        ];

        return new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, args);

            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg 合并失败，退出码: ${code}`));
            });

            proc.on('error', (err) => reject(err));
        });
    }

    // --- 复用之前的辅助方法 ---
    async _getVideoInfo(pageUrl) {
        try {
            const response = await axios.get(pageUrl, {
                headers: { 'User-Agent': IYF_USER_AGENT, 'Referer': IYF_REFERER },
                timeout: 15000
            });
            const html = response.data;

            let title = '未知视频';
            const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
            const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (ogTitleMatch && ogTitleMatch[1]) title = ogTitleMatch[1];
            else if (titleTagMatch && titleTagMatch[1]) title = titleTagMatch[1].split('-')[0].trim();

            let coverUrl = null;
            const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
            if (ogImageMatch && ogImageMatch[1]) {
                coverUrl = ogImageMatch[1];
                if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;
            }

            const playerBlockMatch = html.match(/var\s+player_aaaa\s*=\s*({[\s\S]*?});/);
            if (!playerBlockMatch || !playerBlockMatch[1]) throw new Error('无法找到视频配置');
            const playerBlock = playerBlockMatch[1];

            const urlMatch = playerBlock.match(/['"]url['"]\s*:\s*['"]([^'"]+)['"]/);
            if (!urlMatch || !urlMatch[1]) throw new Error('无法提取视频 URL');
            let m3u8Url = urlMatch[1];

            const encryptMatch = playerBlock.match(/['"]encrypt['"]\s*:\s*(\d+)/);
            const encryptType = encryptMatch ? parseInt(encryptMatch[1], 10) : 0;

            if (encryptType === 1) m3u8Url = unescape(m3u8Url);
            else if (encryptType === 2) {
                try {
                    const decodedBase64 = Buffer.from(m3u8Url, 'base64').toString('binary');
                    m3u8Url = unescape(decodedBase64);
                } catch (e) {}
            }

            m3u8Url = m3u8Url.replace(/\\\//g, '/');

            return { title: title.trim(), coverUrl, m3u8Url };
        } catch (error) {
            if (error.response) throw new Error(`页面请求失败: ${error.response.status}`);
            throw error;
        }
    }
}