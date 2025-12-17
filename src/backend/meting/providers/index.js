import NeteaseProvider from './netease.js';
// =========================================================================
// 【核心修改】移除对其他音乐平台提供者的导入
// 由于这些文件将被删除，相关的 import 语句也需要一并移除。
// import TencentProvider from './tencent.js';
// import KugouProvider from './kugou.js';
// import BaiduProvider from './baidu.js';
// import KuwoProvider from './kuwo.js';
// =========================================================================


/**
 * 音乐平台提供者工厂
 */
export default class ProviderFactory {
    // =========================================================================
    // 【核心修改】精简 providers 映射，只保留某网
    // =========================================================================
    static providers = {
        netease: NeteaseProvider,
        // tencent: TencentProvider,
        // kugou: KugouProvider,
        // baidu: BaiduProvider,
        // kuwo: KuwoProvider
    };

    /**
     * 创建指定平台的提供者实例
     * @param {string} platform 平台名称
     * @param {Object} meting Meting 实例
     * @returns {BaseProvider} 平台提供者实例
     */
    static create(platform, meting) {
        const ProviderClass = this.providers[platform];
        if (!ProviderClass) {
            throw new Error(`Unsupported platform: ${platform}`);
        }
        return new ProviderClass(meting);
    }

    /**
     * 获取支持的平台列表
     * @returns {string[]} 支持的平台名称数组
     */
    static getSupportedPlatforms() {
        return Object.keys(this.providers);
    }

    /**
     * 检查平台是否支持
     * @param {string} platform 平台名称
     * @returns {boolean} 是否支持
     */
    static isSupported(platform) {
        return platform in this.providers;
    }
}