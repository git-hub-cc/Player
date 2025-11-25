// src/backend/providers/youtube.js

import path from 'path';
import fs from 'fs';
import { exec, spawn } from 'child_process';

/**
 * 获取 YouTube 视频信息 (标题, 封面等)
 * @param {string} videoUrl
 * @param {string} ytDlpPath
 * @param {string|null} proxy - 代理服务器地址, e.g., 'http://127.0.0.1:7890'
 */
export async function getVideoInfo(videoUrl, ytDlpPath, proxy) {
    return new Promise((resolve, reject) => {
        const args = [];

        // 【修改】如果传入了代理，则添加到参数列表
        if (proxy) {
            args.push('--proxy', proxy);
        }

        args.push(
            '--force-ipv4',
            '--socket-timeout', '60',
            '--dump-json',
            videoUrl
        );

        console.log(`[yt-dlp Spawning GetInfo]:\n  Command: ${ytDlpPath}\n  Args: ${args.join(' ')}`);

        const child = spawn(ytDlpPath, args);

        let jsonData = '';
        let errorData = '';

        child.stdout.on('data', (data) => {
            jsonData += data.toString();
        });

        child.stderr.on('data', (data) => {
            errorData += data.toString();
        });

        child.on('error', (err) => {
            console.error('[yt-dlp Process Error]:', err);
            reject(new Error(`启动 yt-dlp 进程失败: ${err.message}`));
        });

        child.on('close', (code) => {
            // 在退出时打印完整的日志，便于调试
            console.log(`[yt-dlp stdout on close]:\n${jsonData}`);
            console.error(`[yt-dlp stderr on close]:\n${errorData}`);
            console.log(`[yt-dlp Exited]: GetInfo process finished with code: ${code}`);

            if (code === 0) {
                try {
                    const info = JSON.parse(jsonData);
                    resolve({
                        title: info.title,
                        uploader: info.uploader,
                        thumbnail: info.thumbnail,
                        duration: info.duration
                    });
                } catch (e) {
                    reject(new Error(`解析视频信息JSON失败: ${e.message}`));
                }
            } else {
                reject(new Error(`获取信息失败 (yt-dlp 退出码 ${code}): ${errorData || '未知错误'}`));
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
 * @param {string|null} proxy - 代理服务器地址
 */
export function downloadVideo(videoUrl, outputDir, filename, ytDlpPath, ffmpegPath, onProgress, proxy) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
        const ffmpegDir = path.dirname(ffmpegPath);

        const args = [];

        // 【修改】如果传入了代理，则添加到参数列表
        if (proxy) {
            args.push('--proxy', proxy);
        }

        args.push(
            '--force-ipv4',
            '--socket-timeout', '60',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--ffmpeg-location', ffmpegDir,
            '--output', outputPath,
            '--no-playlist',
            '--progress',
            '--newline',
            videoUrl
        );

        console.log(`[yt-dlp Spawning Download]:\n  Command: ${ytDlpPath}\n  Args: ${args.join(' ')}`);

        const child = spawn(ytDlpPath, args);

        let finalFilePath = '';
        let errorData = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            console.log('[yt-dlp stdout]:', text.trim());

            const match = text.match(/\[download\]\s+(\d+\.\d+)%/);
            if (match && onProgress) {
                const percent = parseFloat(match[1]);
                onProgress(percent / 100);
            }

            const mergeMatch = text.match(/Merging formats into "(.+?)"/);
            if (mergeMatch) {
                finalFilePath = mergeMatch[1];
            } else if (!finalFilePath) {
                const destMatch = text.match(/Destination: (.+?\.mp4)/);
                if (destMatch) finalFilePath = destMatch[1];
            }
        });

        child.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            console.error('[yt-dlp stderr]:', errorOutput);
            errorData += errorOutput;
        });

        child.on('error', (err) => {
            console.error('[yt-dlp Process Error]:', err);
            reject(err);
        });

        child.on('close', (code) => {
            console.log(`[yt-dlp Exited]: Download process finished with code: ${code}`);

            if (code === 0) {
                if (!finalFilePath) {
                    finalFilePath = path.join(outputDir, `${filename}.mp4`);
                }
                if (!fs.existsSync(finalFilePath)) {
                    console.warn(`[yt-dlp Warning]: 进程成功退出，但未找到预期的输出文件: ${finalFilePath}。请检查 stderr 日志。`);
                }
                resolve(finalFilePath);
            } else {
                reject(new Error(`yt-dlp 退出，代码: ${code}. 错误: ${errorData || '未知错误'}`));
            }
        });
    });
}