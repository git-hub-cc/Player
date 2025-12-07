import { defineConfig } from 'vite';
import { resolve } from 'path'; // ✨ 引入 path.resolve

// https://vitejs.dev/config
export default defineConfig({
    // 【核心修正】将 root 配置移到这里
    root: resolve(__dirname, 'src/renderer'), // ✨ 告诉 Vite 渲染进程的根目录是 src/renderer
});