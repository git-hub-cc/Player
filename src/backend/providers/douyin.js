// src/backend/providers/douyin.js

import path from 'path';
// 【核心修改】从 'electron' 中导入 session 模块
import { BrowserWindow, session } from 'electron';
import { pinyin } from 'pinyin-pro';
import { updateLocalPlaylist } from '../services/library-service.js';
import { downloadFile } from '../services/download-service.js';

// --- 模块作用域变量 ---
let CONFIG = {};
let sendMessageCallback = () => {};

/**
 * 初始化抖音下载服务提供者。
 * @param {object} initParams - 初始化参数对象。
 * @param {object} initParams.config - 应用配置对象。
 * @param {function} initParams.sendMessageFunc - 发送消息到渲染进程的函数。
 */
export function init(initParams) {
    CONFIG = initParams.config;
    sendMessageCallback = initParams.sendMessageFunc;
    console.log('[Douyin Provider] 服务已初始化。');
}

/**
 * 处理单个抖音作品的下载和数据更新。
 * 这是一个内部辅助函数。
 * @param {object} awemeDetail - 从抖音 API 获取的作品详情对象。
 */
async function processAndDownloadItem(awemeDetail) {
    const awemeId = awemeDetail?.aweme_id;
    if (!awemeId) {
        console.warn('[Douyin Provider] 传入的作品详情无效，缺少 aweme_id。');
        return;
    }

    try {
        const videoUri = awemeDetail?.video?.play_addr?.uri;
        const coverUrl = awemeDetail?.video?.cover?.url_list?.[0];

        // 下载视频和封面
        if (videoUri) {
            await downloadFile(`https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`, CONFIG.VIDEOS_DIR, `${awemeId}.mp4`);
        }
        if (coverUrl) {
            await downloadFile(coverUrl, CONFIG.ALBUMART_DIR, `${awemeId}.jpg`);
        }

        const title = awemeDetail.desc || "无标题视频";
        const newTrack = {
            title,
            artist: awemeDetail.author?.nickname || "未知作者",
            src: `videos/${awemeId}.mp4`,
            albumArt: `albumArt/${awemeId}.jpg`,
            type: "video",
            lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        // 更新本地播放列表并通知渲染进程
        await updateLocalPlaylist([newTrack]);
        sendMessageCallback('new-track-added', newTrack);

    } catch (e) {
        sendMessageCallback('download-status', { message: `下载抖音作品 ${awemeId} 失败: ${e.message}`, type: 'error' });
    }
}

/**
 * 主处理函数，负责启动无头浏览器并拦截 API 来下载抖音视频。
 * @param {string} videoUrl - 抖音视频或用户主页的 URL。
 */
export async function handleDouyinDownload(videoUrl) {
    sendMessageCallback('download-status', { message: '正在启动无头浏览器以解析抖音链接...' });

    // 1. 定义一个唯一的会话分区名称，确保网络设置隔离
    const partitionName = `persist:douyin_session_${Date.now()}`;

    // 创建一个不显示的浏览器窗口来加载页面
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            // 2. 使用该分区名称来隔离会话
            partition: partitionName,
            // 注入 preload 脚本以绕过自动化检测
            preload: path.join(__dirname, '..', 'backend', 'douyin-preload.js'),
            contextIsolation: true,
            sandbox: true
        }
    });
    win.webContents.setAudioMuted(true);

    // =========================================================================
    // 【核心修改】在加载 URL 之前，强制为该会话设置直连代理
    // =========================================================================
    try {
        // 获取专属于此窗口的会话对象
        const douyinSession = session.fromPartition(partitionName);
        // 设置代理规则为 'direct://'，强制绕过所有系统代理
        await douyinSession.setProxy({ proxyRules: 'direct://' });
        console.log('[Douyin Provider] 抖音下载会话已强制设置为直连模式。');
    } catch (proxyError) {
        console.error('[Douyin Provider] 设置直连代理失败:', proxyError);
        sendMessageCallback('download-status', { message: `网络配置失败: ${proxyError.message}`, type: 'error' });
        if (win && !win.isDestroyed()) win.close();
        return; // 配置失败，中止后续操作
    }
    // =========================================================================

    try {
        // 创建一个 Promise 来等待 API 响应，并设置超时
        const apiResponsePromise = new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('API 响应超时 (60秒)')), 60000);
            let debuggerAttached = false;

            win.webContents.on('did-finish-load', async () => {
                if (debuggerAttached || win.isDestroyed()) return;
                debuggerAttached = true;

                try {
                    const debuggerApi = win.webContents.debugger;
                    await debuggerApi.attach('1.3');
                    await debuggerApi.sendCommand('Network.enable');

                    sendMessageCallback('download-status', { message: '页面已加载，正在监听网络数据...' });

                    // 监听所有网络响应
                    debuggerApi.on('message', async (event, method, params) => {
                        // 筛选出我们需要的作品详情 API
                        if (method === 'Network.responseReceived' && params.response.url.includes('aweme/v1/web/aweme/detail/')) {
                            try {
                                const { body } = await debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId });
                                clearTimeout(timeout); // 成功拦截，清除超时计时器
                                resolve(JSON.parse(body));
                            } catch (err) {
                                // 忽略特定错误，例如资源已被浏览器丢弃
                                if (!err.message.includes('No resource with given identifier found')) {
                                    reject(err);
                                }
                            }
                        }
                    });
                } catch (attachError) {
                    reject(new Error(`附加调试器失败: ${attachError.message}`));
                }
            });
        });

        // 加载目标 URL，并伪装成普通浏览器
        await win.loadURL(videoUrl, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' });
        sendMessageCallback('download-status', { message: '正在导航页面，等待 API 响应...' });

        // 等待 API 响应的 Promise 完成
        const apiResponseJson = await apiResponsePromise;
        if (!apiResponseJson?.aweme_detail) {
            throw new Error('未能拦截到有效的作品详情 API 响应。');
        }

        // 处理并下载拦截到的作品
        await processAndDownloadItem(apiResponseJson.aweme_detail);
        sendMessageCallback('download-status', { message: '视频下载完成！', type: 'success' });

    } catch (error) {
        sendMessageCallback('download-status', { message: `抖音解析失败: ${error.message}`, type: 'error' });
    } finally {
        // 确保浏览器窗口在完成后总是被关闭
        if (win && !win.isDestroyed()) {
            if (win.webContents.debugger.isAttached()) {
                await win.webContents.debugger.detach();
            }
            win.close();
        }
    }
}