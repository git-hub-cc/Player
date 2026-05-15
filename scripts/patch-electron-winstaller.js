const fs = require('fs');
const path = require('path');

const signPath = path.join(__dirname, '..', 'node_modules', 'electron-winstaller', 'lib', 'sign.js');

if (!fs.existsSync(signPath)) {
    console.warn('[patch-electron-winstaller] sign.js not found; skipping patch.');
    process.exit(0);
}

const source = fs.readFileSync(signPath, 'utf8');

if (source.includes("typeof BACKUP_SIGN_TOOL_PATH !== 'string'")) {
    console.log('[patch-electron-winstaller] already patched.');
    process.exit(0);
}

const target = /case 0:\r?\n\s+if \(!fs_extra_1\.default\.existsSync\(BACKUP_SIGN_TOOL_PATH\)\) return \[3 \/\*break\*\/, 3\];/;
const replacement = "case 0:\n                    if (typeof BACKUP_SIGN_TOOL_PATH !== 'string') return [2 /*return*/];\n                    if (!fs_extra_1.default.existsSync(BACKUP_SIGN_TOOL_PATH)) return [3 /*break*/, 3];";

if (!target.test(source)) {
    console.warn('[patch-electron-winstaller] target code not found; skipping patch.');
    process.exit(0);
}

fs.writeFileSync(signPath, source.replace(target, replacement));
console.log('[patch-electron-winstaller] patched resetSignTool for Node 24.');
