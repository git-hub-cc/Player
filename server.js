// server.js
const express = require('express');
const { exec } = require('child_process'); // 用于执行外部脚本
const path = require('path');
const cors = require('cors');
const fs = require('fs/promises'); // 【修改】使用 fs/promises

const app = express();
const port = 3000; // 您可以根据需要更改端口

// --- 中间件设置 ---
app.use(cors()); // 允许所有跨域请求
app.use(express.json()); // 用于解析 application/json 类型的请求体

// --- 静态文件托管 ---
// 托管项目根目录下的所有文件和文件夹
// 这样浏览器就可以访问 index.html, css/, js/, lib/, playlist.json 等
app.use(express.static(path.join(__dirname, '')));


// --- 【新增】更新播放列表的辅助函数 ---
async function updatePlaylist(awemeData) {
    try {
        const awemeDetail = awemeData?.aweme_detail;
        if (!awemeDetail) {
            console.warn('[Server] 播放列表未更新：响应中缺少 aweme_detail。');
            return false;
        }

        const newTrack = {
            title: awemeDetail.desc || "无标题视频",
            artist: awemeDetail.author?.nickname || "未知作者",
            src: `videos/${awemeDetail.aweme_id}.mp4`,
            albumArt: `albumArt/${awemeDetail.aweme_id}.jpg`,
            type: "video",
            lyrics: ""
        };

        if (!awemeDetail.aweme_id) {
            console.warn('[Server] 播放列表未更新：缺少 aweme_id。');
            return false;
        }

        const playlistPath = path.join(__dirname, 'playlist.json');
        const playlistData = await fs.readFile(playlistPath, 'utf-8');
        const playlist = JSON.parse(playlistData);

        // 检查重复项
        const isDuplicate = playlist.some(track => track.src === newTrack.src);
        if (isDuplicate) {
            console.log(`[Server] 曲目 ${newTrack.src} 已存在于 playlist.json，跳过添加。`);
            return false;
        }

        playlist.push(newTrack);
        await fs.writeFile(playlistPath, JSON.stringify(playlist, null, 4)); // 使用4个空格进行格式化
        console.log(`[Server] 成功将 ${newTrack.src} 添加到 playlist.json。`);
        return true;
    } catch (err) {
        console.error('[Server] 更新 playlist.json 时发生错误:', err);
        return false;
    }
}


// --- API 路由 ---
app.post('/download-douyin', (req, res) => {
    const { urlText } = req.body;

    if (!urlText || !urlText.trim()) {
        return res.status(400).json({ success: false, message: 'URL text cannot be empty.' });
    }

    console.log(`[Server] Received download request for: "${urlText}"`);

    const command = `node douyin_downloader.js "${urlText.replace(/"/g, '\\"')}"`;
    console.log(`[Server] Executing command: ${command}`);

    // 【修改】将回调函数设为 async 以便使用 await
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`[Server] Script execution error: ${error.message}`);
            return res.status(500).json({
                success: false,
                message: `Script execution failed.`,
                error: stderr || error.message
            });
        }

        if (stderr) {
            console.warn(`[Server] Script stderr: ${stderr}`);
        }

        console.log(`[Server] Script stdout:\n${stdout}`);

        if (stdout.includes("[下载模块] 下载成功！")) {
            let playlistUpdated = false;
            const jsonMatch = stdout.match(/---JSON_DATA_START---([\s\S]*)---JSON_DATA_END---/);

            if (jsonMatch && jsonMatch[1]) {
                try {
                    const apiResponseJson = JSON.parse(jsonMatch[1].trim());
                    playlistUpdated = await updatePlaylist(apiResponseJson);
                } catch (e) {
                    console.error('[Server] 解析脚本输出的JSON时失败:', e);
                }
            } else {
                console.warn('[Server] 未在脚本输出中找到用于更新播放列表的JSON数据。');
            }

            res.json({
                success: true,
                message: playlistUpdated ? 'Download completed and playlist updated!' : 'Download completed successfully!',
                output: stdout
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Script finished, but download success message not found.',
                output: stdout || stderr
            });
        }
    });
});


// --- 启动服务器 ---
app.listen(port, () => {
    console.log(`
    ===================================================================
    🚀 Server is running at http://localhost:${port}
    
    Your media player is now live! Open the above URL in your browser.
    The server will handle download requests on the /download-douyin endpoint.
    ===================================================================
    `);
});