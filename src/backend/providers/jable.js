// src/backend/providers/jable.js

// 【核心修改】从 'electron' 中导入 session 模块
import { BrowserWindow, session } from 'electron';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createDecipheriv } from 'crypto';
import { exec } from 'child_process';
import * as m3u8Parser from 'm3u8-parser';
import pLimit from 'p-limit';

// --- 配置 ---
const CONCURRENT_LIMIT = 64; // 并发下载数
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://jable.tv/',
    'Origin': 'https://jable.tv',
    'Connection': 'keep-alive'
};

/**
 * 从 Jable 视频页面获取 m3u8 URL 和元数据
 * @param {string} videoUrl - 视频页面 URL
 * @returns {Promise<object>} - { m3u8Url, title, coverUrl, cookieString }
 */
export async function getVideoInfo(videoUrl) {
    console.log(`[Jable] 正在获取视频信息: ${videoUrl}`);

    // 【核心修复】1. 定义一个唯一的会话分区，以隔离网络环境
    const partition = `persist:jable_session_${Date.now()}`;

    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
            offscreen: true,
            sandbox: true,
            contextIsolation: true,
            // 【核心修复】2. 使用该分区创建窗口，确保网络请求隔离
            partition: partition,
        }
    });

    try {
        // 【核心修复】3. 获取此窗口专属的会话对象
        const jableSession = session.fromPartition(partition);

        // 【核心修复】4. 在加载 URL 前，设置请求过滤器以移除 CSP 限制
        // 这是解决问题的关键，允许 Jable 页面的所有脚本（包括广告脚本）加载，从而触发 m3u8 请求
        jableSession.webRequest.onHeadersReceived((details, callback) => {
            if (details.responseHeaders['Content-Security-Policy']) {
                // 删除 CSP 头，解除内容加载限制
                delete details.responseHeaders['Content-Security-Policy'];
            }
            callback({ responseHeaders: details.responseHeaders });
        });

        let m3u8Url = null;
        const m3u8Promise = new Promise((resolve) => {
            // 注意：过滤器现在作用于隔离的 jableSession，而不是默认会话
            const filter = { urls: ['*://*/*.m3u8'] };
            jableSession.webRequest.onBeforeRequest(filter, (details, callback) => {
                if (details.url.includes('.m3u8') && !details.url.includes('preview')) {
                    m3u8Url = details.url;
                    resolve(m3u8Url);
                }
                callback({ cancel: false });
            });
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('获取 m3u8 超时 (30秒)')), 30000)
        );

        await win.loadURL(videoUrl);
        await win.webContents.executeJavaScript('document.readyState === "complete"');

        const metaData = await win.webContents.executeJavaScript(`
            (function() {
                const title = document.querySelector('meta[property="og:title"]')?.content || document.title;
                const cover = document.querySelector('video')?.poster || document.querySelector('meta[property="og:image"]')?.content;
                return { title, cover };
            })();
        `);

        m3u8Url = await Promise.race([m3u8Promise, timeoutPromise]);
        const cookies = await jableSession.cookies.get({ url: videoUrl });
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
        if (win && !win.isDestroyed()) {
            win.close();
        }
    }
}

/**
 * 下载并解密单个 TS 分片 (带重试和退避机制)
 */
async function downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt = 1) {
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
            httpsAgent: httpsAgent,
            timeout: 20000
        });

        let data = Buffer.from(response.data);

        if (key && iv) {
            const decipher = createDecipheriv('aes-128-cbc', key, iv);
            data = Buffer.concat([decipher.update(data), decipher.final()]);
        }

        await fs.promises.writeFile(destPath, data);

    } catch (error) {
        const maxRetries = 5;
        if (attempt <= maxRetries) {
            const status = error.response?.status;
            // 如果是服务器限流，则增加等待时间
            const delay = (status === 428 || status === 429) ? 2000 * attempt : 1000;
            await new Promise(r => setTimeout(r, delay));
            return downloadSegmentWithRetry(url, destPath, key, iv, headers, attempt + 1);
        }
        throw error;
    }
}

/**
 * 使用 Node.js 流式合并 TS 文件 (替代 FFmpeg concat)
 */
async function mergeFiles(tempDir, fileNames, outputPath) {
    const writeStream = fs.createWriteStream(outputPath);
    for (const fileName of fileNames) {
        const filePath = path.join(tempDir, fileName);
        await new Promise((resolve, reject) => {
            if (!fs.existsSync(filePath)) {
                console.warn(`[Jable] 警告：缺失片段 ${fileName}，跳过合并。`);
                resolve();
                return;
            }
            const readStream = fs.createReadStream(filePath);
            readStream.pipe(writeStream, { end: false });
            readStream.on('end', resolve);
            readStream.on('error', (err) => {
                console.error(`[Jable] 读取片段出错 ${fileName}:`, err);
                reject(err);
            });
        });
    }
    return new Promise((resolve, reject) => {
        writeStream.end();
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
}

/**
 * 使用 FFmpeg 快速转封装 (TS -> MP4)
 */
async function remuxToMp4(inputTs, outputMp4, ffmpegPath) {
    const command = `"${ffmpegPath}" -y -i "${inputTs}" -c copy -bsf:a aac_adtstoasc -movflags +faststart "${outputMp4}"`;
    console.log(`[Jable] 准备执行 FFmpeg 转封装命令: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('[Jable] FFmpeg Remux Error:', stderr);
                reject(new Error(`转封装失败: ${error.message}`));
            } else {
                console.log('[Jable] FFmpeg 转封装成功。');
                resolve();
            }
        });
    });
}

/**
 * 主下载函数，负责整个下载、解密、合并和转封装流程
 */
export async function downloadVideo(m3u8Url, outputDir, filename, onProgress, ffmpegPath, cookieString) {
    // 创建一个唯一的临时目录来存放 TS 分片
    const tempDir = path.join(outputDir, 'temp_' + Date.now());
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const requestHeaders = { ...BASE_HEADERS, 'Cookie': cookieString || '' };

    try {
        console.log(`[Jable] 下载 m3u8 列表...`);
        const m3u8Response = await axios.get(m3u8Url, { headers: requestHeaders, httpsAgent });

        const parser = new m3u8Parser.Parser();
        parser.push(m3u8Response.data);
        parser.end();

        const segments = parser.manifest.segments;
        if (!segments || segments.length === 0) {
            throw new Error('m3u8 解析失败: 未找到视频分片');
        }

        let key = null;
        let iv = null;
        // 检查视频是否加密
        if (segments[0].key && segments[0].key.method === 'AES-128') {
            console.log(`[Jable] 检测到加密，正在获取密钥...`);
            const keyObj = segments[0].key;
            const keyUrl = new URL(keyObj.uri, m3u8Url).toString();
            const keyResponse = await axios.get(keyUrl, { responseType: 'arraybuffer', headers: requestHeaders, httpsAgent });
            key = Buffer.from(keyResponse.data);

            // 处理 IV (初始化向量)
            if (keyObj.iv) {
                // 根据不同格式处理 IV
                if (typeof keyObj.iv === 'string') {
                    const ivHex = keyObj.iv.replace(/^0x/i, '').padStart(32, '0');
                    iv = Buffer.from(ivHex, 'hex');
                } else if (keyObj.iv.constructor && keyObj.iv.constructor.name === 'Uint32Array') {
                    const buf = Buffer.alloc(16);
                    for (let i = 0; i < keyObj.iv.length; i++) {
                        buf.writeUInt32BE(keyObj.iv[i], i * 4);
                    }
                    iv = buf;
                } else {
                    const tempIv = Buffer.from(keyObj.iv);
                    // 确保 IV 长度为16字节
                    if (tempIv.length !== 16) {
                        console.warn(`[Jable] IV 长度异常 (${tempIv.length})，尝试修正...`);
                        iv = Buffer.alloc(16);
                        tempIv.copy(iv);
                    } else {
                        iv = tempIv;
                    }
                }
            } else {
                // 如果 m3u8 中没有提供 IV，则默认为全零
                iv = Buffer.alloc(16, 0);
            }
        }

        const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
        const totalSegments = segments.length;
        let downloadedCount = 0;

        // 使用 p-limit 控制并发下载
        const limit = pLimit(CONCURRENT_LIMIT);
        console.log(`[Jable] 开始下载，并发数: ${CONCURRENT_LIMIT} ...`);

        const segmentFileNames = [];
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
        segmentFileNames.sort(); // 确保按顺序合并
        await mergeFiles(tempDir, segmentFileNames, combinedTsPath);

        console.log(`[Jable] 合并完成，正在转封装为 MP4...`);
        const finalMp4Path = path.join(outputDir, filename);
        await remuxToMp4(combinedTsPath, finalMp4Path, ffmpegPath);

        // 清理合并后的临时 TS 文件
        if (fs.existsSync(combinedTsPath)) fs.unlinkSync(combinedTsPath);

        return finalMp4Path;

    } catch (error) {
        console.error('[Jable] 下载流程出错:', error);
        throw error;
    } finally {
        // 无论成功与否，都尝试清理存放分片的临时目录
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (e) {
            console.warn('[Jable] 清理临时文件失败:', e.message);
        }
    }
}