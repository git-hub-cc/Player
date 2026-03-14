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
    #providerRegistry;
    #currentAbortController = null;

    /**
     * @param {import('../providers/provider-registry.js').ProviderRegistry} providerRegistry - Provider 注册表实例。
     */
    constructor(providerRegistry) {
        this.#providerRegistry = providerRegistry;
        this.#providerRegistry.initializeProviders();
        console.log(`[Download Service] Service instantiated and providers configured.`);
    }

    /**
     * 处理下载请求的主入口。
     * @param {object|string} requestData - 包含 URL 的请求数据。
     */
    async handleDownloadRequest(requestData) {
        const url = typeof requestData === 'object' ? requestData.url : requestData;

        if (this.#currentAbortController) {
            this.#currentAbortController.abort();
        }
        this.#currentAbortController = new AbortController();
        const signal = this.#currentAbortController.signal;

        // 委托给注册表查找能处理此 URL 的 Provider
        const provider = this.#providerRegistry.findProviderFor(url);

        if (provider) {
            try {
                provider.sendMessage('download-status', { message: `已匹配处理器: ${provider.constructor.name}，开始处理...`, type: 'default' });

                const urlMatch = url.match(/https?:\/\/[^\s]+/);
                if (!urlMatch) {
                    throw new Error('输入内容不是一个有效的 URL 链接。');
                }
                const cleanUrl = urlMatch[0];

                await provider.execute(cleanUrl, signal);

            } catch (error) {
                if (signal.aborted || (error.code === 'ERR_CANCELED') || error.message.includes('aborted')) {
                    console.log(`[Download Service] 任务已由用户取消: ${url}`);
                    provider.sendMessage('download-status', { message: '下载已取消', type: 'error' });
                } else {
                    console.error(`[Download Service] Provider '${provider.constructor.name}' 执行失败:`, error);
                    provider.sendMessage('download-status', { message: `处理失败: ${error.message}`, type: 'error' });
                }
            } finally {
                this.#currentAbortController = null;
            }
        } else {
            // =========================================================================
            // 【核心修改】移除硬编码的抖音后备逻辑
            // 由于 GenericYtDlpProvider 的存在，如果 URL 未被任何专用 Provider 匹配，
            // ProviderRegistry 也会返回 GenericYtDlpProvider，因此理论上 provider 不会为 null。
            // 此处保留一个最终的错误处理。
            // =========================================================================
            const errorMessage = `找不到任何可以处理 "${url}" 的 Provider。链接可能不受支持。`;
            console.error(`[Download Service] ${errorMessage}`);
            // 获取一个 sendMessage 回调（从任意 provider 或直接从 DI 容器，这里简化处理）
            const anyProvider = this.#providerRegistry.findProviderFor('https://douyin.com'); // 借用一个
            if (anyProvider) {
                anyProvider.sendMessage('download-status', { message: errorMessage, type: 'error' });
            }
            this.#currentAbortController = null;
        }
    }

    /**
     * 取消当前正在进行的下载任务
     */
    cancelCurrentTask() {
        if (this.#currentAbortController) {
            console.log('[Download Service] 收到取消指令，正在中止当前任务...');
            this.#currentAbortController.abort();
            this.#currentAbortController = null;
        }
    }

    /**
     * 更新工具路径
     */
    updateToolPath(toolName, newPath) {
        this.#providerRegistry.updateToolPath(toolName, newPath);
        console.log(`[Download Service] ${toolName} 路径已更新: ${newPath}`);
    }
}

/**
 * 通用文件下载辅助函数，供所有 providers 使用。
 */
export async function downloadFile(url, folder, fileName, headers = {}, onProgress = () => {}, retries = DOWNLOAD_RETRY_COUNT, signal = null) {
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
        if (signal && signal.aborted) {
            throw new Error('Download aborted by user');
        }

        try {
            const writer = fs.createWriteStream(filePath);

            const onAbort = () => {
                writer.destroy();
                if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
            };
            if (signal) signal.addEventListener('abort', onAbort);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
                signal: signal
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
                if (signal) {
                    signal.addEventListener('abort', () => reject(new Error('Download aborted')));
                }
            });

            if (signal) signal.removeEventListener('abort', onAbort);

            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return;

            throw new Error('下载的文件为空。');
        } catch (error) {
            if (axios.isCancel(error) || (signal && signal.aborted)) {
                if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(() => {});
                throw new Error('Download aborted by user');
            }

            console.warn(`[Download Util] 下载 ${fileName} 第 ${i + 1} 次尝试失败: ${error.message}`);
            if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(e => console.error(e));

            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
    }
}