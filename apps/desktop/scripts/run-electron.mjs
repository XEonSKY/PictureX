#!/usr/bin/env node
/**
 * Electron 启动包装：Electron 45 在首次运行时才下载二进制，
 * 这里统一设置镜像，避免直连 GitHub。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';

const require = createRequire(import.meta.url);
const cli = require.resolve('electron/cli.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code) => {
    process.exit(code ?? 1);
});
child.on('error', (error) => {
    process.stderr.write(`[desktop] Electron 启动失败: ${error.message}\n`);
    process.exit(1);
});
