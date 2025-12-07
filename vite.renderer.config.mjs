import { defineConfig } from 'vite';
import { resolve } from 'path';

// https://vitejs.dev/config
export default defineConfig({
    // 告诉 Vite 渲染进程的根目录是 src/renderer
    root: resolve(__dirname, 'src/renderer'),

    // =========================================================================
    // 【核心修复】设置 base 选项为 './'
    //
    // 1. 这是解决打包后白屏问题的关键。
    // 2. 它强制 Vite 在构建时生成相对路径的资源链接（例如 <script src="./assets/index.js">）。
    // 3. 这确保了当应用通过 file:// 协议加载时，index.html 能够正确地找到
    //    它旁边的 CSS 和 JavaScript 文件。
    // =========================================================================
    base: './',
    build: {
        outDir: '../../.vite/renderer/main_window', // 默认是这个，通常不需要改，但确保结构一致
    }

});