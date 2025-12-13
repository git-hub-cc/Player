import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    resolve: {
        // 这是一个可选的优化，但建议添加。
        // 它告诉 Vite 在解析模块时优先使用为 Node.js 环境设计的入口点。
        mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    build: {
        // 这是一个可选的优化，但对于 Electron 主进程很有用。
        // 它会禁用代码压缩，使得在打包后如果出现问题，堆栈跟踪更容易阅读。
        // 对于生产环境，您可以将其设置为 'esbuild' 或 true 来减小文件大小。
        minify: false,
    },
    ssr: {
        // --------------------------------------------------------------------
        // 【核心修复】强制 Vite 将所有依赖项打包到主进程代码中
        // 这是解决 "Cannot find module" 错误的关键设置。
        // 它告诉 Vite 将所有依赖（包括 playwright-extra 和 merge-deep）
        // 而不是将它们作为外部的 'require()' 调用。
        // --------------------------------------------------------------------
        noExternal: true,
    }
});