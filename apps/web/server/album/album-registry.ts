import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { ApiError } from '../hono/problem';
import type { Settings } from '../settings/setting-schema';
import { readJsonFileState, writeJsonAtomic } from '../utils/atomic-json';

/**
 * 相册登记表 `<albumsRoot>/.albums.json`：PictureX 认哪些相册的唯一事实源。
 *
 * - 只认登记表：磁盘上新建/移入的目录要用「关联已有相册」才会出现；
 *   解除关联只删登记、不碰磁盘文件，因此也不会被重新发现。
 */

export interface AlbumEntry {
    id: string
    dir: string
    name: string
    registeredAt: string
}

interface RegistryFile {
    schemaVersion: number
    albums: AlbumEntry[]
}

interface ParsedRegistryFile {
    schemaVersion?: number
    albums?: unknown
}

function registryPath(settings: Settings): string {
    return join(settings.albumsRoot, '.albums.json');
}

function isEntry(value: unknown): value is AlbumEntry {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const entry = value as Partial<AlbumEntry>;

    return typeof entry.id === 'string'
      && typeof entry.dir === 'string'
      && typeof entry.name === 'string'
      && typeof entry.registeredAt === 'string';
}

type RegistryState
    = | { state: 'ok', file: RegistryFile }
      | { state: 'missing' }
      | { state: 'corrupt' };

interface RegistryCacheEntry {
    mtimeMs: number
    size: number
    albums: AlbumEntry[]
}

/**
 * 登记表按 mtime + size 缓存：每个资产请求都会走 findRegisteredAlbum → listRegisteredAlbums，
 * 没有缓存就多一次 readFileSync + JSON.parse（`index.json` 早有同类缓存，登记表却漏了）。
 * persist 是唯一写入点，写完即失效，改 albumsRoot 的旧登记合并逻辑也因此安全。
 */
const registryCache = new Map<string, RegistryCacheEntry>();

function registryCorrupt(): ApiError {
    return new ApiError(
        500,
        'album_registry_corrupt',
        'The album registry file is corrupt. Repair or remove .albums.json before continuing.',
    );
}

function readRegistryFile(settings: Settings): RegistryState {
    const path = registryPath(settings);
    let stat: ReturnType<typeof statSync>;

    try {
        stat = statSync(path);
    }
    catch {
        registryCache.delete(path);

        return { state: 'missing' };
    }

    const cached = registryCache.get(path);

    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { state: 'ok', file: { schemaVersion: 2, albums: cached.albums } };
    }

    const result = readJsonFileState<ParsedRegistryFile>(path);

    if (result.state !== 'ok') {
        registryCache.delete(path);

        return result;
    }

    const raw = result.value;

    if (!raw || typeof raw !== 'object') {
        registryCache.delete(path);

        return { state: 'corrupt' };
    }

    if (raw.schemaVersion === 2 && Array.isArray(raw.albums)) {
        const albums = raw.albums.filter(isEntry);

        registryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, albums });

        return { state: 'ok', file: { schemaVersion: 2, albums } };
    }

    registryCache.delete(path);

    return { state: 'corrupt' };
}

function persist(settings: Settings, albums: AlbumEntry[]): void {
    // 损坏的登记表禁止覆盖：否则解除关联的相册会被重新扫描并写回
    if (readJsonFileState(registryPath(settings)).state === 'corrupt') {
        throw registryCorrupt();
    }

    mkdirSync(settings.albumsRoot, { recursive: true });
    writeJsonAtomic(registryPath(settings), { schemaVersion: 2, albums } satisfies RegistryFile);
    registryCache.delete(registryPath(settings));
}

export function listRegisteredAlbums(settings: Settings): AlbumEntry[] {
    const file = readRegistryFile(settings);

    if (file.state === 'corrupt') {
        throw registryCorrupt();
    }

    return file.state === 'ok' ? file.file.albums : [];
}

export function findRegisteredAlbum(settings: Settings, id: string): AlbumEntry | undefined {
    return listRegisteredAlbums(settings).find(entry => entry.id === id);
}

export function registerAlbum(settings: Settings, entry: AlbumEntry): void {
    const others = listRegisteredAlbums(settings).filter(item => item.id !== entry.id);

    persist(settings, [entry, ...others]);
}

/** 整体替换登记表：用于改 albumsRoot 时把旧登记迁移到新位置 */
export function replaceRegisteredAlbums(settings: Settings, entries: AlbumEntry[]): void {
    persist(settings, entries);
}

/** 只删登记，磁盘目录保持原样 */
export function unregisterAlbum(settings: Settings, id: string): void {
    const albums = listRegisteredAlbums(settings);

    if (!albums.some(entry => entry.id === id)) {
        return;
    }

    persist(settings, albums.filter(entry => entry.id !== id));
}

/** 相册目录必须是绝对路径；统一分隔符并去掉末尾斜杠 */
export function normalizeAlbumPath(raw: string): string {
    const trimmed = raw.trim();

    if (trimmed === '' || !isAbsolute(trimmed)) {
        throw new ApiError(
            422,
            'album_path_invalid',
            'The album directory must be an absolute path.',
        );
    }

    return normalize(trimmed).replace(/[\\/]+$/u, '');
}
