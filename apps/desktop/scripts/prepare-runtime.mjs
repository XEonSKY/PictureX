#!/usr/bin/env node
/**
 * 准备桌面端运行时目录 apps/desktop/runtime：
 *
 * 1. 复制 dist/package（Nitro 产物 + public + bin）
 * 2. 校验 better-sqlite3 13 自带的 Node-API 预编译，并裁剪掉其它平台二进制
 * 3. 补上 ffmpeg-static / ffprobe-static 二进制（只保留当前平台/架构）
 * 4. 写入 CJS bootstrap，供 utilityProcess 动态 import Nitro 的 ESM 入口
 *
 * better-sqlite3 13 改用 Node-API，预编译随 npm 包发布（prebuilds/<platform>-<arch>.node），
 * 不再需要按 Electron ABI 下载或重建。
 */
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const SOURCE = path.join(ROOT, 'dist', 'package');
const TARGET = path.join(DESKTOP, 'runtime');
const MARKER = path.join(TARGET, '.prepared.json');

const FORMAT_VERSION = 5;
const PLATFORM = process.platform;
const ARCH = process.arch;
const FORCE = process.argv.includes('--force');

function fail(message) {
    process.stderr.write(`[runtime] ${message}\n`);
    process.exit(1);
}

function sqlitePrebuildTarget() {
    if (PLATFORM === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime) {
        return `linuxmusl-${ARCH}`;
    }

    return `${PLATFORM}-${ARCH}`;
}

function sqlitePrebuildPath(packageRoot) {
    return path.join(packageRoot, 'prebuilds', `${sqlitePrebuildTarget()}.node`);
}

function ffmpegBinaryName() {
    return PLATFORM === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function ffprobeRelativePath() {
    return path.join('bin', PLATFORM, ARCH, PLATFORM === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

function isPrepared(sourceMtimeMs, electronVersion, ffmpegStat) {
    if (FORCE || !existsSync(MARKER)) {
        return false;
    }

    try {
        const marker = JSON.parse(readFileSync(MARKER, 'utf8'));

        return marker.formatVersion === FORMAT_VERSION
            && marker.sourceMtimeMs === sourceMtimeMs
            && marker.electronVersion === electronVersion
            && marker.platform === PLATFORM
            && marker.arch === ARCH
            && marker.ffmpegSize === ffmpegStat.size
            && marker.ffmpegMtimeMs === ffmpegStat.mtimeMs
            && existsSync(path.join(TARGET, 'server', 'bootstrap.cjs'))
            && existsSync(sqlitePrebuildPath(path.join(TARGET, 'server', 'node_modules', 'better-sqlite3')))
            && existsSync(path.join(TARGET, 'server', 'node_modules', 'ffmpeg-static', ffmpegBinaryName()))
            && existsSync(path.join(TARGET, 'server', 'node_modules', 'ffprobe-static', ffprobeRelativePath()));
    }
    catch {
        return false;
    }
}

function pruneSqlitePrebuilds(packageRoot) {
    const target = `${sqlitePrebuildTarget()}.node`;
    const prebuildDir = path.join(packageRoot, 'prebuilds');

    for (const file of readdirSync(prebuildDir)) {
        if (file.endsWith('.node') && file !== target) {
            rmSync(path.join(prebuildDir, file), { force: true });
        }
    }
}

function findPackage(name) {
    const candidates = [
        path.join(ROOT, 'node_modules', name),
        path.join(ROOT, 'apps', 'web', 'node_modules', name),
    ];
    const source = candidates.find(candidate => existsSync(candidate));

    if (source === undefined) {
        fail(`缺少 ${name}，请先在仓库根目录执行 pnpm install`);
    }

    return source;
}

function copyPackage(name) {
    const source = findPackage(name);
    const executable = name === 'ffmpeg-static' ? ffmpegBinaryName() : ffprobeRelativePath();
    const executablePath = path.join(source, executable);

    if (!existsSync(executablePath)) {
        fail(`${name} 缺少 ${executable}，请执行 node scripts/ensure-ffmpeg.mjs 补齐二进制`);
    }

    if (name === 'ffmpeg-static' && statSync(executablePath).size < 20 * 1024 * 1024) {
        fail(`ffmpeg 二进制体积异常（疑似下载截断），请删除 node_modules/ffmpeg-static/${ffmpegBinaryName()} 后执行 node scripts/ensure-ffmpeg.mjs`);
    }

    const destination = path.join(TARGET, 'server', 'node_modules', name);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });

    // ffprobe-static 默认带全平台二进制，只保留当前平台/架构
    if (name === 'ffprobe-static') {
        const bin = path.join(destination, 'bin');

        for (const platform of ['darwin', 'linux', 'win32']) {
            if (platform !== PLATFORM) {
                rmSync(path.join(bin, platform), { recursive: true, force: true });
                continue;
            }

            for (const arch of ['x64', 'arm64', 'ia32']) {
                if (arch !== ARCH) {
                    rmSync(path.join(bin, platform, arch), { recursive: true, force: true });
                }
            }
        }
    }

    if (PLATFORM !== 'win32') {
        chmodSync(path.join(destination, executable), 0o755);
    }
}

async function main() {
    if (!['win32', 'darwin', 'linux'].includes(PLATFORM) || !['x64', 'arm64'].includes(ARCH)) {
        fail(`不支持的桌面端平台: ${PLATFORM}-${ARCH}`);
    }

    if (!existsSync(path.join(SOURCE, 'server', 'index.mjs'))) {
        fail('缺少 dist/package/server/index.mjs，请先在仓库根目录执行 pnpm build:npm');
    }

    const desktopPackage = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
    const electronVersion = desktopPackage.devDependencies?.electron ?? '';

    if (!electronVersion.startsWith('45.')) {
        fail(`prepare-runtime 按 Electron 45 校验运行时，当前声明为 ${electronVersion}；升级时请同步版本断言。`);
    }

    const sourceMtimeMs = statSync(SOURCE).mtimeMs;
    const ffmpegBinary = path.join(findPackage('ffmpeg-static'), ffmpegBinaryName());

    if (!existsSync(ffmpegBinary)) {
        fail(`ffmpeg-static 缺少 ${ffmpegBinaryName()}，请执行 node scripts/ensure-ffmpeg.mjs 补齐`);
    }

    const ffmpegStat = statSync(ffmpegBinary);

    if (ffmpegStat.size < 20 * 1024 * 1024) {
        fail(`ffmpeg 二进制体积异常（疑似下载截断），请删除 node_modules/ffmpeg-static/${ffmpegBinaryName()} 后执行 node scripts/ensure-ffmpeg.mjs`);
    }

    if (isPrepared(sourceMtimeMs, electronVersion, ffmpegStat)) {
        process.stdout.write('[runtime] 已是最新，跳过\n');
        return;
    }

    process.stdout.write(`[runtime] 复制 ${SOURCE} -> ${TARGET} (${PLATFORM}-${ARCH})\n`);
    rmSync(TARGET, { recursive: true, force: true });
    cpSync(SOURCE, TARGET, { recursive: true });

    const sqliteRoot = path.join(TARGET, 'server', 'node_modules', 'better-sqlite3');
    const sqlitePackage = path.join(sqliteRoot, 'package.json');

    if (!existsSync(sqlitePackage)) {
        fail('运行时缺少 better-sqlite3，无法校验原生模块');
    }

    const sqliteVersion = JSON.parse(readFileSync(sqlitePackage, 'utf8')).version;
    const prebuild = sqlitePrebuildPath(sqliteRoot);

    if (!existsSync(prebuild)) {
        fail(`better-sqlite3 ${sqliteVersion} 缺少 ${sqlitePrebuildTarget()}.node 预编译，请确认安装完整`);
    }

    pruneSqlitePrebuilds(sqliteRoot);
    process.stdout.write(`[runtime] better-sqlite3 ${sqliteVersion} 使用 ${sqlitePrebuildTarget()}.node（Node-API）\n`);

    copyPackage('ffmpeg-static');
    copyPackage('ffprobe-static');

    writeFileSync(path.join(TARGET, 'server', 'bootstrap.cjs'), [
        "'use strict';",
        '',
        '// Nitro 产物是 ESM；用 CJS 包装入口，确保 utilityProcess 以动态 import 加载。',
        "const { pathToFileURL } = require('node:url');",
        "const { join } = require('node:path');",
        '',
        '// ESM 依赖先于入口执行，必须在 import 前写入真实 URL；',
        '// 否则 Nitro 顶层的 createRequire(globalThis._importMeta_.url) 会拿到 file:///_entry.js。',
        "const entry = pathToFileURL(join(__dirname, 'index.mjs')).href;",
        'process.env.PX_SERVER_ROOT = __dirname;',
        'globalThis._importMeta_ = { url: entry, env: process.env };',
        '',
        'import(entry).catch((error) => {',
        '    console.error(error);',
        '    process.exit(1);',
        '});',
        '',
    ].join('\n'));

    writeFileSync(MARKER, `${JSON.stringify({
        formatVersion: FORMAT_VERSION,
        sourceMtimeMs,
        electronVersion,
        platform: PLATFORM,
        arch: ARCH,
        betterSqlite3Version: sqliteVersion,
        ffmpegSize: ffmpegStat.size,
        ffmpegMtimeMs: ffmpegStat.mtimeMs,
        preparedAt: new Date().toISOString(),
    }, null, 4)}\n`);

    process.stdout.write('[runtime] 完成\n');
}

await main();
