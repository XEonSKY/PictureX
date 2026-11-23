#!/usr/bin/env node
/**
 * electron-builder 包装：统一走国内镜像，避免 Electron 与 NSIS 资源直连 GitHub。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= 'false';

const require = createRequire(import.meta.url);
const cli = require.resolve('electron-builder/cli.js');
const args = [...process.argv.slice(2)];
const updateUrl = process.env.PX_UPDATE_URL?.trim();

// 有 PX_UPDATE_URL 时生成 latest.yml，供 electron-updater 的 generic feed 使用
if (updateUrl) {
    args.push('--config.publish.provider=generic', `--config.publish.url=${updateUrl}`);
}

// 原生构建时直接复用 node_modules/electron/dist，跳过下载/解压到临时目录。
// 解压出的 default_app.asar 常被杀软短暂占用，导致 EBUSY/EPERM；仅在目标平台与宿主一致时启用。
const hostPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const targetPlatform = args.includes('--win') ? 'win' : args.includes('--mac') ? 'mac' : args.includes('--linux') ? 'linux' : hostPlatform;
const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist');

if (targetPlatform === hostPlatform
    && existsSync(electronDist)
    && !args.some(argument => argument.includes('electronDist'))) {
    args.push(`--config.electronDist=${electronDist}`);
}

const child = spawn(process.execPath, [cli, ...args], {
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code) => {
    process.exit(code ?? 1);
});
child.on('error', (error) => {
    process.stderr.write(`[desktop] electron-builder 启动失败: ${error.message}\n`);
    process.exit(1);
});
