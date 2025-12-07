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
            // 初始化包装器实例
            // 注意：yt-dlp-wrap-plus 需要 default 导出，视具体打包情况而定，这里假设直接引入类
            const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
            const ytDlpWrap = new YTDlpClass(ytDlpPath);

            // 构建参数数组
            // 我们手动构建参数以获取元数据，这样可以确保代理设置生效
            const args = [
                '--dump-json',
                '--force-ipv4',
                '--socket-timeout', '60',
            ];

            if (proxy) {
                args.push('--proxy', proxy);
            }

            args.push(videoUrl);

            console.log(`[yt-dlp-wrap GetInfo] Executing with args:`, args);

            // 使用 execPromise 获取标准输出
            const stdout = await ytDlpWrap.execPromise(args);

            try {
                const info = JSON.parse(stdout);
                resolve({
                    title: info.title,
                    uploader: info.uploader,
                    thumbnail: info.thumbnail,
                    duration: info.duration,
                    // 可以根据需要提取更多字段
                });
            } catch (parseError) {
                reject(new Error(`解析视频信息JSON失败: ${parseError.message}`));
            }

        } catch (error) {
            console.error('[yt-dlp-wrap GetInfo Error]:', error);
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

        // 初始化包装器
        const YTDlpClass = YTDlpWrap.default || YTDlpWrap;
        const ytDlpWrap = new YTDlpClass(ytDlpPath);

        // 构建下载参数
        const args = [
            '--force-ipv4',
            '--socket-timeout', '60',
            // 优先下载最佳 mp4 视频 + 最佳 m4a 音频，或者最佳 mp4，或者兜底最佳
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--ffmpeg-location', ffmpegDir,
            '--output', outputPath,
            '--no-playlist',
            // 注意：yt-dlp-wrap 会自动解析进度，但我们需要确保输出格式标准
        ];

        if (proxy) {
            args.push('--proxy', proxy);
        }

        args.push(videoUrl);

        console.log(`[yt-dlp-wrap Download] Starting: ${videoUrl}`);

        // 执行命令并获取 EventEmitter
        const ytDlpEventEmitter = ytDlpWrap.exec(args);

        // 监听进度事件
        ytDlpEventEmitter.on('progress', (progress) => {
            // progress 对象包含 percent, totalSize, currentSpeed, eta 等
            // percent 是 0 到 100 之间的数字
            if (onProgress && progress.percent) {
                onProgress(progress.percent / 100);
            }
        });

        // 监听 yt-dlp 的原始事件（可选，用于调试）
        // ytDlpEventEmitter.on('ytDlpEvent', (eventType, eventData) => {
        //     console.log(eventType, eventData);
        // });

        // 监听错误
        ytDlpEventEmitter.on('error', (error) => {
            console.error('[yt-dlp-wrap Error]:', error);
            reject(error);
        });

        // 监听完成
        ytDlpEventEmitter.on('close', () => {
            console.log('[yt-dlp-wrap] Process closed successfully.');

            // 预测最终文件路径 (通常是 mp4)
            const finalFilePath = path.join(outputDir, `${filename}.mp4`);

            // 简单检查文件是否存在
            // 注意：如果 yt-dlp 下载了 webm 等其他格式，这里可能需要更复杂的查找逻辑
            // 但由于我们在 args 中指定了 ext=mp4 偏好，通常会得到 mp4
            if (fs.existsSync(finalFilePath)) {
                resolve(finalFilePath);
            } else {
                // 尝试查找目录下同名的其他扩展名文件
                const files = fs.readdirSync(outputDir);
                const match = files.find(f => f.startsWith(filename) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')));
                if (match) {
                    resolve(path.join(outputDir, match));
                } else {
                    console.warn(`[yt-dlp-wrap Warning]: 下载似乎成功但未找到预期的 MP4 文件: ${finalFilePath}`);
                    // 即使没找到文件，只要进程没报错，暂时 resolve，让上层处理
                    resolve(finalFilePath);
                }
            }
        });
    });
}