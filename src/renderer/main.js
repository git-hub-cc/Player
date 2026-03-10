// src/renderer/main.js
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// 导入所有 CSS（保持原有样式不变）
import './css/base.css';
import './css/layout.css';
import './css/gallery.css';
import './css/player-view.css';
import './css/player-controls.css';
import './css/panels.css';
import './css/components.css';
import './css/responsive.css';

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.mount('#app');
