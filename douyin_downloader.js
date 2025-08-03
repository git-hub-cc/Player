// douyin_downloader.js
const playwright = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');

// ==============================================================================
// 1. 拦截API响应函数
// ==============================================================================
async function interceptDouyinApiResponse(textBlob) {
    console.log("正在初始化浏览器和页面...");

    const match = textBlob.match(/https?:\/\/[^\s]+/);
    if (!match) {
        console.error("错误：未在文本中找到URL。");
        return { apiResponseJson: null, finalUrl: null };
    }
    const startUrl = match[0];
    console.log(`步骤 1: 成功提取到初始URL -> ${startUrl}`);

    const targetApiUrl = "aweme/v1/web/aweme/detail/";
    let apiResponseJson = null;
    let finalUrl = null;

    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    console.log("步骤 2: 浏览器已启动，准备开始拦截网络请求。");

    page.on('response', async (response) => {
        if (response.url().includes(targetApiUrl) && response.status() === 200) {
            console.log(`--- 拦截成功！---\n捕获到目标API请求: ${response.url()}`);
            try {
                apiResponseJson = await response.json();
                console.log("成功解析响应内容为JSON。\n-----------------");
            } catch (e) {
                console.error(`解析响应为JSON时出错: ${e}`);
            }
        }
    });

    try {
        console.log(`步骤 3: 正在导航到初始URL -> ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        finalUrl = page.url();
        console.log(`步骤 4: 页面加载完成，最终URL为 -> ${finalUrl}`);
    } catch (error) {
        if (error instanceof playwright.errors.TimeoutError) {
            console.warn("页面加载超时。但可能目标API已经加载，继续检查结果。");
            finalUrl = page.url();
        } else {
            console.error(`导航或页面加载过程中发生错误: ${error}`);
        }
    } finally {
        await browser.close();
    }

    if (apiResponseJson) {
        console.log("步骤 5: 成功获取API响应。");
        return { apiResponseJson, finalUrl };
    } else {
        console.log("\n错误：未能成功拦截到目标API的有效响应。");
        return { apiResponseJson: null, finalUrl: null };
    }
}


// ==============================================================================
// 2. 通用文件下载函数
// ==============================================================================
async function downloadFile(url, folder, fileName, description) {
    if (!url || !folder || !fileName) {
        console.error(`[下载模块] 错误：缺少下载所需的参数 (URL: ${url}, FileName: ${fileName})`);
        return;
    }

    console.log(`\n[下载模块] 准备下载 ${description}, URL: ${url}`);

    if (!fs.existsSync(folder)) {
        console.log(`[下载模块] 文件夹 '${folder}' 不存在，正在创建...`);
        fs.mkdirSync(folder, { recursive: true });
    }

    const filePath = path.join(folder, fileName);

    if (fs.existsSync(filePath)) {
        console.log(`[下载模块] 文件 '${filePath}' 已存在，跳过下载。`);
        return;
    }

    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
            },
            timeout: 60000,
        });

        const totalLength = response.headers['content-length'];
        const writer = fs.createWriteStream(filePath);

        const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progressBar.start(Number(totalLength) || 0, 0, {
            description: description
        });

        response.data.on('data', (chunk) => progressBar.increment(chunk.length));
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                progressBar.stop();
                console.log(`\n[下载模块] 下载成功！已保存至: ${filePath}`);
                resolve();
            });
            writer.on('error', (err) => {
                progressBar.stop();
                console.error(`\n[下载模块] 写入文件时发生错误: ${err}`);
                fs.unlink(filePath, () => {});
                reject(err);
            });
        });

    } catch (e) {
        console.error(`\n[下载模块] 下载文件时发生错误: ${e.message}`);
    }
}


// ==============================================================================
// --- 主程序入口 ---
// ==============================================================================
(async () => {
    const inputString = process.argv[2];

    if (!inputString) {
        console.error("错误：没有提供抖音分享文本作为命令行参数。");
        process.exit(1);
    }

    console.log(`[Downloader] 开始处理: ${inputString}`);

    const result = await interceptDouyinApiResponse(inputString);

    if (!result) {
        console.error("[Downloader] 错误: interceptDouyinApiResponse 返回了 undefined，这是一个严重的内部错误。");
        return;
    }

    const { apiResponseJson, finalUrl } = result;

    if (apiResponseJson) {
        const awemeDetail = apiResponseJson?.aweme_detail;
        if (awemeDetail) {
            console.log("\n--- [Downloader] 关键信息提取 ---");
            const desc = awemeDetail?.desc;
            const authorNickname = awemeDetail?.author?.nickname;
            const videoUri = awemeDetail?.video?.play_addr?.uri;
            const awemeId = awemeDetail?.aweme_id;
            const staticCoverUrl = awemeDetail?.video?.cover?.url_list?.[0];

            console.log(`视频标题: ${desc}`);
            console.log(`作者昵称: ${authorNickname}`);
            console.log(`aweme_id: ${awemeId || '未找到'}`);

            if (awemeId) {
                const downloadPromises = [];
                if (videoUri) {
                    const videoUrl = `https://www.douyin.com/aweme/v1/play/?video_id=${videoUri}`;
                    downloadPromises.push(downloadFile(
                        videoUrl,
                        'videos',
                        `${awemeId}.mp4`,
                        `下载 ${awemeId}.mp4`
                    ));
                }

                if (staticCoverUrl) {
                    downloadPromises.push(downloadFile(
                        staticCoverUrl,
                        'albumArt',
                        `${awemeId}.jpg`,
                        `下载 ${awemeId}.jpg`
                    ));
                }

                // 【修改】等待所有下载完成后，输出JSON数据
                await Promise.all(downloadPromises);
                console.log('---JSON_DATA_START---');
                console.log(JSON.stringify(apiResponseJson));
                console.log('---JSON_DATA_END---');

            } else {
                console.error("[Downloader] 错误: 未能从API响应中提取到 aweme_id，无法下载。");
            }
        }
    } else {
        console.error("[Downloader] 错误: interceptDouyinApiResponse 未能返回有效的API数据。");
    }
})();