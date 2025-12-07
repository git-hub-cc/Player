// forge.config.js

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
    packagerConfig: {
        asar: true,
        icon: './public/assets/app',
        // =========================================================================
        // 【核心修改】为 yt-dlp 添加 extraResource 配置
        //
        // 1. 我们不再手动打包 ffmpeg，因为它已由 ffmpeg-static 管理。
        // 2. 我们需要手动将 `yt-dlp` 目录完整复制到打包后应用的 resources 目录下，
        //    以便 `main-api.js` 中的路径逻辑能够在生产环境中找到它。
        //
        //    - 开发时: C:\...\Player\yt-dlp
        //    - 打包后: C:\Program Files\Player\resources\yt-dlp
        //
        // 【重要】请确保您已在项目根目录创建 `yt-dlp/win32-x64` 文件夹，
        //         并已将 `yt-dlp.exe` 放置在其中。
        // =========================================================================
        extraResource: [
            path.join(__dirname, 'yt-dlp')
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