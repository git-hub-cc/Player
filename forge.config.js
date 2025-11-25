// forge.config.js

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

module.exports = {
    packagerConfig: {
        asar: true,
        icon: './public/assets/app',
        // =========================================================================
        // 【最终确认】 这是确保 ffmpeg 目录被打包的正确配置
        //
        // 1. 属性名是 `extraResource` (单数)。
        // 2. 它告诉打包工具将项目根目录下的 'ffmpeg' 文件夹
        //    完整复制到打包后应用的 resources 目录下。
        //    - 开发时: C:\...\Player\ffmpeg
        //    - 打包后: C:\Program Files\Player\resources\ffmpeg
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