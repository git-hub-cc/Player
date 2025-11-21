// src/backend/providers/jable.js

import { BrowserWindow } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https'; // 引入 https 模块用于 Agent
import { createDecipheriv } from 'crypto';
import { exec } from 'child_process';
import * as m3u8Parser from 'm3u8-parser';
import pLimit from 'p-limit'; // 引入并发控制库

// --- 配置 ---
// 高并发设置：Jable 的 TS 分片通常较小，64 并发可以跑满带宽
const CONCURRENT_LIMIT = 64;
// HTTP Agent：开启 Keep-Alive 复用 TCP 连接，显著降低小文件请求延迟
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// 基础请求头
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://jable.tv/',
    'Origin': 'https://jable.tv',
    'Connection': 'keep-alive' // 显式声明
};

/**
 * 从 Jable 视频页面获取 m3u8 URL 和元数据
 * @param {string} videoUrl - 视频页面 URL
 * @returns {Promise<object>} - { m3u8Url, title, coverUrl, cookieString }
 */
export async function getVideoInfo(videoUrl) {
    console.log(`[Jable] 正在获取视频信息: ${videoUrl}`);

    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            offscreen: true,
            sandbox: true,
            contextIsolation: true
        }
    });

    try {
        let m3u8Url = null;
        const m3u8Promise = new Promise((resolve) => {
            const filter = { urls: ['*://*/*.m3u8'] };
            win.webContents.session.webRequest.onBeforeRequest(filter, (details, callback) => {
                if (details.url.includes('.m3u8') && !details.url.includes('preview')) {
                    m3u8Url = details.url;
                    resolve(m3u8Url);
                }
                callback({ cancel: false });
            });
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('获取 m3u8 超时')), 30000)
        );

        await win.loadURL(videoUrl);

        // 等待页面完全加载
        await win.webContents.executeJavaScript('document.readyState === "complete"');

        const metaData = await win.webContents.executeJavaScript(`
            (function() {
                const title = document.querySelector('meta[property="og:title"]')?.content || document.title;
                const cover = document.querySelector('video')?.poster || document.querySelector('meta[property="og:image"]')?.content;
                return { title, cover };
            })();
        `);

        m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);

        // 获取 Cookies
        const cookies = await win.webContents.session.cookies.get({ url: videoUrl });
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        console.log(`[Jable] 获取成功: ${metaData.title}`);

        return {
            m3u8Url,
            title: metaData.title.replace(' - Jable.TV', '').trim(),
            coverUrl: metaData.cover,
            cookieString
        };

    } catch (error) {
        console.error('[Jable] 获取信息失败:', error);
        throw error;
    } finally {
        if (!win.isDestroyed()) {
            win.close();
        }
    }
}

/**
 * 下载并解密单个 TS 分片 (带重试和退避机制)
 */
async function downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt = 1) {
    // 检查文件是否已存在且不为空 (断点续传)
    if (fs.existsSync(destPath)) {
        const stat = await fs.promises.stat(destPath);
        if (stat.size > 0) return;
    }

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: headers,
            httpsAgent: httpsAgent, // 使用全局 Keep-Alive Agent
            timeout: 20000
        });

        let data = Buffer.from(response.data);

        // 内存解密
        if (key && iv) {
            const decipher = createDecipheriv('aes-128-cbc', key, iv);
            data = Buffer.concat([decipher.update(data), decipher.final()]);
        }

        await fs.promises.writeFile(destPath, data);

    } catch (error) {
        const maxRetries = 5;
        if (attempt <= maxRetries) {
            const status = error.response?.status;
            // 指数退避：428/429 等错误等待时间加倍，其他错误等待 1s
            const delay = (status === 428 || status === 429) ? 2000 * attempt : 1000;
            // console.warn(`[Jable] 片段下载重试 (${attempt}/${maxRetries}): ${path.basename(url)} - ${error.message}`);
            await new Promise(r => setTimeout(r, delay));
            return downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt + 1);
        }
        throw error; // 超过重试次数，抛出错误
    }
}

/**
 * 纯 Node.js 流式合并 (替代 FFmpeg concat)
 * 速度受限于磁盘 I/O，极快
 */
async function mergeFiles(tempDir, fileNames, outputPath) {
    const writeStream = fs.createWriteStream(outputPath);

    for (const fileName of fileNames) {
        const filePath = path.join(tempDir, fileName);
        await new Promise((resolve, reject) => {
            if (!fs.existsSync(filePath)) {
                // 容错：如果缺少某个片段，跳过并警告，防止整个合并失败
                console.warn(`[Jable] 警告：缺失片段 ${fileName}，跳过合并。`);
                resolve();
                return;
            }
            const readStream = fs.createReadStream(filePath);
            // end: false 保持写入流打开，以便写入下一个文件
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', resolve);
            readStream.on('error', (err) => {
                console.error(`[Jable] 读取片段出错 ${fileName}:`, err);
                reject(err);
            });
        });
    }

    return new Promise((resolve, reject) => {
        writeStream.end(); // 所有文件写入完毕，关闭流
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
}

/**
 * 使用 FFmpeg 快速转封装 (TS -> MP4)
 * -c copy 模式不进行编解码，速度极快
 */
async function remuxToMp4(inputTs, outputMp4, ffmpegPath) {
    // -bsf:a aac_adtstoasc 用于修复音频流格式，这在从 TS 转 MP4 时通常是必须的
    // -movflags +faststart 将元数据移到文件头，利于网络播放
    const command = `"${ffmpegPath}" -y -i "${inputTs}" -c copy -bsf:a aac_adtstoasc -movflags +faststart "${outputMp4}"`;

    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('[Jable] FFmpeg Remux Error:', stderr);
                reject(new Error(`转封装失败: ${error.message}`));
            } else {
                resolve();
            }
        });
    });
}

/**
 * 主下载函数
 */
export async function downloadVideo(m3u8Url, outputDir, filename, onProgress, ffmpegPath, cookieString) {
    const tempDir = path.join(outputDir, 'temp_' + Date.now());
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 构造请求头
    const requestHeaders = {
        ...BASE_HEADERS,
        'Cookie': cookieString || ''
    };

    try {
        console.log(`[Jable] 下载 m3u8 列表...`);
        const m3u8Response = await axios.get(m3u8Url, { headers: requestHeaders, httpsAgent });

        const parser = new m3u8Parser.Parser();
        parser.push(m3u8Response.data);
        parser.end();

        const segments = parser.manifest.segments;
        if (!segments || segments.length === 0) throw new Error('m3u8 解析失败: 未找到分片');

        // 1. 获取解密 Key 和 IV
        let key = null;
        let iv = null;
        if (segments[0].key && segments[0].key.method === 'AES-128') {
            console.log(`[Jable] 检测到加密，正在获取密钥...`);
            const keyObj = segments[0].key;
            const keyUrl = new URL(keyObj.uri, m3u8Url).toString();
            const keyResponse = await axios.get(keyUrl, {
                responseType: 'arraybuffer',
                headers: requestHeaders,
                httpsAgent
            });
            key = Buffer.from(keyResponse.data);

            // ================== 【核心修复开始】 ==================
            // 修复 IV 长度问题
            if (keyObj.iv) {
                if (typeof keyObj.iv === 'string') {
                    // 如果是十六进制字符串，移除 0x 并补全到 32 位 (16字节)
                    const ivHex = keyObj.iv.replace(/^0x/i, '').padStart(32, '0');
                    iv = Buffer.from(ivHex, 'hex');
                } else if (keyObj.iv.constructor && keyObj.iv.constructor.name === 'Uint32Array') {
                    // m3u8-parser 经常返回 4个32位整数的数组，需要转换为 16字节 Buffer
                    const buf = Buffer.alloc(16);
                    for (let i = 0; i < keyObj.iv.length; i++) {
                        buf.writeUInt32BE(keyObj.iv[i], i * 4);
                    }
                    iv = buf;
                } else {
                    // 其他情况，尝试直接转换，并强制确保长度为 16
                    const tempIv = Buffer.from(keyObj.iv);
                    if (tempIv.length !== 16) {
                        console.warn(`[Jable] IV 长度异常 (${tempIv.length})，尝试修正...`);
                        iv = Buffer.alloc(16);
                        tempIv.copy(iv); // 复制现有数据，不足补0，多余截断
                    } else {
                        iv = tempIv;
                    }
                }
            } else {
                iv = Buffer.alloc(16, 0); // 默认 IV
            }
            // ================== 【核心修复结束】 ==================
        }

        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        // ... 后续代码保持不变 ...
        const totalSegments = segments.length;
        let downloadedCount = 0;

        // 2. 初始化并发控制器
        const limit = pLimit(CONCURRENT_LIMIT);
        console.log(`[Jable] 开始下载，并发数: ${CONCURRENT_LIMIT} ...`);

        const segmentFileNames = [];

        // 3. 创建任务队列
        const tasks = segments.map((seg, index) => {
            let segUrl = seg.uri.startsWith('http') ? seg.uri : new URL(seg.uri, baseUrl).toString();
            const segFilename = `${String(index).padStart(5, '0')}.ts`;
            segmentFileNames.push(segFilename);
            const segPath = path.join(tempDir, segFilename);

            return limit(async () => {
                await downloadSegmentWithRetry(segUrl, segPath, key, iv, requestHeaders);
                downloadedCount++;
                if (onProgress) onProgress(downloadedCount / totalSegments);
            });
        });

        await Promise.all(tasks);

        console.log(`[Jable] 下载完成，正在进行二进制合并...`);

        const combinedTsPath = path.join(outputDir, `combined_${Date.now()}.ts`);
        segmentFileNames.sort();
        await mergeFiles(tempDir, segmentFileNames, combinedTsPath);

        console.log(`[Jable] 合并完成，正在转封装为 MP4...`);

        const finalMp4Path = path.join(outputDir, filename);
        await remuxToMp4(combinedTsPath, finalMp4Path, ffmpegPath);

        if (fs.existsSync(combinedTsPath)) fs.unlinkSync(combinedTsPath);

        return finalMp4Path;

    } catch (error) {
        console.error('[Jable] 下载流程出错:', error);
        throw error;
    } finally {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.warn('[Jable] 清理临时文件失败:', e.message);
        }
    }
}