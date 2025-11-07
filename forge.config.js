const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: true,
        // =========================================================================
        // 【新增】在这里指定应用程序的图标。
        // Electron Forge 会在打包时使用这个文件为不同平台创建图标。
        // 注意：强烈建议为 Windows 提供 .ico 文件，为 macOS 提供 .icns 文件。
        // 例如: icon: 'public/icons/icon' (不带扩展名，Forge 会自动选择 .ico 或 .icns)
        icon: './public/assets/app',
        // =========================================================================
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
                // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
                // If you are familiar with Vite configuration, it will look really familiar.
                build: [
                    {
                        // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
                        entry: 'src/main.js',
                        config: 'vite.main.config.mjs',
                        target: 'main',
                    },
                    {
                        entry: 'src/preload.js',
                        config: 'vite.preload.config.mjs',
                        target: 'preload',
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
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
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