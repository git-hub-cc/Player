// src/backend/providers/bilibili.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { exec } from 'child_process';
import { BaseProvider } from './base-provider.js';
import { downloadFile } from '../services/download-service.js';

/**
 * @class BilibiliProvider
 * @description Bilibili 视频下载服务提供者。
 * @extends BaseProvider
 */
export class BilibiliProvider extends BaseProvider {
    /**
     * 判断此 Provider 是否能处理给定的 URL。
     * @param {string} url - 用户输入的 URL。
     * @returns {boolean} - 如果是 Bilibili 视频链接则返回 true。
     */
    isApplicable(url) {
        return url.includes('bilibili.com/video/');
    }

    /**
     * 执行 Bilibili 视频的下载和处理流程。
     * @param {string} videoUrl - Bilibili 视频链接。
     * @returns {Promise<void>}
     */
    async execute(videoUrl) {
        // 1. 前置检查：确保必需的 FFmpeg 工具存在
        if (!this._checkTools(['ffmpeg'])) {
            return; // _checkTools 方法内部已发送错误消息
        }

        try {
            this.sendMessage('download-status', { message: '开始解析B站链接...', type: 'default' });

            // 2. 从 URL 中提取 BV 号
            const bvidMatch = videoUrl.match(/(BV[a-zA-Z0-9]+)/);
            if (!bvidMatch) {
                throw new Error('无法从URL中提取有效的BV号。');
            }
            const bvid = bvidMatch[0];

            // 3. 获取视频详细信息 (标题, UP主, 封面等)
            const viewResponse = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const viewData = viewResponse.data?.data;
            if (!viewData || !viewData.cid) {
                throw new Error('无法获取视频信息，请检查链接是否有效或视频是否存在。');
            }
            const { cid, title, owner, pic: coverUrl } = viewData;
            const author = owner?.name || '未知UP主';
            const safeFilename = this._sanitizeFilename(`${author} - ${title}`);

            // 4. 获取音视频流的 DASH 地址
            const playResponse = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048`, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': videoUrl }
            });
            const dashData = playResponse.data.data?.dash;
            if (!dashData?.video?.[0] || !dashData?.audio?.[0]) {
                throw new Error('无法获取DASH格式的音视频流。');
            }

            this.sendMessage('download-status', { message: '正在下载视频和音频文件...', type: 'default' });

            // 5. 定义临时文件和最终文件的路径
            const videoTempPath = path.join(this.config.MEDIA_ROOT, `${safeFilename}_video_temp.m4s`);
            const audioTempPath = path.join(this.config.MEDIA_ROOT, `${safeFilename}_audio_temp.m4s`);
            const coverPath = path.join(this.config.ALBUMART_DIR, `${safeFilename}.jpg`);
            const finalPath = path.join(this.config.VIDEOS_DIR, `${safeFilename}.mp4`);

            // 6. 并行下载视频、音频和封面文件
            await Promise.all([
                downloadFile(dashData.video[0].baseUrl, path.dirname(videoTempPath), path.basename(videoTempPath), { 'Referer': videoUrl }),
                downloadFile(dashData.audio[0].baseUrl, path.dirname(audioTempPath), path.basename(audioTempPath), { 'Referer': videoUrl }),
                downloadFile(coverUrl, this.config.ALBUMART_DIR, path.basename(coverPath), { 'Referer': videoUrl }),
            ]);

            this.sendMessage('download-status', { message: '下载完成，开始使用FFmpeg合并...', type: 'default' });

            // 7. 使用 FFmpeg 合并音视频文件
            const ffmpegCommand = `"${this.ffmpegPath}" -y -i "${videoTempPath}" -i "${audioTempPath}" -c copy "${finalPath}"`;
            await new Promise((resolve, reject) => {
                exec(ffmpegCommand, (error, stdout, stderr) => {
                    // 清理临时文件
                    fs.unlink(videoTempPath, () => {});
                    fs.unlink(audioTempPath, () => {});
                    if (error) {
                        return reject(new Error('FFmpeg合并失败: ' + stderr));
                    }
                    resolve(stdout);
                });
            });

            // 8. 将新下载的视频添加到媒体库
            await this._addTrackToPlaylist({
                title,
                artist: author,
                src: `videos/${path.basename(finalPath)}`,
                albumArt: `albumArt/${path.basename(coverPath)}`,
                type: "video"
            });

            this.sendMessage('download-status', { message: `"${title}" 下载完成！`, type: 'success' });

        } catch (error) {
            console.error('[Bilibili Provider] 错误:', error);
            // 抛出错误，由 download-service 的统一 catch 块处理
            throw new Error(`B站下载失败: ${error.message}`);
        }
    }
}