// src/renderer/js/ui/contextMenu.js

/**
 * @file 上下文菜单模块
 * @description 负责渲染和控制右键上下文菜单。
 */

import * as dom from '../dom.js';
import { getters } from '../state.js';

/**
 * 隐藏上下文菜单。
 */
export function hideContextMenu() {
    if (dom.contextMenu) {
        dom.contextMenu.style.display = 'none';
    }
}

/**
 * 根据上下文信息，渲染并准备显示上下文菜单。
 * @param {object} [context={}] - 上下文信息，如点击的元素类型和索引。
 */
export function renderContextMenu(context = {}) {
    const menuList = dom.getContextMenuList();
    if (!menuList) return;

    menuList.innerHTML = ''; // 清空旧菜单项
    const fragment = document.createDocumentFragment();
    const playlist = getters.playlist();

    if (context.type === 'playlist-item' && typeof context.index === 'number') {
        const track = playlist[context.index];
        if (!track) return;

        // 如果是视频，则添加“分离音视频”选项
        if (track.type === 'video') {
            const li = document.createElement('li');
            li.textContent = '分离音视频';
            li.dataset.action = 'separate-video';
            li.dataset.index = context.index;
            fragment.appendChild(li);
        }

        // 添加“删除”选项
        const li = document.createElement('li');
        li.textContent = '删除';
        li.dataset.action = 'delete-track';
        li.dataset.index = context.index;
        fragment.appendChild(li);
    }

    if (fragment.hasChildNodes()) {
        menuList.appendChild(fragment);
    } else {
        hideContextMenu(); // 如果没有菜单项可显示，则直接隐藏
    }
}