// src/backend/providers/base-provider.js

import { pinyin } from 'pinyin-pro';

/**
 * @class BaseProvider
 * @description 所有下载服务提供者的基类，定义了标准接口和通用功能。
 */
export class BaseProvider {
    /**
     * 构造函数，用于接收所有 Provider 都需要的通用依赖。
     * @param {object} dependencies - 依赖项对象。
     * @param {object} dependencies.config - 应用的全局配置。
     * @param {function} dependencies.sendMessageFunc - 向渲染进程发送消息的回调函数。
     * @param {string|null} dependencies.ffmpegPath - FFmpeg 的可执行文件路径。
     * @param {string|null} dependencies.ytDlpPath - yt-dlp 的可执行文件路径。
     * @param {string|null} dependencies.systemProxy - 系统代理设置。
     * @param {import('../services/library-service.js').LibraryService} dependencies.libraryService - 媒体库服务实例。
     */
    constructor(dependencies) {
        if (this.constructor === BaseProvider) {
            throw new Error("Abstract base class 'BaseProvider' cannot be instantiated directly.");
        }
        this.config = dependencies.config;
        this.sendMessage = dependencies.sendMessageFunc;
        this.ffmpegPath = dependencies.ffmpegPath;
        this.ytDlpPath = dependencies.ytDlpPath;
        this.systemProxy = dependencies.systemProxy;
        this.libraryService = dependencies.libraryService;

        // 通用 User-Agent
        this.spoofedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    /**
     * (抽象方法) 判断此 Provider 是否能处理给定的 URL。
     * @param {string} url - 用户输入的 URL。
     * @returns {boolean} - 如果能处理则返回 true，否则返回 false。
     */
    isApplicable(url) {
        throw new Error(`Provider '${this.constructor.name}' must implement 'isApplicable' method.`);
    }

    /**
     * (抽象方法) 执行下载和处理流程。
     * 【核心修改】增加了 signal 参数用于支持取消操作。
     * @param {string} url - 经过验证的、此 Provider 可以处理的 URL。
     * @param {AbortSignal} [signal] - 可选的中止信号。
     * @returns {Promise<void>}
     */
    async execute(url, signal) {
        throw new Error(`Provider '${this.constructor.name}' must implement 'execute' method.`);
    }

    /**
     * (辅助方法) 检查是否已被取消，如果是则抛出特定错误。
     * 方便子类在关键步骤进行检查。
     * @param {AbortSignal} signal
     */
    _checkCancelled(signal) {
        if (signal && signal.aborted) {
            const error = new Error('Download aborted by user');
            error.code = 'ERR_CANCELED';
            throw error;
        }
    }

    /**
     * (辅助方法) 清理文件名，移除不安全的字符。
     * @param {string} filename - 原始文件名。
     * @returns {string} - 清理后的安全文件名。
     */
    _sanitizeFilename(filename) {
        if (!filename) return 'untitled';
        const sanitized = filename.replace(/[\/\\?%*:|"<>_,\s\.\#\&\…'’]+/g, '-');
        return sanitized.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim();
    }

    /**
     * (辅助方法) 检查执行特定功能所必需的工具是否存在。
     * @param {Array<'ffmpeg'|'yt-dlp'>} requiredTools - 需要检查的工具名称数组。
     * @returns {boolean} - 如果所有必需工具都存在，则返回 true。
     */
    _checkTools(requiredTools) {
        const missing = requiredTools.filter(tool =>
            (tool === 'ffmpeg' && !this.ffmpegPath) || (tool === 'yt-dlp' && !this.ytDlpPath)
        );

        if (missing.length > 0) {
            this.sendMessage('download-status', {
                message: `Missing core components: ${missing.join(', ')}. Cannot continue.`,
                type: 'error',
                reason: 'tool_missing',
                missing: missing[0]
            });
            return false;
        }
        return true;
    }

    /**
     * (辅助方法) 创建一个新的媒体库轨道对象，并将其添加到播放列表中。
     * @param {object} trackInfo - 包含新轨道信息的对象。
     */
    async _addTrackToPlaylist(trackInfo) {
        const { title, artist, src, albumArt, type } = trackInfo;
        const newTrack = {
            title, artist, src, albumArt, type, lyrics: "",
            pinyin: pinyin(title, { toneType: 'none' }).replace(/\s/g, ''),
            initials: pinyin(title, { pattern: 'initial', toneType: 'none' }).replace(/\s/g, '')
        };

        // 使用注入的 libraryService 实例来更新播放列表
        await this.libraryService.updateLocalPlaylist([newTrack]);

        // 通知渲染进程有新曲目添加
        this.sendMessage('new-track-added', newTrack);
    }
}