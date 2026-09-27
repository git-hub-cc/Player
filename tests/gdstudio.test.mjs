import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { generateSignature, encodeParameter } from '../src/backend/providers/gdstudio-signature.js';
import { getMusicUrl } from '../src/backend/providers/gdstudio.js';

// 固定期望值取自 music.gdstudio.org.har，不依赖 HAR 文件或网络运行。
const hostname = 'music.gdstudio.org';
const track = { id: '30612793', source: 'netease', title: 'HAR sample' };
const vectors = [
    ['search', '邓紫棋', 1790536027000, 'CD0EEAEE'],
    ['url', '30612793', 1790536036000, '6A029774'],
    ['pic', '1364493930777368', 1790536038000, '5179F283'],
    ['lyric', '30612793', 1790536038000, '6A029774'],
];
for (const [type, term, time, expected] of vectors) {
    test(`HAR ${type} signature`, () => {
        assert.equal(generateSignature(hostname, term, time), expected);
    });
}

test('encoding matches website for Chinese, spaces, punctuation and percent signs', () => {
    assert.equal(encodeParameter("中 文!'()*+%/"), '%E4%B8%AD%20%E6%96%87%21%27%28%29%2A%2B%25%2F');
});

function intercept(t, handler) {
    const original = axios.defaults.adapter;
    const calls = [];
    axios.defaults.adapter = async config => {
        calls.push(config);
        return {
            data: await handler(config, calls.length), status: 200, statusText: 'OK',
            headers: {}, config,
        };
    };
    t.after(() => { axios.defaults.adapter = original; });
    return calls;
}

test('requests time then a signed GET with the captured parameters', async t => {
    const calls = intercept(t, (_, n) => n === 1 ? '1790536036' : { url: 'https://example.com/song.mp3' });
    assert.equal(await getMusicUrl(track, null, 320), 'https://example.com/song.mp3');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, `https://${hostname}/time`);
    assert.equal(calls[1].url, `https://${hostname}/api.php?types=url&id=30612793&source=netease&br=320&s=6A029774`);
    for (const call of calls) {
        assert.equal(call.method, 'get');
        assert.equal(call.proxy, false);
        assert.equal(call.data, undefined);
        assert.equal(call.headers.Referer, `https://${hostname}/`);
    }
});

test('both requests use the configured proxy and default quality stays 999', async t => {
    const calls = intercept(t, (_, n) => n === 1 ? '1790536036' : { url: 'http://example.com/song.flac' });
    assert.equal(await getMusicUrl(track, 'http://127.0.0.1:7892'), 'https://example.com/song.flac');
    calls.forEach(call => assert.deepEqual(call.proxy, { host: '127.0.0.1', port: 7892, protocol: 'http' }));
    assert.equal(new URL(calls[1].url).searchParams.get('br'), '999');
});

test('refreshes server time across the ten-second signature boundary', async t => {
    const calls = intercept(t, (_, n) => n % 2 === 0 ? { url: 'https://example.com/song.mp3' }
        : n === 1 ? '1790536039' : '1790536040');
    await getMusicUrl(track);
    await getMusicUrl(track);
    assert.equal(calls.length, 4);
    assert.notEqual(new URL(calls[1].url).searchParams.get('s'), new URL(calls[3].url).searchParams.get('s'));
});

for (const failure of ['timeout', 'invalid']) {
    test(`falls back to local time after ${failure}, then retries the time endpoint`, async t => {
        t.mock.method(Date, 'now', () => 1790536036000);
        t.mock.method(console, 'warn', () => {});
        const calls = intercept(t, (_, n) => {
            if (n === 1) {
                if (failure === 'timeout') throw new Error('timeout');
                return '<html>unavailable</html>';
            }
            return n === 3 ? '1790536040' : { url: 'https://example.com/song.mp3' };
        });
        await getMusicUrl(track);
        await getMusicUrl(track);
        assert.equal(new URL(calls[1].url).searchParams.get('s'), '6A029774');
        assert.equal(calls[2].url, `https://${hostname}/time`);
        assert.notEqual(new URL(calls[3].url).searchParams.get('s'), '6A029774');
    });
}

test('request values are encoded once, with the same encoding used for signing', async t => {
    const id = "中文 /!'()*+%";
    const calls = intercept(t, (_, n) => n === 1 ? '1790536036' : { url: 'https://example.com/song.mp3' });
    await getMusicUrl({ ...track, id });
    const url = new URL(calls[1].url);
    assert.equal(url.searchParams.get('id'), id);
    assert.ok(calls[1].url.includes(`id=${encodeParameter(id)}&`));
    assert.equal(url.searchParams.get('s'), generateSignature(hostname, id, 1790536036000));
});

test('retains JSONP response support', async t => {
    intercept(t, (_, n) => n === 1 ? '1790536036' : 'jQuery123({"url":"https://example.com/song.mp3"});');
    assert.equal(await getMusicUrl(track), 'https://example.com/song.mp3');
});

test('rejects empty URLs and propagates API failures', async t => {
    t.mock.method(console, 'error', () => {});
    intercept(t, (_, n) => {
        if (n % 2) return '1790536036';
        if (n === 2) return { url: '' };
        throw new Error('HTTP 401');
    });
    await assert.rejects(getMusicUrl(track), /API/);
    await assert.rejects(getMusicUrl(track), /HTTP 401/);
});

test('rejects missing track information before making requests', async t => {
    const calls = intercept(t, () => { throw new Error('unexpected request'); });
    await assert.rejects(getMusicUrl(null));
    await assert.rejects(getMusicUrl({ id: '30612793' }));
    assert.equal(calls.length, 0);
});
