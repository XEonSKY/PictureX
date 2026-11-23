#!/usr/bin/env node
/**
 * 确保 ffmpeg-static 的二进制存在。
 *
 * ffmpeg-static 的 install 脚本直连 GitHub Releases，在国内网络下经常失败，
 * 因此 pnpm-workspace.yaml 不再白名单它的构建脚本，改由本脚本从 npmmirror 下载。
 * 下载失败只告警：ffmpeg 只影响视频缩略图/元数据，应用其余功能不受影响。
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);

const RELEASE = 'b6.1.1';
const MIRROR = process.env.FFMPEG_BINARIES_URL
    ?? 'https://registry.npmmirror.com/-/binary/ffmpeg-static';

function resolveBinaryPath() {
    try {
        return require('ffmpeg-static');
    }
    catch {
        return null;
    }
}

const binaryPath = resolveBinaryPath();

if (!binaryPath) {
    process.stdout.write('[ffmpeg] 未安装 ffmpeg-static，跳过\n');
    process.exit(0);
}

// 静态构建的 ffmpeg 通常 > 20MB；体积明显偏小说明之前的下载被截断
const MIN_BINARY_BYTES = 20 * 1024 * 1024;

function isUsableBinary(file) {
    try {
        return statSync(file).size >= MIN_BINARY_BYTES;
    }
    catch {
        return false;
    }
}

if (existsSync(binaryPath) && isUsableBinary(binaryPath)) {
    process.stdout.write('[ffmpeg] 已就绪\n');
    process.exit(0);
}

if (existsSync(binaryPath)) {
    process.stderr.write('[ffmpeg] 现有二进制体积异常，重新下载\n');
    rmSync(binaryPath, { force: true });
}

const platform = process.env.npm_config_platform ?? process.platform;
const arch = process.env.npm_config_arch ?? process.arch;
const fileName = `ffmpeg-${platform}-${arch}.gz`;
const url = `${MIRROR}/${RELEASE}/${fileName}`;
const tempPath = `${binaryPath}.download`;

mkdirSync(dirname(binaryPath), { recursive: true });

try {
    process.stdout.write(`[ffmpeg] 下载 ${url}\n`);

    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
    }

    await pipeline(
        Readable.fromWeb(response.body),
        createGunzip(),
        createWriteStream(tempPath),
    );

    rmSync(binaryPath, { force: true });
    const { renameSync } = await import('node:fs');
    renameSync(tempPath, binaryPath);
    process.stdout.write('[ffmpeg] 下载完成\n');
}
catch (error) {
    rmSync(tempPath, { force: true });
    process.stderr.write(`[ffmpeg] 自动下载失败（${error instanceof Error ? error.message : String(error)}），可在设置中关闭 ffmpeg 或手动放置二进制\n`);
}
