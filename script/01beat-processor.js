// beat-processor.js (版本 5.1 - 使用 colorthief 提取颜色)
// 描述:
// 该脚本用于预处理媒体文件，扫描多个指定目录（如 videos, music），
// 使用 `aubiotrack.exe` 提取节拍时间戳，并据此计算 BPM 和主节拍周期。
// 同时，为音频文件从专辑封面提取颜色调色板。
// 依赖: npm install colorthief

import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';
import iconv from 'iconv-lite';
import ColorThief from 'colorthief'; // 【修改】引入 colorthief

// --- 配置 ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '.');
const PLAYLIST_PATH = path.join(ROOT_DIR, 'playlist.json');
const TEMP_DIR = path.join(ROOT_DIR, 'temp_audio');

const MEDIA_DIRS = [
    path.join(ROOT_DIR, 'videos'),
    path.join(ROOT_DIR, 'music')
];

// ... (函数 executeCommand, calculateBpm, scanMediaFiles 保持不变) ...
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { encoding: 'buffer' }, (error, stdout, stderr) => {
            const stdoutStr = iconv.decode(Buffer.from(stdout), 'gbk');
            const stderrStr = iconv.decode(Buffer.from(stderr), 'gbk');

            if (error) {
                console.error(`执行命令失败: ${command}`);
                console.error(`错误信息: ${stderrStr.trim()}`);
                error.message = stderrStr.trim();
                return reject(error);
            }
            resolve(stdoutStr.trim());
        });
    });
}

function calculateBpm(beats) {
    if (!beats || beats.length < 2) return { bpm: 0, beatInterval: 0 };
    const intervals = [];
    for (let i = 1; i < beats.length; i++) {
        intervals.push(beats[i] - beats[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const midIndex = Math.floor(intervals.length / 2);
    const medianInterval = intervals.length % 2 === 0 ? (intervals[midIndex - 1] + intervals[midIndex]) / 2 : intervals[midIndex];
    if (medianInterval === 0) return { bpm: 0, beatInterval: 0 };
    const bpm = 60 / medianInterval;
    return { bpm, beatInterval: medianInterval };
}

async function scanMediaFiles(dir) {
    let files = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(await scanMediaFiles(fullPath));
            } else if (/\.(mp4|mp3|m4a|avi|mov)$/i.test(entry.name)) {
                files.push(fullPath);
            }
        }
    } catch (error) {
        console.error(`扫描目录失败: ${dir}`, error);
    }
    return files;
}

/**
 * 主处理函数。
 */
async function processMediaFiles() {
    console.log('🚀 开始处理媒体文件以进行节奏和颜色分析 (v5.1)...');

    try {
        await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (error) {
        console.error(`无法创建临时目录: ${TEMP_DIR}`, error);
        return;
    }

    let playlist = [];
    try {
        const data = await fs.readFile(PLAYLIST_PATH, 'utf-8');
        playlist = JSON.parse(data);
    } catch (error) {
        console.log('`playlist.json` 未找到或为空，将创建一个新的。');
    }

    console.log('📂 开始扫描媒体目录...');
    let mediaFiles = [];
    for (const dir of MEDIA_DIRS) {
        try {
            await fs.access(dir);
            console.log(` -> 正在扫描: ${path.relative(ROOT_DIR, dir)}`);
            const filesInDir = await scanMediaFiles(dir);
            mediaFiles = mediaFiles.concat(filesInDir);
        } catch (error) {
            console.warn(`⚠️  目录不存在，已跳过: ${path.relative(ROOT_DIR, dir)}`);
        }
    }

    if (mediaFiles.length === 0) {
        console.log('🤷 在配置的目录中未找到任何媒体文件。');
        return;
    }
    console.log(`🔍 找到了 ${mediaFiles.length} 个媒体文件。`);

    let filesProcessed = 0;
    for (const mediaPath of mediaFiles) {
        const relativeSrc = path.relative(ROOT_DIR, mediaPath).replace(/\\/g, '/');
        let track = playlist.find(t => t.src === relativeSrc);

        const hasBeatData = track && track.beats && track.beats.length > 0 && typeof track.beatInterval !== 'undefined';
        const hasColorData = track && track.colorPalettes && track.colorPalettes.length > 0;

        if (hasBeatData && (track.type === 'video' || (track.type === 'audio' && hasColorData))) {
            console.log(`✅ [${path.basename(mediaPath)}] 已是最新，跳过。`);
            continue;
        }

        console.log(`⏳ [${path.basename(mediaPath)}] 开始分析...`);
        filesProcessed++;

        const tempAudioPath = path.join(TEMP_DIR, `${path.parse(mediaPath).name}.wav`);

        try {
            if (!hasBeatData) {
                const ffmpegCommand = `ffmpeg -i "${mediaPath}" -y -vn -ar 44100 -ac 1 -c:a pcm_s16le "${tempAudioPath}"`;
                await executeCommand(ffmpegCommand);
                const aubioTrackCommand = `aubiotrack -i "${tempAudioPath}"`;
                const beatsOutput = await executeCommand(aubioTrackCommand);
                const beats = beatsOutput.split('\n').map(parseFloat).filter(t => !isNaN(t) && t > 0);
                const { bpm, beatInterval } = calculateBpm(beats);

                if (!track) {
                    track = {
                        title: path.parse(mediaPath).name,
                        artist: "未知艺术家",
                        src: relativeSrc,
                        albumArt: "",
                        type: ['.mp4', '.mov', '.avi'].includes(path.extname(mediaPath).toLowerCase()) ? 'video' : 'audio',
                        lyrics: ""
                    };
                    playlist.push(track);
                }
                track.bpm = bpm;
                track.beats = beats;
                track.beatInterval = beatInterval;
                console.log(`  -> 节奏: BPM ${bpm.toFixed(2)}, 周期 ${beatInterval.toFixed(3)}s`);
            }

            // --- 【修改】使用 colorthief 进行颜色提取 ---
            if (track.type === 'audio' && !hasColorData) {
                const albumArtPath = track.albumArt ? path.join(ROOT_DIR, track.albumArt) : '';
                if (albumArtPath) {
                    try {
                        await fs.access(albumArtPath);
                        const palette = await ColorThief.getPalette(albumArtPath, 8); // 提取8种主色

                        // 按亮度排序 (从暗到亮)
                        palette.sort((a, b) => (a[0] * 299 + a[1] * 587 + a[2] * 114) - (b[0] * 299 + b[1] * 587 + b[2] * 114));

                        const formatRgb = (rgb) => `rgb(${rgb.join(',')})`;

                        const colorPalettes = [];
                        if (palette.length >= 2) {
                            // 创造高对比度组合
                            colorPalettes.push([formatRgb(palette[0]), formatRgb(palette[palette.length - 1])]); // 最暗 & 最亮
                            if (palette.length >= 4) {
                                colorPalettes.push([formatRgb(palette[1]), formatRgb(palette[palette.length - 2])]); // 次暗 & 次亮
                            }
                            if (palette.length >= 6) {
                                colorPalettes.push([formatRgb(palette[palette.length - 1]), formatRgb(palette[2])]); // 最亮 & 第三暗
                                colorPalettes.push([formatRgb(palette[0]), formatRgb(palette[palette.length - 3])]); // 最暗 & 第三亮
                            }
                        }

                        if (colorPalettes.length > 0) {
                            track.colorPalettes = colorPalettes;
                            console.log(`  -> 颜色: 成功从封面提取了 ${colorPalettes.length} 组颜色。`);
                        } else {
                            console.warn(`  -> 颜色: 无法从封面提取有效的颜色组合。`);
                        }

                    } catch (artError) {
                        console.error(`  -> 颜色: 处理封面图 '${track.albumArt}' 失败:`, artError.message);
                    }
                }
            }
        } catch (error) {
            console.error(`❌ [${path.basename(mediaPath)}] 分析失败:`, error.message);
        } finally {
            try {
                await fs.unlink(tempAudioPath);
            } catch (err) { /* 忽略错误 */ }
        }
    }

    if (filesProcessed > 0) {
        try {
            await fs.writeFile(PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf-8');
            console.log(`\n💾 \`playlist.json\` 已成功更新！处理了 ${filesProcessed} 个新文件。`);
        } catch (error) {
            console.error('写入 `playlist.json` 失败:', error);
        }
    } else {
        console.log('\n👌 所有文件都已是最新状态，无需更新。');
    }

    try {
        const tempFiles = await fs.readdir(TEMP_DIR);
        if (tempFiles.length === 0) {
            await fs.rmdir(TEMP_DIR);
        }
    } catch (error) { /* 忽略错误 */ }

    console.log('🎉 处理完成！');
}

processMediaFiles().catch(error => {
    console.error('处理过程中发生严重错误:', error);
});