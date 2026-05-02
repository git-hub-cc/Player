import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const ENV_MANIFEST = {
    "dependencies": [
        {
            "id": "ffmpeg",
            "executable": "ffmpeg",
            "versionCommand": "-version",
            "versionRegex": "ffmpeg version (\\d+\\.\\d+)",
            "minVersion": "4.0",
            "scoopName": "ffmpeg"
        },
        {
            "id": "yt-dlp",
            "executable": "yt-dlp",
            "versionCommand": "--version",
            "versionRegex": "(\\d{4}\\.\\d{2}\\.\\d{2})",
            "minVersion": "2023.01.01",
            "scoopName": "yt-dlp"
        }
    ]
};

export class EnvChecker {
    constructor(sendMessage, binDir) {
        this.sendMessage = sendMessage;
        this.binDir = binDir;
    }

    async findExecutable(executableName) {
        console.log(`[EnvChecker] findExecutable starting for: ${executableName}`);
        const isWin = process.platform === 'win32';
        const exactName = isWin ? `${executableName}.exe` : executableName;

        if (this.binDir) {
            const localPath = path.join(this.binDir, exactName);
            if (fs.existsSync(localPath)) {
                console.log(`[EnvChecker] Found in local bin: ${localPath}`);
                return localPath;
            }
        }

        try {
            const cmd = isWin ? `where ${exactName}` : `which ${exactName}`;
            console.log(`[EnvChecker] Executing command: ${cmd}`);
            const { stdout } = await execAsync(cmd);
            const globalPaths = stdout.split(/\r?\n/).filter(p => p.trim() !== '');
            for (const p of globalPaths) {
                if (fs.existsSync(p)) {
                    console.log(`[EnvChecker] Found via where/which: ${p}`);
                    return p;
                }
            }
        } catch (e) {
            console.log(`[EnvChecker] where/which command failed or found nothing for ${exactName}.`);
        }

        if (isWin) {
            const scoopShimPath = path.join(os.homedir(), 'scoop', 'shims', exactName);
            if (fs.existsSync(scoopShimPath)) {
                console.log(`[EnvChecker] Found via scoop shim fallback: ${scoopShimPath}`);
                return scoopShimPath;
            }
        }

        const pathEnv = process.env.PATH || '';
        const pathSeparator = isWin ? ';' : ':';
        const paths = pathEnv.split(pathSeparator);

        for (let p of paths) {
            if (!p) continue;
            p = p.replace(/^"|"$/g, '');
            const fullPath = path.join(p, exactName);
            if (fs.existsSync(fullPath)) {
                console.log(`[EnvChecker] Found in PATH: ${fullPath}`);
                return fullPath;
            }
        }

        console.log(`[EnvChecker] Executable not found anywhere: ${executableName}`);
        return null;
    }

    async checkAndInstall() {
        const dependencies = ENV_MANIFEST.dependencies || [];
        let allReady = true;
        const validPaths = {};

        for (const dep of dependencies) {
            console.log(`[EnvChecker] ----------------------------------------`);
            console.log(`[EnvChecker] Checking dependency: ${dep.id}`);
            this.sendMessage('env-check-progress', { message: `正在检测系统组件: ${dep.id}...` });

            let exePath = await this.findExecutable(dep.executable);
            let isReady = false;

            if (exePath) {
                isReady = await this.verifyVersion(exePath, dep);
            }

            if (!isReady) {
                console.log(`[EnvChecker] Dependency ${dep.id} not ready. Missing or invalid version.`);
                if (process.platform === 'win32') {
                    this.sendMessage('env-check-progress', { message: `组件缺失或版本过低: ${dep.id}，尝试通过 Scoop 安装...` });
                    const installed = await this.installViaScoop(dep.scoopName);
                    if (!installed) {
                        console.error(`[EnvChecker] Scoop install failed for ${dep.id}.`);
                        this.sendMessage('env-error', { message: `组件 ${dep.id} 安装失败，相关功能可能无法正常运行。` });
                        allReady = false;
                    } else {
                        console.log(`[EnvChecker] Scoop install success for ${dep.id}. Re-evaluating path...`);
                        this.sendMessage('env-check-progress', { message: `组件 ${dep.id} 安装成功！` });
                        exePath = await this.findExecutable(dep.executable);
                        if (exePath) {
                            validPaths[dep.id] = exePath;
                            console.log(`[EnvChecker] Path verified after install: ${exePath}`);
                        } else {
                            console.error(`[EnvChecker] Path still not found after successful Scoop install for ${dep.id}.`);
                            allReady = false;
                        }
                    }
                } else {
                    console.log(`[EnvChecker] Non-Windows platform. Manual installation required for ${dep.id}.`);
                    this.sendMessage('env-error', { message: `组件 ${dep.id} 缺失，请手动安装后重试。` });
                    allReady = false;
                }
            } else {
                validPaths[dep.id] = exePath;
                console.log(`[EnvChecker] Dependency ${dep.id} is ready at: ${exePath}`);
                this.sendMessage('env-check-progress', { message: `组件 ${dep.id} 已就绪 (复用本地环境)。` });
            }
        }

        console.log(`[EnvChecker] checkAndInstall finished. allReady: ${allReady}, paths:`, validPaths);
        if (allReady) {
            this.sendMessage('env-ready', { message: '所有运行环境已就绪' });
        }
        return { allReady, paths: validPaths };
    }

    async verifyVersion(exePath, dep) {
        console.log(`[EnvChecker] verifyVersion starting for ${dep.id} at ${exePath}`);
        try {
            const { stdout } = await execAsync(`"${exePath}" ${dep.versionCommand}`);
            console.log(`[EnvChecker] Output of ${dep.id} version command:\n${stdout.substring(0, 150).trim()}...`);

            if (dep.versionRegex && dep.minVersion) {
                const match = stdout.match(new RegExp(dep.versionRegex));
                console.log(`[EnvChecker] Regex match result for ${dep.id}:`, match ? match[1] : 'No match');

                if (match && match[1]) {
                    const version = match[1];
                    const isOk = this.compareVersions(version, dep.minVersion) >= 0;
                    console.log(`[EnvChecker] Version check for ${dep.id}: extracted=${version}, required=${dep.minVersion}, result=${isOk}`);
                    return isOk;
                }
                console.warn(`[EnvChecker] Regex failed to match version for ${dep.id}. Regex: ${dep.versionRegex}`);
                return false;
            }
            console.log(`[EnvChecker] No version regex/minVersion required for ${dep.id}. Treating as valid.`);
            return true;
        } catch (error) {
            console.error(`[EnvChecker] Error verifying version for ${dep.id}:`, error.message);
            return false;
        }
    }

    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 > p2) return 1;
            if (p1 < p2) return -1;
        }
        return 0;
    }

    async installViaScoop(packageName) {
        try {
            console.log(`[EnvChecker] Executing scoop install ${packageName}`);
            await execAsync(`scoop install ${packageName}`);
            return true;
        } catch (error) {
            console.error(`[EnvChecker] Scoop 安装 ${packageName} 失败:`, error.message);
            try {
                console.log(`[EnvChecker] Executing scoop update ${packageName}`);
                await execAsync(`scoop update ${packageName}`);
                return true;
            } catch (updateError) {
                console.error(`[EnvChecker] Scoop update ${packageName} 失败:`, updateError.message);
                return false;
            }
        }
    }
}