#!/usr/bin/env node
/**
 * 清理可再生的构建产物与缓存。
 * 默认保留 .dev/data（本地测试数据）；`--with-dev-data` 才连同开发数据一起清空。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const withDevData = process.argv.includes('--with-dev-data');

const targets = [
    'dist',
    'coverage',
    'apps/web/coverage',
    '.nuxt',
    '.nitro',
    '.cache',
    'apps/web/.nuxt',
    'apps/web/.nitro',
    'apps/web/.cache',
    'docs/.vitepress/cache',
    'docs/.vitepress/dist',
    'apps/desktop/out',
    'apps/desktop/runtime',
    '.dev/nuxt',
];

if (withDevData) {
    targets.push('.dev/data');
}

let removed = 0;

for (const target of targets) {
    const path = resolve(ROOT, target);

    if (path !== ROOT && !path.startsWith(`${ROOT}${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`拒绝删除仓库之外的路径: ${path}`);
    }
    if (!existsSync(path)) {
        continue;
    }

    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed += 1;
    process.stdout.write(`[clean] removed ${target}\n`);
}

process.stdout.write(removed === 0 ? '[clean] nothing to remove\n' : `[clean] done (${removed} targets)\n`);
