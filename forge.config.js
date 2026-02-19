// forge.config.js

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
    packagerConfig: {
        asar: true,
        icon: path.resolve(__dirname, 'src/renderer/assets/app'),
        extraResource: [],
        // =========================================================================
        // 【核心新增】文件关联配置
        // 此配置会告知操作系统，我们的应用可以作为某些文件类型的默认打开方式。
        // 这对于 Windows 和 macOS 的安装包都有效。
        // =========================================================================
        fileAssociations: [
            {
                ext: 'mp4',
                name: 'MP4 Video File',
                role: 'Viewer',
                icon: path.resolve(__dirname, 'src/renderer/assets/app.ico'), // Windows 使用 .ico
            },
            {
                ext: 'mkv',
                name: 'MKV Video File',
                role: 'Viewer',
                icon: path.resolve(__dirname, 'src/renderer/assets/app.ico'),
            },
            {
                ext: 'webm',
                name: 'WebM Video File',
                role: 'Viewer',
                icon: path.resolve(__dirname, 'src/renderer/assets/app.ico'),
            },
            {
                ext: 'mp3',
                name: 'MP3 Audio File',
                role: 'Viewer',
                icon: path.resolve(__dirname, 'src/renderer/assets/app.ico'),
            },
            {
                ext: 'flac',
                name: 'FLAC Audio File',
                role: 'Viewer',
                icon: path.resolve(__dirname, 'src/renderer/assets/app.ico'),
            },
        ],
        // =========================================================================
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'Player',
                setupIcon: path.resolve(__dirname, 'src/renderer/assets/app.ico'),
            }
        },
        // =========================================================================
        // 【核心修改】将 maker-zip 更换为 maker-dmg 以支持 macOS 上的文件关联
        // .dmg 安装包是 macOS 的标准分发方式，能更好地与系统集成。
        // =========================================================================
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
            config: {
                // DMG 安装包的配置可以根据需要添加，例如背景图、窗口大小等
                // background: path.resolve(__dirname, 'src/renderer/assets/dmg-background.png'), // (可选) 示例背景图
                format: 'ULFO'
            }
        },
        // =========================================================================
        {
            name: '@electron-forge/maker-deb',
            config: {
                // =========================================================================
                // 【核心新增】为 Debian/Ubuntu 添加 MIME 类型支持
                // =========================================================================
                options: {
                    icon: path.resolve(__dirname, 'src/renderer/assets/app.png'), // 显式指定 Linux 图标
                    mimeType: [
                        'video/mp4',
                        'video/x-matroska',
                        'video/webm',
                        'audio/mpeg',
                        'audio/flac',
                    ],
                },
                // =========================================================================
            },
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {},
        },
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-vite',
            config: {
                build: [
                    {
                        entry: 'src/backend/main-api.js',
                        config: 'vite.main.config.mjs',
                    },
                    {
                        entry: 'src/preload/preload.js',
                        config: 'vite.preload.config.mjs',
                    },
                ],
                renderer: [
                    {
                        name: 'main_window',
                        html: 'src/renderer/index.html',
                        config: 'vite.renderer.config.mjs',
                    },
                ],
            },
        },
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};