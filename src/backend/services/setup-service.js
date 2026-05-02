import path from 'path';
import fs from 'fs';
import https from 'https';
import axios from 'axios';
import AdmZip from 'adm-zip';
import WinReg from 'winreg';
import { arch } from 'node:process';
import { dialog, shell } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let mainWindow;

async function detectSystemProxy() {
    console.log('[Proxy Detector] Detecting system proxy...');
    if (process.platform !== 'win32') {
        const proxyVar = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (proxyVar) {
            console.log(`[Proxy Detector] Found proxy in environment variables: ${proxyVar}`);
            return proxyVar;
        }
        console.log('[Proxy Detector] Non-Windows platform and no proxy found in environment variables.');
        return null;
    }
    try {
        const regKey = new WinReg({
            hive: WinReg.HKCU,
            key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
        });
        const values = await new Promise((resolve, reject) => {
            regKey.values((err, items) => {
                if (err) return reject(err);
                const result = {};
                items.forEach(item => { result[item.name] = item.value; });
                resolve(result);
            });
        });
        if (values.ProxyEnable === '0x1' && values.ProxyServer) {
            const proxyServer = values.ProxyServer.split(';')[0];
            const proxyUrl = `http://${proxyServer}`;
            console.log(`[Proxy Detector] System proxy detected: ${proxyUrl}`);
            return proxyUrl;
        }
        console.log('[Proxy Detector] System proxy not enabled.');
        return null;
    } catch (error) {
        console.error('[Proxy Detector] Failed to read registry proxy settings:', error);
        return null;
    }
}

function downloadFileWithProgress(url, destPath, displayName) {
    const MAX_RETRIES = 3;
    let attempts = 0;

    let lastProgress = -1;
    const sendProgress = (progress) => {
        if (progress > lastProgress) {
            lastProgress = progress;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', { file: displayName, progress });
            }
        }
    };

    async function attemptDownload() {
        attempts++;
        try {
            console.log(`[Downloader] Starting download for ${displayName} (Attempt ${attempts})...`);
            sendProgress(0);

            const response = await axios({
                url,
                method: 'GET',
                responseType: 'stream',
                httpsAgent: new https.Agent({ keepAlive: true }),
                timeout: 60000,
            });

            const finalUrl = response.request.res.responseUrl || url;
            if (finalUrl !== url) {
                console.log(`[Downloader] Redirected to: ${finalUrl}`);
            }

            const totalLength = parseInt(response.headers['content-length'], 10);
            const writer = fs.createWriteStream(destPath);
            let downloadedLength = 0;

            response.data.on('data', (chunk) => {
                downloadedLength += chunk.length;
                if (totalLength) {
                    const progress = Math.round((downloadedLength / totalLength) * 100);
                    sendProgress(progress);
                }
            });

            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    sendProgress(100);
                    console.log(`[Downloader] ${displayName} download complete.`);
                    resolve();
                });
                writer.on('error', (err) => {
                    console.error(`[Downloader] Error writing file ${displayName}:`, err);
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    reject(err);
                });
            });
        } catch (error) {
            console.error(`[Downloader] Download ${displayName} (Attempt ${attempts}) failed:`, error.message);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);

            if (attempts < MAX_RETRIES) {
                console.log(`[Downloader] ${MAX_RETRIES - attempts} retries remaining, retrying in 2 seconds...`);
                await new Promise(res => setTimeout(res, 2000));
                return attemptDownload();
            } else {
                throw new Error(`Failed to download ${displayName} after maximum retries.`);
            }
        }
    }
    return attemptDownload();
}

export async function downloadYtDlp(binDir) {
    const exeName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binaryPath = path.join(binDir, exeName);

    let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    if (process.platform === 'win32') {
        downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    } else if (process.platform === 'darwin') {
        downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { file: 'yt-dlp' });
    }
    console.log(`[yt-dlp Downloader] Starting download from GitHub: ${downloadUrl}`);

    try {
        await downloadFileWithProgress(downloadUrl, binaryPath, 'yt-dlp');

        console.log('[yt-dlp Downloader] Download complete.');
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(binaryPath, '755');
            } catch (e) {
                console.warn('[yt-dlp Downloader] Failed to set execution permission:', e);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: true, tool: 'yt-dlp', path: binaryPath });
        }
        return binaryPath;
    } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: false, tool: 'yt-dlp', error: error.message });
        }
        throw error;
    }
}

export async function downloadFfmpeg(binDir) {
    const isWin = process.platform === 'win32';
    const isLinux = process.platform === 'linux';

    if ((!isWin && !isLinux) || arch !== 'x64') {
        throw new Error('FFmpeg auto-download is currently only supported for Windows x64 and Linux x64 platforms.');
    }

    const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const archiveName = isWin ? 'ffmpeg.zip' : 'ffmpeg.tar.xz';
    const binaryPath = path.join(binDir, exeName);
    const archivePath = path.join(binDir, archiveName);

    const downloadUrl = isWin
        ? 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-7.1.zip'
        : 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz';

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-started', { file: 'FFmpeg' });
    }
    console.log(`[FFmpeg Downloader] Downloading from: ${downloadUrl}`);

    try {
        await downloadFileWithProgress(downloadUrl, archivePath, 'FFmpeg');

        console.log('[FFmpeg Downloader] Download complete, extracting...');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', { file: 'FFmpeg', progress: -1, status: 'Extracting...' });
        }

        if (isWin) {
            const zip = new AdmZip(archivePath);
            const ffmpegEntry = zip.getEntries().find(entry =>
                entry.entryName.endsWith('ffmpeg.exe') && !entry.isDirectory
            );

            if (!ffmpegEntry) {
                throw new Error('ffmpeg.exe not found in downloaded archive.');
            }

            fs.writeFileSync(binaryPath, ffmpegEntry.getData());
            fs.unlinkSync(archivePath);

        } else if (isLinux) {
            const tempExtractDir = path.join(binDir, `ffmpeg_temp_${Date.now()}`);
            if (!fs.existsSync(tempExtractDir)) {
                fs.mkdirSync(tempExtractDir, { recursive: true });
            }

            await execAsync(`tar -xf "${archivePath}" -C "${tempExtractDir}"`);

            let foundFfmpegPath = null;
            const findFfmpeg = (dir) => {
                const files = fs.readdirSync(dir, { withFileTypes: true });
                for (const file of files) {
                    const fullPath = path.join(dir, file.name);
                    if (file.isDirectory()) {
                        findFfmpeg(fullPath);
                    } else if (file.name === 'ffmpeg') {
                        foundFfmpegPath = fullPath;
                    }
                }
            };
            findFfmpeg(tempExtractDir);

            if (!foundFfmpegPath) {
                throw new Error('ffmpeg executable not found in downloaded archive.');
            }

            fs.copyFileSync(foundFfmpegPath, binaryPath);
            fs.chmodSync(binaryPath, '755');

            fs.rmSync(tempExtractDir, { recursive: true, force: true });
            fs.unlinkSync(archivePath);
        }

        console.log(`[FFmpeg Downloader] Extraction successful, ffmpeg saved to: ${binaryPath}`);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: true, tool: 'ffmpeg', path: binaryPath });
        }
        return binaryPath;
    } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-finished', { success: false, tool: 'ffmpeg', error: error.message });
        }
        throw error;
    }
}

export async function initializeApp(app, mainWin) {
    mainWindow = mainWin;
    console.log('[Setup] Electron App instance ready, initializing...');
    const userDataPath = app.getPath('userData');
    const binDir = path.join(userDataPath, 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    console.log(`[Setup] UserData Path: ${userDataPath}`);
    console.log(`[Setup] Binary directory: ${binDir}`);

    const userConfigPath = path.join(userDataPath, 'user-config.json');
    let mediaRootPath = path.join(userDataPath, 'media');
    try {
        if (fs.existsSync(userConfigPath)) {
            const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
            if (userConfig.mediaRoot) {
                mediaRootPath = userConfig.mediaRoot;
            }
        }
    } catch (e) {
        console.error('[Setup] Failed to read user-config.json:', e);
    }

    const config = {
        MEDIA_ROOT: mediaRootPath,
        VIDEOS_DIR: path.join(mediaRootPath, 'videos'),
        ALBUMART_DIR: path.join(mediaRootPath, 'albumart'),
        MUSIC_DIR: path.join(mediaRootPath, 'music'),
        PLAYLIST_PATH: path.join(mediaRootPath, 'playlist.json'),
        BIN_DIR: binDir,
        USER_CONFIG_PATH: userConfigPath 
    };

    [config.VIDEOS_DIR, config.ALBUMART_DIR, config.MUSIC_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    const systemProxy = await detectSystemProxy();
    console.log(`[Setup] - System Proxy: ${systemProxy || 'None'}`);

    console.log('[Setup] Core components initialization deferred to EnvChecker.');

    return {
        config,
        ffmpegPath: null,
        ytDlpPath: null,
        systemProxy,
        shouldContinue: true,
    };
}