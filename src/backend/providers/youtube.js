// src/backend/providers/youtube.js

import path from 'path';
import fs from 'fs';
import { exec, spawn } from 'child_process';

/**
 * 获取 YouTube 视频信息 (标题, 封面等)
 * @param {string} videoUrl
 * @param {string} ytDlpPath
 */
export async function getVideoInfo(videoUrl, ytDlpPath) {
    return new Promise((resolve, reject) => {
        // 使用 --dump-json 获取元数据，不下载
        const command = `"${ytDlpPath}" --dump-json "${videoUrl}"`;

        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(`获取信息失败: ${stderr || error.message}`));
            }
            try {
                const info = JSON.parse(stdout);
                resolve({
                    title: info.title,
                    uploader: info.uploader,
                    thumbnail: info.thumbnail,
                    duration: info.duration
                });
            } catch (e) {
                reject(new Error('解析视频信息失败'));
            }
        });
    });
}

/**
 * 下载 YouTube 视频
 * @param {string} videoUrl
 * @param {string} outputDir
 * @param {string} filename (不含扩展名)
 * @param {string} ytDlpPath
 * @param {string} ffmpegPath (yt-dlp 需要 ffmpeg 来合并音视频流)
 * @param {function} onProgress
 */
export function downloadVideo(videoUrl, outputDir, filename, ytDlpPath, ffmpegPath, onProgress) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(outputDir, `${filename}.%(ext)s`);

        // 构造参数
        // -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" 优先下载 mp4 格式的最佳画质+最佳音质
        // --ffmpeg-location 指定 ffmpeg 路径
        // --no-playlist 防止下载整个列表
        const args = [
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--ffmpeg-location', path.dirname(ffmpegPath), // yt-dlp 需要的是目录
            '--output', outputPath,
            '--no-playlist',
            '--progress', // 启用进度输出
            '--newline',  // 进度输出换行，方便解析
            videoUrl
        ];

        const child = spawn(ytDlpPath, args);

        let finalFilePath = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();

            // 解析进度 [download]  45.0% of 10.00MiB at 2.00MiB/s ETA 00:05
            const match = text.match(/\[download\]\s+(\d+\.\d+)%/);
            if (match && onProgress) {
                const percent = parseFloat(match[1]);
                onProgress(percent / 100);
            }

            // 尝试捕获最终文件名
            // [Merger] Merging formats into "..."
            // 或者 [download] Destination: ...
            const mergeMatch = text.match(/Merging formats into "(.+?)"/);
            if (mergeMatch) {
                finalFilePath = mergeMatch[1];
            } else if (!finalFilePath) {
                const destMatch = text.match(/Destination: (.+?\.mp4)/);
                if (destMatch) finalFilePath = destMatch[1];
            }
        });

        child.stderr.on('data', (data) => {
            // yt-dlp 的警告有时也会输出到 stderr，不一定是错误
            console.warn(`[yt-dlp stderr]: ${data}`);
        });

        child.on('close', (code) => {
            if (code === 0) {
                // 如果没捕获到文件名，尝试构建默认文件名
                if (!finalFilePath) {
                    finalFilePath = path.join(outputDir, `${filename}.mp4`);
                }
                resolve(finalFilePath);
            } else {
                reject(new Error(`yt-dlp 退出，代码: ${code}`));
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}