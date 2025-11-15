// forge.config.js

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path'); // 确保引入了 Node.js 的 path 模块

module.exports = {
    packagerConfig: {
        asar: true,
        icon: './public/assets/app',
        // =========================================================================
        // 【核心修复】 修正了属性名并使用了更可靠的路径
        //
        // 1. 属性名从 'extraResources' (错误) 修正为 'extraResource' (正确)。
        //    这是导致文件夹未被打包的根本原因。
        //
        // 2. 使用 path.join(__dirname, 'ffmpeg') 来确保路径的正确解析。
        //
        // 这个配置会告诉 Electron Forge 在打包时，
        // 将项目根目录下的 'ffmpeg' 文件夹完整地复制到
        // 打包后应用的 resources 目录下。
        // =========================================================================
        extraResource: [
            path.join(__dirname, 'ffmpeg')
        ],
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'Player',
                setupIcon: './public/assets/app.ico',
                iconUrl: 'https://github-production-user-asset-6210df.s3.amazonaws.com/96827876/511516278-b000fda9-25e9-40f4-b299-6e0404f0bb19.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20251107%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20251107T210545Z&X-Amz-Expires=300&X-Amz-Signature=df9a5a6d6c7a94243c590795458572875b9887832f4ab20dcd89b81f8dd5b73a&X-Amz-SignedHeaders=host',
            }
        },
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin'],
        },
        {
            name: '@electron-forge/maker-deb',
            config: {},
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
                        entry: 'src/main.js',
                        config: 'vite.main.config.mjs',
                    },
                    {
                        entry: 'src/preload.js',
                        config: 'vite.preload.config.mjs',
                    },
                ],
                renderer: [
                    {
                        name: 'main_window',
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