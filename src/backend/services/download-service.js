// src/backend/services/download-service.js

import path from 'path';
import fs from 'fs';
import axios from 'axios';

// --- 常量 ---
const DOWNLOAD_RETRY_COUNT = 3;

/**
 * @class DownloadService
 * @description 负责处理所有媒体下载请求。
 *              它作为策略模式中的“上下文”(Context)，将具体的下载任务委托给
 *              由 ProviderRegistry 提供的合适“策略”(Provider)。
 */
export class DownloadService {
    // #providerRegistry 用于查找能处理特定 URL 的下载器
    #providerRegistry;

    /**
     * @param {import('../providers/provider-registry.js').ProviderRegistry} providerRegistry - Provider 注册表实例。
     */
    constructor(providerRegistry) {
        this.#providerRegistry = providerRegistry;
        // 在构造时即初始化所有 Provider
        this.#providerRegistry.initializeProviders();
        console.log('[Download Service] 服务已实例化，并已配置好所有下载提供者。');
    }

    /**
     * 处理下载请求的主入口。
     * @param {object|string} requestData - 包含 URL 的请求数据。
     */
    async handleDownloadRequest(requestData) {
        const url = typeof requestData === 'object' ? requestData.url : requestData;

        // 委托给注册表查找能处理此 URL 的 Provider
        const provider = this.#providerRegistry.findProviderFor(url);

        if (provider) {
            // 如果找到，则执行该 Provider 的下载逻辑
            try {
                // sendMessageFunc 在 provider 内部通过其构造函数获取
                provider.sendMessage('download-status', { message: `已匹配处理器: ${provider.constructor.name}，开始处理...`, type: 'default' });

                // 从输入中提取第一个有效的 URL
                const urlMatch = url.match(/https?:\/\/[^\s]+/);
                if (!urlMatch) {
                    throw new Error('输入内容不是一个有效的 URL 链接。');
                }
                const cleanUrl = urlMatch[0];

                await provider.execute(cleanUrl);
            } catch (error) {
                console.error(`[Download Service] Provider '${provider.constructor.name}' 执行失败:`, error);
                provider.sendMessage('download-status', { message: `处理失败: ${error.message}`, type: 'error' });
            }
        } else {
            // 如果未找到，尝试使用抖音作为后备策略
            const fallbackProvider = this.#providerRegistry.findProviderFor('https://www.douyin.com');
            if (fallbackProvider) {
                fallbackProvider.sendMessage('download-status', { message: `未知链接，尝试作为抖音视频处理...`, type: 'default' });
                try {
                    await fallbackProvider.execute(url);
                } catch (error) {
                    console.error(`[Download Service] 抖音后备处理失败:`, error);
                    fallbackProvider.sendMessage('download-status', { message: `处理失败: ${error.message}`, type: 'error' });
                }
            } else {
                // 如果连抖音处理器都没有，则报告错误
                // 注意：这种情况理论上不应发生，因为ProviderRegistry会注册所有Provider
                console.error(`[Download Service] 找不到任何可以处理 "${url}" 的 Provider，甚至找不到后备 Provider。`);
                // 此处我们无法发送消息，因为没有 provider 实例
            }
        }
    }

    /**
     * 在按需下载工具成功后，更新 Provider 注册表中的工具路径。
     * @param {'ffmpeg' | 'yt-dlp'} toolName - 工具名称。
     * @param {string} newPath - 新的路径。
     */
    updateToolPath(toolName, newPath) {
        this.#providerRegistry.updateToolPath(toolName, newPath);
        console.log(`[Download Service] ${toolName} 路径已更新: ${newPath}`);
    }
}

/**
 * 通用文件下载辅助函数，供所有 providers 使用。
 * @param {string} url - 文件的 URL。
 * @param {string} folder - 保存目录。
 * @param {string} fileName - 文件名。
 * @param {object} headers - 请求头。
 * @param {function} onProgress - 进度回调函数，接收一个 0-1 的小数。
 * @param {number} retries - 重试次数。
 * @returns {Promise<void>}
 */
export async function downloadFile(url, folder, fileName, headers = {}, onProgress = () => {}, retries = DOWNLOAD_RETRY_COUNT) {
    const filePath = path.join(folder, fileName);
    if (fs.existsSync(filePath)) {
        try {
            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) {
                console.log(`[Download Util] 文件 ${fileName} 已存在且非空，跳过。`);
                onProgress(1);
                return;
            }
        } catch (e) { /* 忽略 stat 错误 */ }
    }

    for (let i = 0; i < retries; i++) {
        try {
            const writer = fs.createWriteStream(filePath);
            const response = await axios({
                url, method: 'GET', responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0', ...headers }
            });

            const totalLength = parseInt(response.headers['content-length'], 10);
            let downloadedLength = 0;

            response.data.on('data', chunk => {
                downloadedLength += chunk.length;
                if (totalLength > 0) onProgress(downloadedLength / totalLength);
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return;

            throw new Error('下载的文件为空。');
        } catch (error) {
            console.warn(`[Download Util] 下载 ${fileName} 第 ${i + 1} 次尝试失败: ${error.message}`);
            if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(e => console.error(e));
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
    }
}