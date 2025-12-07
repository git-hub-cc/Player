// src/backend/providers/youtube.js

import path from 'path';
import fs from 'fs';
import YTDlpWrap from 'yt-dlp-wrap-plus';

/**
 * 获取 YouTube 视频信息 (标题, 封面等)
 * 使用 yt-dlp-wrap-plus 替代原生的 child_process 调用，提高稳定性和解析能力。
 *
 * @param {string} videoUrl - 视频链接
 * @param {string} ytDlpPath - yt-dlp 可执行文件路径
 * @param {string|null} proxy - 代理服务器地址, e.g., 'http://127.0.0.1:7890'
 * @returns {Promise<object>} - 返回包含标题、上传者、缩略图等信息的对象
 */
export async function getVideoInfo(videoUrl, ytDlpPath, proxy) {
    return new Promise(async (resolve, reject) => {
        try {
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(ytDlpPath);

            const args = [
                '--dump-json',
                '--force-ipv4',
                '--socket-timeout', '60',
            ];

            if (proxy) {
                args.push('--proxy', proxy);
            }

            args.push(videoUrl);

            // 【日志】记录执行 yt-dlp 获取信息的完整参数
            console.log(`[YouTube Provider] 准备执行 yt-dlp (获取信息)，参数:`, args);

            const stdout = await ytDlpWrap.execPromise(args);

            try {
                const info = JSON.parse(stdout);
                // 【日志】记录成功解析到的视频信息
                console.log(`[YouTube Provider] 成功解析视频信息:`, { title: info.title, uploader: info.uploader });
                resolve({
                    title: info.title,
                    uploader: info.uploader,
                    thumbnail: info.thumbnail,
                    duration: info.duration,
                });
            } catch (parseError) {
                // 【日志】记录 JSON 解析失败
                console.error('[YouTube Provider] 解析视频信息 JSON 失败:', parseError);
                reject(new Error(`解析视频信息JSON失败: ${parseError.message}`));
            }

        } catch (error) {
            // 【日志】记录执行过程中的错误
            console.error('[YouTube Provider] 执行 yt-dlp (获取信息) 失败:', error);
            reject(new Error(`获取信息失败: ${error.message}`));
        }
    });
}

/**
 * 下载 YouTube 视频
 * 使用 yt-dlp-wrap-plus 的事件发射器来精确控制进度和状态。
 *
 * @param {string} videoUrl - 视频链接
 * @param {string} outputDir - 输出目录
 * @param {string} filename - 文件名 (不含扩展名)
 * @param {string} ytDlpPath - yt-dlp 可执行文件路径
 * @param {string} ffmpegPath - ffmpeg 可执行文件路径 (用于合并音视频)
 * @param {function} onProgress - 进度回调函数 (0.0 - 1.0)
 * @param {string|null} proxy - 代理服务器地址
 * @returns {Promise<string>} - 返回最终生成的文件路径
 */
export function downloadVideo(videoUrl, outputDir, filename, ytDlpPath, ffmpegPath, onProgress, proxy) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(outputDir, `${filename}.%(ext)s`);
        const ffmpegDir = path.dirname(ffmpegPath);

        const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
        const ytDlpWrap = new YTDlpClass(ytDlpPath);

        const args = [
            '--force-ipv4',
            '--socket-timeout', '60',
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--ffmpeg-location', ffmpegDir,
            '--output', outputPath,
            '--no-playlist',
        ];

        if (proxy) {
            args.push('--proxy', proxy);
        }

        args.push(videoUrl);

        // 【日志】记录执行 yt-dlp 下载的完整参数
        console.log(`[YouTube Provider] 准备执行 yt-dlp (下载)，参数:`, args);

        const ytDlpEventEmitter = ytDlpWrap.exec(args);

        ytDlpEventEmitter.on('progress', (progress) => {
            if (onProgress && progress.percent) {
                onProgress(progress.percent / 100);
            }
        });

        ytDlpEventEmitter.on('error', (error) => {
            // 【日志】记录下载过程中的错误
            console.error('[YouTube Provider] 执行 yt-dlp (下载) 失败:', error);
            reject(error);
        });

        ytDlpEventEmitter.on('close', () => {
            // 【日志】记录进程成功关闭
            console.log('[YouTube Provider] yt-dlp 进程成功关闭。');

            const finalFilePath = path.join(outputDir, `${filename}.mp4`);

            if (fs.existsSync(finalFilePath)) {
                // 【日志】确认最终文件存在
                console.log(`[YouTube Provider] 下载完成，最终文件路径: ${finalFilePath}`);
                resolve(finalFilePath);
            } else {
                const files = fs.readdirSync(outputDir);
                const match = files.find(f => f.startsWith(filename) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')));
                if (match) {
                    const foundPath = path.join(outputDir, match);
                    // 【日志】找到其他格式的文件
                    console.log(`[YouTube Provider] 未找到 MP4，但找到匹配文件: ${foundPath}`);
                    resolve(foundPath);
                } else {
                    // 【日志】下载完成但找不到文件
                    console.warn(`[YouTube Provider] 警告: 下载似乎成功但未找到预期的输出文件: ${finalFilePath}`);
                    resolve(finalFilePath);
                }
            }
        });
    });
}