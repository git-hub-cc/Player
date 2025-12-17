// src/backend/meting/providers/netease.js

import crypto from 'crypto';
import BaseProvider from './base.js';

// --- EAPI (加密 API) 相关常量 ---
const EAPI_KEY = 'e82ckenh8dichen8';

/**
 * 某网音乐平台提供者
 */
export default class NeteaseProvider extends BaseProvider {
    constructor(meting) {
        super(meting);
        this.name = 'netease';
    }

    /**
     * 获取某网音乐的请求头配置 (EAPI 风格)。
     * 模拟安卓客户端请求头以获得更稳定的接口响应。
     */
    getHeaders() {
        const timestamp = Date.now().toString();
        const deviceId = this._generateDeviceId(); // 生成随机设备ID

        return {
            'Referer': 'music.163.com',
            'Cookie': `osver=android; appver=8.7.01; os=android; deviceId=${deviceId}; channel=netease; requestId=${timestamp}_${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}; __remember_me=true`,
            'User-Agent': 'Mozilla/5.0 (Linux; Android 11; M2007J3SC Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/77.0.3865.120 MQQBrowser/6.2 TBS/045714 Mobile Safari/537.36 NeteaseMusic/8.7.01',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded'
        };
    }

    /**
     * 搜索歌曲
     */
    search(keyword, option = {}) {
        return {
            method: 'POST',
            url: 'http://music.163.com/api/cloudsearch/pc',
            body: {
                s: keyword,
                type: option.type || 1, // 1: 单曲
                limit: option.limit || 30,
                total: 'true',
                offset: (option.page && option.limit) ? (option.page - 1) * option.limit : 0
            },
            encode: 'netease_eapi',
            format: 'result.songs' // 指定数据提取路径
        };
    }

    /**
     * 获取歌曲详情
     */
    song(id) {
        return {
            method: 'POST',
            url: 'http://music.163.com/api/v3/song/detail/',
            body: {
                c: `[{"id":${id},"v":0}]`
            },
            encode: 'netease_eapi',
            format: 'songs'
        };
    }

    /**
     * 获取专辑信息
     */
    album(id) {
        return {
            method: 'POST',
            url: `http://music.163.com/api/v1/album/${id}`,
            body: {
                total: 'true',
                offset: '0',
                id: id,
                limit: '1000',
                ext: 'true',
                private_cloud: 'true'
            },
            encode: 'netease_eapi',
            format: 'songs'
        };
    }

    /**
     * 获取艺术家作品
     */
    artist(id, limit = 50) {
        return {
            method: 'POST',
            url: `http://music.163.com/api/v1/artist/${id}`,
            body: {
                ext: 'true',
                private_cloud: 'true',
                top: limit,
                id: id
            },
            encode: 'netease_eapi',
            format: 'hotSongs'
        };
    }

    /**
     * 获取播放列表
     */
    playlist(id) {
        return {
            method: 'POST',
            url: 'http://music.163.com/api/v6/playlist/detail',
            body: {
                s: '0',
                id: id,
                n: '1000', // 获取歌单内所有歌曲
                t: '0'
            },
            encode: 'netease_eapi',
            format: 'playlist.tracks'
        };
    }

    /**
     * 获取音频播放链接
     */
    url(id, br = 320) {
        return {
            method: 'POST',
            url: 'http://music.163.com/api/song/enhance/player/url', // 使用 enhance 接口
            body: {
                ids: [id],
                br: br * 1000 // 比特率单位为 bps
            },
            encode: 'netease_eapi',
            decode: 'netease_url' // 指定解码方法
        };
    }

    /**
     * 获取歌词
     */
    lyric(id) {
        return {
            method: 'POST',
            url: 'http://music.163.com/api/song/lyric',
            body: {
                id: id,
                os: 'linux',
                lv: -1, // 获取歌词
                kv: -1, // 无需卡拉OK
                tv: -1  // 无需翻译
            },
            encode: 'netease_eapi',
            decode: 'netease_lyric' // 指定解码方法
        };
    }

    /**
     * 获取封面图片
     */
    async pic(id, size = 300) {
        // 封面图链接是公开的，直接拼接即可
        const url = `https://p3.music.126.net/${this._encryptId(id)}/${id}.jpg?param=${size}y${size}`;
        return JSON.stringify({ url: url });
    }

    /**
     * 格式化某网音乐数据为标准格式
     */
    format(data) {
        const result = {
            id: data.id,
            name: data.name,
            artist: (data.ar || []).map(artist => artist.name),
            album: data.al?.name || '',
            pic_id: data.al?.pic_str || data.al?.pic,
            url_id: data.id,
            lyric_id: data.id,
            source: 'netease'
        };

        // 从 picUrl 中提取 pic_id，作为备用方案
        if (!result.pic_id && data.al?.picUrl) {
            const match = data.al.picUrl.match(/\/(\d+)\./);
            if (match) {
                result.pic_id = match[1];
            }
        }
        return result;
    }

    /**
     * 处理某网音乐的编码逻辑 (EAPI 加密)
     */
    async handleEncode(api) {
        if (api.encode === 'netease_eapi') {
            return this.eapiEncrypt(api);
        }
        return api;
    }

    /**
     * 某网音乐 EAPI 加密实现
     */
    async eapiEncrypt(api) {
        const text = JSON.stringify(api.body);
        const urlPath = api.url.replace(/https?:\/\/[^\/]+/, '');

        // 构建 eapi 加密消息体
        const message = `nobody${urlPath}use${text}md5forencrypt`;
        const digest = crypto.createHash('md5').update(message).digest('hex');
        const data = `${urlPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;

        // AES-128-ECB 加密
        const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
        cipher.setAutoPadding(true);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        api.url = api.url.replace('/api/', '/eapi/'); // 将 URL 路径从 /api/ 切换到 /eapi/
        api.body = {
            params: encrypted.toUpperCase() // 参数封装在 params 字段中
        };
        return api;
    }

    /**
     * =========================================================================
     * 【核心修改】某网音乐 URL 解码
     * 不再只返回 URL、大小和比特率，而是返回包含所有信息的完整对象。
     * 这样上层调用者 (MusicApiService) 才能访问到 `fee` 等关键字段。
     * =========================================================================
     */
    urlDecode(result) {
        const data = JSON.parse(result);
        // 从 data.data 数组中取出第一个元素，这是我们需要的轨道信息对象
        const trackData = data.data && data.data[0] ? data.data[0] : null;

        if (trackData && trackData.url) {
            // 字段名标准化，方便上层统一处理
            if (trackData.br) trackData.br = trackData.br / 1000;
            return JSON.stringify(trackData);
        }

        // 如果没有有效的 URL，返回一个空对象结构
        return JSON.stringify({ url: null, size: 0, br: -1 });
    }

    /**
     * 某网音乐歌词解码
     */
    lyricDecode(result) {
        const data = JSON.parse(result);
        const lyricData = {
            lyric: (data.lrc && data.lrc.lyric) ? data.lrc.lyric : '',
            tlyric: (data.tlyric && data.tlyric.lyric) ? data.tlyric.lyric : '' // 翻译歌词
        };
        return JSON.stringify(lyricData);
    }

    // --- 私有工具方法 ---

    /**
     * 生成随机的十六进制字符串，用于模拟设备ID等。
     */
    _getRandomHex(length) {
        return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
    }

    /**
     * 生成模拟的安卓设备 ID。
     */
    _generateDeviceId() {
        return crypto.randomBytes(16).toString('hex').toUpperCase();
    }

    /**
     * 某网音乐图片 ID 加密算法，用于拼接封面图 URL。
     */
    _encryptId(id) {
        const magic = '3go8&$8*3*3h0k(2)2'.split('');
        const song_id = String(id).split('');

        for (let i = 0; i < song_id.length; i++) {
            song_id[i] = String.fromCharCode(
                song_id[i].charCodeAt(0) ^ magic[i % magic.length].charCodeAt(0)
            );
        }

        const result = crypto.createHash('md5')
            .update(song_id.join(''), 'binary')
            .digest('base64')
            .replace(/\//g, '_')
            .replace(/\+/g, '-');

        return result;
    }
}