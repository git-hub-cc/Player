const { spawn, spawnSync } = require('node:child_process');

if (process.platform === 'win32') {
    spawnSync('chcp.com', ['65001'], { stdio: 'ignore' });
    process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || '1';
    process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || 'utf-8';
}

const forgeCli = require.resolve('@electron-forge/cli/dist/electron-forge.js');

const child = spawn(process.execPath, [forgeCli, 'start', ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
    env: process.env,
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 1);
});

child.on('error', (error) => {
    console.error(error);
    process.exit(1);
});
