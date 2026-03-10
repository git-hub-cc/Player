import { defineConfig } from 'vite';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

// https://vitejs.dev/config
export default defineConfig({
    plugins: [vue()],

    // 告诉 Vite 渲染进程的根目录是 src/renderer
    root: resolve(__dirname, 'src/renderer'),

    // 设置 base 选项为 './'，使 Electron file:// 协议能正确加载资源
    base: './',
    build: {
        outDir: '../../.vite/renderer/main_window',
    }
});