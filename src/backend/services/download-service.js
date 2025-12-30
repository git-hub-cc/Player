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
 *              【新增功能】支持取消正在进行的下载任务。
 */
export class DownloadService {
    // #providerRegistry 用于查找能处理特定 URL 的下载器
    #providerRegistry;
    // #currentAbortController 用于控制当前正在进行的下载任务（URL下载模式通常一次一个）
    #currentAbortController = null;

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

        // 如果已有任务在运行，先取消它（防止冲突，或者根据需求排队）
        // 这里简单处理：如果用户发起新请求，视为想下载新的
        if (this.#currentAbortController) {
            this.#currentAbortController.abort();
        }
        // 创建新的中止控制器
        this.#currentAbortController = new AbortController();
        const signal = this.#currentAbortController.signal;

        // 委托给注册表查找能处理此 URL 的 Provider
        const provider = this.#providerRegistry.findProviderFor(url);

        if (provider) {
            try {
                // sendMessageFunc 在 provider 内部通过其构造函数获取
                provider.sendMessage('download-status', { message: `已匹配处理器: ${provider.constructor.name}，开始处理...`, type: 'default' });

                const urlMatch = url.match(/https?:\/\/[^\s]+/);
                if (!urlMatch) {
                    throw new Error('输入内容不是一个有效的 URL 链接。');
                }
                const cleanUrl = urlMatch[0];

                // 【核心修改】将 abortSignal 传递给 execute 方法
                await provider.execute(cleanUrl, signal);

            } catch (error) {
                // 区分是用户主动取消还是真正的错误
                if (signal.aborted || (error.code === 'ERR_CANCELED') || error.message.includes('aborted')) {
                    console.log(`[Download Service] 任务已由用户取消: ${url}`);
                    provider.sendMessage('download-status', { message: '下载已取消', type: 'error' }); // type error 会重置UI状态
                } else {
                    console.error(`[Download Service] Provider '${provider.constructor.name}' 执行失败:`, error);
                    provider.sendMessage('download-status', { message: `处理失败: ${error.message}`, type: 'error' });
                }
            } finally {
                // 任务结束（无论成功失败），清理 controller
                this.#currentAbortController = null;
            }
        } else {
            // 后备策略：尝试作为抖音视频处理
            const fallbackProvider = this.#providerRegistry.findProviderFor('https://www.douyin.com');
            if (fallbackProvider) {
                fallbackProvider.sendMessage('download-status', { message: `未知链接，尝试作为抖音视频处理...`, type: 'default' });
                try {
                    await fallbackProvider.execute(url, signal);
                } catch (error) {
                    if (signal.aborted || (error.code === 'ERR_CANCELED') || error.message.includes('aborted')) {
                        fallbackProvider.sendMessage('download-status', { message: '下载已取消', type: 'error' });
                    } else {
                        console.error(`[Download Service] 抖音后备处理失败:`, error);
                        fallbackProvider.sendMessage('download-status', { message: `处理失败: ${error.message}`, type: 'error' });
                    }
                } finally {
                    this.#currentAbortController = null;
                }
            } else {
                console.error(`[Download Service] 找不到任何可以处理 "${url}" 的 Provider。`);
            }
        }
    }

    /**
     * 【核心新增】取消当前正在进行的下载任务
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
 * 【核心修改】增加 signal 参数以支持取消。
 * @param {string} url - 文件的 URL。
 * @param {string} folder - 保存目录。
 * @param {string} fileName - 文件名。
 * @param {object} headers - 请求头。
 * @param {function} onProgress - 进度回调函数。
 * @param {number} retries - 重试次数。
 * @param {AbortSignal} [signal] - 可选的取消信号。
 * @returns {Promise<void>}
 */
export async function downloadFile(url, folder, fileName, headers = {}, onProgress = () => {}, retries = DOWNLOAD_RETRY_COUNT, signal = null) {
    const filePath = path.join(folder, fileName);
    // 检查是否已存在（且不为空）
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
        // 如果在重试前已经取消，直接抛出
        if (signal && signal.aborted) {
            throw new Error('Download aborted by user');
        }

        try {
            const writer = fs.createWriteStream(filePath);

            // 如果 writer 创建失败或被中止，需要在 error 中处理
            // 这里注册一个 signal 监听器，确保流被销毁
            const onAbort = () => {
                writer.destroy();
                if (fs.existsSync(filePath)) fs.unlink(filePath, () => {}); // 删除不完整文件
            };
            if (signal) signal.addEventListener('abort', onAbort);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
                // 【核心】传递 signal 给 axios
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
                // 监听流的关闭，如果是由 signal 触发的
                if (signal) {
                    signal.addEventListener('abort', () => reject(new Error('Download aborted')));
                }
            });

            // 清理监听器
            if (signal) signal.removeEventListener('abort', onAbort);

            const stats = await fs.promises.stat(filePath);
            if (stats.size > 0) return;

            throw new Error('下载的文件为空。');
        } catch (error) {
            // 如果是取消导致的错误，不再重试，直接抛出
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