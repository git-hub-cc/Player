import { defineConfig } from 'vite';
import { resolve } from 'path';

// https://vitejs.dev/config
export default defineConfig({
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    // 添加以下 server 配置
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true, // 端口被占用时直接退出，防止自动切换端口导致 Electron 找不到
    },
    build: {
        outDir: '../../.vite/renderer/main_window',
    }
});