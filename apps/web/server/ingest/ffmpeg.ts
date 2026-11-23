import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Settings } from '../settings/setting-schema';
import { isAllowedFfmpegPath } from './ffmpeg-path';

/**
 * ffmpeg-static / ffprobe-static 的路径用 require 动态解析：
 * 打包后二进制路径随平台变化，静态 import 会被 bundler 误处理。
 *
 * 不能在模块顶层调用 createRequire(import.meta.url)：Nitro 产物会把它替换成
 * `globalThis._importMeta_.url`，而 ESM 依赖先于入口执行，此时仍是
 * `file:///_entry.js` 占位地址。这里延迟到真正解析路径时再创建 require，
 * 并优先使用启动器写入的 PX_SERVER_ROOT。
 */
let packageRequire: NodeRequire | null = null;

function resolvePackageRequire(): NodeRequire {
    const serverRoot = process.env.PX_SERVER_ROOT?.trim();

    if (serverRoot) {
        return createRequire(join(serverRoot, 'index.mjs'));
    }

    const metaUrl = (globalThis as { _importMeta_?: { url?: string } })._importMeta_?.url;

    if (typeof metaUrl === 'string' && metaUrl !== '' && metaUrl !== 'file:///_entry.js') {
        return createRequire(metaUrl);
    }

    // 直接 node server/index.mjs 或测试环境：从入口/工作目录向上找 node_modules
    const entry = process.argv[1];
    const base = entry ? join(dirname(entry), 'index.mjs') : join(process.cwd(), 'index.mjs');

    return createRequire(base);
}

function getPackageRequire(): NodeRequire {
    packageRequire ??= resolvePackageRequire();

    return packageRequire;
}

function autoFfmpegPath(): string | null {
    try {
        const value: unknown = getPackageRequire()('ffmpeg-static');

        return typeof value === 'string' && existsSync(value) ? value : null;
    }
    catch {
        return null;
    }
}

export function resolveFfmpegPath(settings: Settings): string | null {
    if (!settings.ffmpeg.enabled) {
        return null;
    }

    const configured = settings.ffmpeg.path?.trim();

    if (configured && configured !== 'auto') {
        // 双重防线：即便 setting.json 被绕过校验写成任意路径，也绝不 spawn 非白名单可执行文件
        return isAllowedFfmpegPath(configured) && existsSync(configured) ? configured : null;
    }

    return autoFfmpegPath();
}

export function resolveFfprobePath(settings: Settings): string | null {
    if (!settings.ffmpeg.enabled) {
        return null;
    }

    try {
        const value: unknown = getPackageRequire()('ffprobe-static');
        const path = value && typeof value === 'object' && 'path' in value
            ? (value as { path?: unknown }).path
            : undefined;

        return typeof path === 'string' && existsSync(path) ? path : null;
    }
    catch {
        return null;
    }
}
