import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    listRegisteredAlbums,
    replaceRegisteredAlbums,
    type AlbumEntry,
} from '../album/album-registry';
import { logger } from '../logger';
import { readJsonFileSafe, writeJsonAtomic } from '../utils/atomic-json';
import { describeDataDirectories, type DataDirectories } from '../utils/data-dir';
import { parseSettings, type Settings, type SettingsPatch } from './setting-schema';

/**
 * 全局设置（唯一持久化点 <dataDir>/setting.json）。
 * - 启动时 Zod 校验，缺失补默认并原子回写。
 * - 内存缓存，PATCH 时整文件原子写。
 * - albumsRoot / modelsRoot 为空时落到 dataDir 下的默认目录。
 */

interface CacheEntry {
    dataDir: string
    settings: Settings
}

const cache = new Map<string, CacheEntry>();

function resolveDirectories(directories?: DataDirectories): DataDirectories {
    return directories ?? describeDataDirectories();
}

function applyDerivedPaths(settings: Settings, directories: DataDirectories): Settings {
    const next = structuredClone(settings);

    if (!next.albumsRoot.trim()) {
        next.albumsRoot = directories.albumsRoot;
    }
    if (!next.modelsRoot.trim()) {
        next.modelsRoot = directories.modelsRoot;
    }

    return next;
}

function ensureSettingsDirectories(settings: Settings, directories: DataDirectories): void {
    for (const directory of [directories.dataDir, settings.albumsRoot, settings.modelsRoot]) {
        mkdirSync(directory, { recursive: true });
    }
}

export function loadSettings(directories?: DataDirectories): Settings {
    const dirs = resolveDirectories(directories);
    const cached = cache.get(dirs.dataDir);

    if (cached) {
        return cached.settings;
    }

    const raw = readJsonFileSafe<unknown>(join(dirs.dataDir, 'setting.json'));
    const settings = applyDerivedPaths(parseSettings(raw), dirs);

    ensureSettingsDirectories(settings, dirs);

    // 首次启动、版本升级、字段补齐或损坏恢复都以原子写回落到磁盘
    writeJsonAtomic(join(dirs.dataDir, 'setting.json'), settings);
    cache.set(dirs.dataDir, { dataDir: dirs.dataDir, settings });

    return settings;
}

export function getSettings(directories?: DataDirectories): Settings {
    return loadSettings(directories);
}

/** 改 albumsRoot 时把旧登记表合并进新位置，避免外部路径相册从列表“消失” */
function migrateAlbumRegistry(current: Settings, next: Settings): void {
    if (current.albumsRoot === next.albumsRoot) {
        return;
    }

    try {
        const merged: AlbumEntry[] = [...listRegisteredAlbums(next)];

        for (const entry of listRegisteredAlbums(current)) {
            if (!merged.some(item => item.id === entry.id || item.dir === entry.dir)) {
                merged.push(entry);
            }
        }

        replaceRegisteredAlbums(next, merged);
    }
    catch (error) {
        logger.warn({ err: error, from: current.albumsRoot, to: next.albumsRoot }, 'failed to migrate album registry');
    }
}

export function updateSettings(patch: SettingsPatch, directories?: DataDirectories): Settings {
    const dirs = resolveDirectories(directories);
    const current = getSettings(dirs);
    const next = applyDerivedPaths(parseSettings(mergePatch(current, patch)), dirs);

    ensureSettingsDirectories(next, dirs);
    migrateAlbumRegistry(current, next);
    writeJsonAtomic(join(dirs.dataDir, 'setting.json'), next);
    cache.set(dirs.dataDir, { dataDir: dirs.dataDir, settings: next });

    logger.debug({ keys: Object.keys(patch) }, 'settings updated');

    return next;
}

export function resetSettingsCache(): void {
    cache.clear();
}

function mergePatch(current: Settings, patch: SettingsPatch): Settings {
    const result: Settings = structuredClone(current);

    mergeInto(result, patch as Record<string, unknown>);

    return result;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) {
            continue;
        }

        const current = target[key];

        if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && current
            && typeof current === 'object'
            && !Array.isArray(current)
        ) {
            mergeInto(current as Record<string, unknown>, value as Record<string, unknown>);
        }
        else {
            target[key] = value;
        }
    }
}
