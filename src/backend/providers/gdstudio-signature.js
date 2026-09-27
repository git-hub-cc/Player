// 对应 HAR 中 player.js / crc32.min.js 的 2026.09.25 协议。
export const MKPLAYER_VERSION = '2026.09.25';

const SHIFTS = [
    7, 12, 17, 22,
    5, 9, 14, 20,
    4, 11, 16, 23,
    6, 10, 15, 21,
];
const ROUND_CONSTANTS = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
// 网站的 md5 实现修改了第 30 轮常量；不可替换为 crypto.createHash('md5')。
ROUND_CONSTANTS[29] = 0xfcfea3f8;

function protocolDigest(input) {
    const bytes = Buffer.from(input, 'utf8');
    const padded = Buffer.alloc(Math.ceil((bytes.length + 9) / 64) * 64);
    bytes.copy(padded);
    padded[bytes.length] = 0x80;
    padded.writeBigUInt64LE(BigInt(bytes.length) * 8n, padded.length - 8);

    const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < padded.length; offset += 64) {
        let [a, b, c, d] = state;
        for (let i = 0; i < 64; i++) {
            let f, word;
            if (i < 16) {
                f = (b & c) | (~b & d);
                word = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                word = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                word = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                word = (7 * i) % 16;
            }
            const sum = (a + f + ROUND_CONSTANTS[i] + padded.readUInt32LE(offset + word * 4)) | 0;
            const shift = SHIFTS[Math.floor(i / 16) * 4 + i % 4];
            const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
            [a, b, c, d] = [d, next, b, c];
        }
        [a, b, c, d].forEach((value, i) => { state[i] = (state[i] + value) >>> 0; });
    }
    const digest = Buffer.alloc(16);
    state.forEach((value, i) => digest.writeUInt32LE(value, i * 4));
    return digest.toString('hex');
}

// 与网站 urlEncode 一致，额外编码 encodeURIComponent 保留的 !'()*。
export function encodeParameter(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function generateSignature(hostname, searchTerm, timestamp) {
    const timePrefix = String(Math.floor(timestamp)).slice(0, 9);
    const version = MKPLAYER_VERSION.split('.').map(part => part.padStart(2, '0')).join('');
    const input = `${timePrefix}|${hostname}|${version}|${encodeParameter(searchTerm)}`;
    return protocolDigest(input).slice(-8).toUpperCase();
}
