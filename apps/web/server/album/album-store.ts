import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { albumDatabase, closeAlbumDatabase, removeAlbumThumbnailDatabase, type AlbumDbHandle } from '../database/album';
import { assets, assetTags } from '../database/schemas/album';
import { logger } from '../logger';
import { ApiError } from '../hono/problem';
import type { Settings } from '../settings/setting-schema';
import { readJsonFileState, writeJsonAtomic } from '../utils/atomic-json';
import { computeAlbumFacts, pruneOrphanDuplicates, pruneOrphanTagLinks } from './album-maintenance';
import {
    findRegisteredAlbum,
    listRegisteredAlbums,
    normalizeAlbumPath,
    registerAlbum,
    unregisterAlbum,
} from './album-registry';
import { isTagDatabaseCorrupt } from '../database/tags';
import { deleteAlbumAiJobs } from './ai-job-store';
import { deleteAlbumImportJobs } from './import-job-store';
import {
    createTagRecord,
    deleteAllTagRecords,
    deleteTagRecords,
    getTagRecord,
    importTagRecords,
    listTagRecords,
    recolorTagRecords,
    resolveMergeSources,
    tagIds,
    updateTagRecord,
} from '../tags/tag-store';
import type { TagRecord } from '../tags/types';

export type { TagRecord } from '../tags/types';

/**
 * 相册元数据与标签（index.json / tag.db）的唯一持久化入口。
 * 相册目录是自包含单元：index.json、storage/ 与 data/（picture.db、tag.db、pixiv.db）；
 * 缩略图库统一放在 <dataDir>/data/thumbnails.db，旧版 tag.json 只在首次打开 tag.db 时迁移一次。
 */

/** 相册级功能开关：null 表示跟随全局 setting.json */
export interface AlbumFeatureSettings {
    similarityThreshold: number | null
    autoTag: boolean | null
    /** 是否在详情页识别 Pixiv 文件名并拉取元数据 */
    pixivEnabled: boolean
    /** 发现同一作品缺少分P时自动下载入库 */
    pixivAutoDownload: boolean
}

export interface AlbumIndex {
    schemaVersion: number
    id: string
    name: string
    description: string
    coverAssetId: string | null
    assetCount: number
    createdAt: string
    updatedAt: string
    settings: AlbumFeatureSettings
}

export function defaultAlbumSettings(): AlbumFeatureSettings {
    return {
        similarityThreshold: null,
        autoTag: null,
        pixivEnabled: false,
        // 缺失分P默认不自动下载，由用户显式勾选或点击下载
        pixivAutoDownload: false,
    };
}

export interface AlbumContext {
    index: AlbumIndex
    dir: string
    db: AlbumDbHandle
}

/** 列表用：带上真实目录、目录是否还在，以及 index.json 是否损坏 */
export interface AlbumSummary extends AlbumIndex {
    dir: string
    missing: boolean
    corrupt: boolean
}

const ALBUM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_NAME_LENGTH = 120;

export function isValidAlbumId(id: string): boolean {
    return ALBUM_ID_PATTERN.test(id);
}

export function albumDirFor(settings: Settings, id: string): string {
    if (!isValidAlbumId(id)) {
        throw new ApiError(404, 'album_not_found', 'The requested album does not exist.');
    }

    const registered = findRegisteredAlbum(settings, id);

    if (!registered) {
        throw new ApiError(404, 'album_not_found', 'The requested album does not exist.');
    }

    return registered.dir;
}

function normalizeName(name: string): string {
    return name.trim().replace(/\s+/gu, ' ').slice(0, MAX_NAME_LENGTH);
}

interface IndexCacheEntry {
    mtimeMs: number
    size: number
    state: 'ok' | 'corrupt'
    index?: AlbumIndex
}

// 列表与详情每请求都会读 index.json；按 mtime + size 缓存，写入时立即失效
const indexCache = new Map<string, IndexCacheEntry>();

function normalizeIndex(raw: Partial<AlbumIndex>): AlbumIndex | null {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
        return null;
    }

    // 手写/迁移来的相册可能缺字段，读的时候补齐，避免后续排序或 UI 崩溃
    const rawSettings = raw.settings ?? defaultAlbumSettings();

    return {
        schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
        id: raw.id,
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description : '',
        coverAssetId: typeof raw.coverAssetId === 'string' ? raw.coverAssetId : null,
        assetCount: typeof raw.assetCount === 'number' ? raw.assetCount : 0,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        settings: {
            similarityThreshold: typeof rawSettings.similarityThreshold === 'number'
                ? rawSettings.similarityThreshold
                : null,
            autoTag: typeof rawSettings.autoTag === 'boolean' ? rawSettings.autoTag : null,
            pixivEnabled: rawSettings.pixivEnabled === true,
            pixivAutoDownload: rawSettings.pixivAutoDownload === true,
        },
    };
}

type IndexRead
    = | { state: 'ok', index: AlbumIndex }
      | { state: 'missing' }
      | { state: 'corrupt' };

function readIndexFileState(dir: string): IndexRead {
    const path = join(dir, 'index.json');
    let stat;

    try {
        stat = statSync(path);
    }
    catch {
        indexCache.delete(path);

        return { state: 'missing' };
    }

    const cached = indexCache.get(path);

    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.state === 'ok' && cached.index
            ? { state: 'ok', index: cached.index }
            : { state: 'corrupt' };
    }

    const raw = readJsonFileState<Partial<AlbumIndex>>(path);
    const index = raw.state === 'ok' ? normalizeIndex(raw.value) : null;

    if (!index) {
        indexCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, state: 'corrupt' });

        return { state: raw.state === 'missing' ? 'missing' : 'corrupt' };
    }

    indexCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, state: 'ok', index });

    return { state: 'ok', index };
}

function readIndexFile(dir: string): AlbumIndex | null {
    const result = readIndexFileState(dir);

    return result.state === 'ok' ? result.index : null;
}

function writeIndexFile(dir: string, index: AlbumIndex): void {
    const path = join(dir, 'index.json');

    writeJsonAtomic(path, index);
    indexCache.delete(path);
}

/** 只读登记表 + 各相册的 index.json，不打开任何相册数据库 */
export function listAlbums(settings: Settings): AlbumIndex[] {
    const albums: AlbumIndex[] = [];

    for (const entry of listRegisteredAlbums(settings)) {
        const index = readIndexFile(entry.dir);

        if (index) {
            albums.push(index);
        }
    }

    return albums.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 列表 + 目录状态；登记过但目录丢失时返回 missing=true，让首页提示 */
export function listAlbumSummaries(settings: Settings): AlbumSummary[] {
    const summaries: AlbumSummary[] = [];

    for (const entry of listRegisteredAlbums(settings)) {
        const result = readIndexFileState(entry.dir);
        const fallback: AlbumSummary = {
            schemaVersion: 1,
            id: entry.id,
            name: entry.name,
            description: '',
            coverAssetId: null,
            assetCount: 0,
            createdAt: entry.registeredAt,
            updatedAt: entry.registeredAt,
            settings: defaultAlbumSettings(),
            dir: entry.dir,
            missing: false,
            corrupt: true,
        };

        if (result.state === 'ok') {
            summaries.push({ ...result.index, dir: entry.dir, missing: false, corrupt: false });
        }
        else if (result.state === 'corrupt') {
            summaries.push(fallback);
        }
        else {
            summaries.push({ ...fallback, corrupt: false, missing: true });
        }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface ReconcileResult {
    removedDuplicates: number
    /** 标签主数据尚未就绪（旧文件缺失且从未写过标签）：跳过孤儿关联清理，避免把关联清空 */
    tagMasterMissing: boolean
}

/** 首次打开某个相册时做一次对账：清理孤儿重复行、校正资产数与封面 */
const reconciledDirs = new Set<string>();

export function reconcileAlbum(settings: Settings, context: AlbumContext): ReconcileResult {
    const removedDuplicates = pruneOrphanDuplicates(context.db.album);

    // 标签库损坏（回退内存库）时跳过孤儿关联清理：此时标签主数据不可读，
    // 清理会把 picture.db 里的 asset_tags 全部删掉且不可恢复。
    const tagMasterMissing = isTagDatabaseCorrupt(context.db.tags);
    const validTagIds = tagMasterMissing ? null : tagIds(context.db.tags);

    if (validTagIds !== null) {
        pruneOrphanTagLinks(context.db.album, validTagIds);
    }

    const facts = computeAlbumFacts(context.db.album, context.index.coverAssetId);

    if (facts.assetCount !== context.index.assetCount || facts.coverAssetId !== context.index.coverAssetId) {
        const next: AlbumIndex = {
            ...context.index,
            assetCount: facts.assetCount,
            coverAssetId: facts.coverAssetId,
            updatedAt: new Date().toISOString(),
        };

        writeIndexFile(context.dir, next);
        context.index = next;
    }

    reconciledDirs.add(context.dir);

    return { removedDuplicates, tagMasterMissing };
}

/**
 * 只校验相册已登记，不打开任何 SQLite。
 * 任务接口在拆出 task.db 后不再需要相册库连接，用这个替代 getAlbum 的副作用。
 */
export function assertAlbumRegistered(settings: Settings, id: string): void {
    if (!findRegisteredAlbum(settings, id)) {
        throw new ApiError(404, 'album_not_found', 'The requested album does not exist.');
    }
}

export function getAlbum(settings: Settings, id: string): AlbumContext {
    const dir = albumDirFor(settings, id);
    const result = readIndexFileState(dir);

    if (result.state === 'corrupt') {
        logger.warn({ dir, id }, 'index.json is corrupt');

        throw new ApiError(
            500,
            'album_index_corrupt',
            'index.json in the album directory is not valid.',
        );
    }
    if (result.state === 'missing') {
        if (findRegisteredAlbum(settings, id)) {
            logger.warn({ dir, id }, 'album directory is missing');

            throw new ApiError(404, 'album_missing', 'The album directory does not exist.');
        }

        throw new ApiError(404, 'album_not_found', 'The requested album does not exist.');
    }

    const index = result.index;
    const context: AlbumContext = { index, dir, db: albumDatabase(dir) };

    if (!reconciledDirs.has(dir)) {
        reconcileAlbum(settings, context);
    }

    return context;
}

export function ensureAlbumNameAvailable(settings: Settings, name: string, exceptId?: string): void {
    const normalized = normalizeName(name).toLocaleLowerCase();

    for (const album of listAlbums(settings)) {
        if (album.id !== exceptId && album.name.toLocaleLowerCase() === normalized) {
            throw new ApiError(409, 'album_name_conflict', 'An album with this name already exists.');
        }
    }
}

export function createAlbum(
    settings: Settings,
    input: { name: string, description?: string, dir?: string },
): AlbumIndex {
    const customDir = input.dir?.trim();
    const now = new Date().toISOString();

    if (customDir) {
        const dir = normalizeAlbumPath(customDir);
        const existing = readIndexFile(dir);

        // 指向已有相册目录：直接登记，不改名
        if (existing) {
            if (listAlbums(settings).some(album => album.id === existing.id)) {
                throw new ApiError(409, 'album_path_conflict', 'This album is already registered.');
            }

            ensureAlbumNameAvailable(settings, existing.name);
            registerAlbum(settings, {
                id: existing.id,
                dir,
                name: existing.name,
                registeredAt: now,
            });

            return existing;
        }

        if (existsSync(dir) && readdirSync(dir).length > 0) {
            throw new ApiError(
                409,
                'album_path_not_empty',
                'The target directory is not empty and does not contain an album.',
            );
        }

        const customName = normalizeName(input.name);

        if (customName === '') {
            throw new ApiError(422, 'validation_failed', 'Album name must not be empty.');
        }

        ensureAlbumNameAvailable(settings, customName);

        const id = uuidv7();
        const index: AlbumIndex = {
            schemaVersion: 1,
            id,
            name: customName,
            description: input.description?.trim() ?? '',
            coverAssetId: null,
            assetCount: 0,
            createdAt: now,
            updatedAt: now,
            settings: defaultAlbumSettings(),
        };

        mkdirSync(dir, { recursive: true });
        writeIndexFile(dir, index);
        registerAlbum(settings, { id, dir, name: customName, registeredAt: now });

        return index;
    }

    const name = normalizeName(input.name);

    if (name === '') {
        throw new ApiError(422, 'validation_failed', 'Album name must not be empty.');
    }

    ensureAlbumNameAvailable(settings, name);

    const id = uuidv7();
    const dir = join(settings.albumsRoot, id);
    const index: AlbumIndex = {
        schemaVersion: 1,
        id,
        name,
        description: input.description?.trim() ?? '',
        coverAssetId: null,
        assetCount: 0,
        createdAt: now,
        updatedAt: now,
        settings: defaultAlbumSettings(),
    };

    mkdirSync(dir, { recursive: true });
    writeIndexFile(dir, index);
    registerAlbum(settings, { id, dir, name, registeredAt: now });

    return index;
}

/** 关联一个已经存在的自包含相册目录（不改名、不复制文件） */
export function linkExistingAlbum(settings: Settings, rawDir: string): AlbumSummary {
    const dir = normalizeAlbumPath(rawDir);
    const index = readIndexFile(dir);

    if (!index) {
        logger.warn({ dir }, 'no album found while linking existing directory');

        throw new ApiError(404, 'album_import_not_found', 'No album found in the selected directory.');
    }

    if (listAlbums(settings).some(album => album.id === index.id)) {
        throw new ApiError(409, 'album_path_conflict', 'This album is already registered.');
    }

    ensureAlbumNameAvailable(settings, index.name);
    registerAlbum(settings, {
        id: index.id,
        dir,
        name: index.name,
        registeredAt: new Date().toISOString(),
    });

    return { ...index, dir, missing: false, corrupt: false };
}

export function updateAlbum(
    settings: Settings,
    id: string,
    patch: {
        name?: string
        description?: string
        coverAssetId?: string | null
        settings?: Partial<AlbumFeatureSettings>
    },
): AlbumIndex {
    const context = getAlbum(settings, id);
    const next: AlbumIndex = { ...context.index };

    if (patch.name !== undefined) {
        const name = normalizeName(patch.name);

        if (name === '') {
            throw new ApiError(422, 'validation_failed', 'Album name must not be empty.');
        }

        ensureAlbumNameAvailable(settings, name, id);
        next.name = name;
    }

    if (patch.description !== undefined) {
        next.description = patch.description.trim();
    }

    if (patch.coverAssetId !== undefined) {
        if (patch.coverAssetId === null) {
            next.coverAssetId = computeAlbumFacts(context.db.album, null).coverAssetId;
        }
        else {
            const cover = context.db.album
                .select({ id: assets.id })
                .from(assets)
                .where(and(eq(assets.id, patch.coverAssetId), isNull(assets.deletedAt)))
                .get();

            if (!cover) {
                throw new ApiError(404, 'asset_not_found', 'The requested media does not exist.');
            }

            next.coverAssetId = cover.id;
        }
    }

    if (patch.settings !== undefined) {
        if (patch.settings.similarityThreshold !== undefined) {
            next.settings = { ...next.settings, similarityThreshold: patch.settings.similarityThreshold };
        }

        if (patch.settings.autoTag !== undefined) {
            next.settings = { ...next.settings, autoTag: patch.settings.autoTag };
        }

        if (patch.settings.pixivEnabled !== undefined) {
            next.settings = { ...next.settings, pixivEnabled: patch.settings.pixivEnabled };
        }

        if (patch.settings.pixivAutoDownload !== undefined) {
            next.settings = { ...next.settings, pixivAutoDownload: patch.settings.pixivAutoDownload };
        }
    }

    next.updatedAt = new Date().toISOString();
    writeIndexFile(context.dir, next);

    return next;
}

export function updateAlbumStats(
    settings: Settings,
    id: string,
    patch: { assetCount?: number, coverAssetId?: string | null },
): AlbumIndex {
    const context = getAlbum(settings, id);
    const next: AlbumIndex = {
        ...context.index,
        assetCount: patch.assetCount ?? context.index.assetCount,
        coverAssetId: patch.coverAssetId === undefined ? context.index.coverAssetId : patch.coverAssetId,
        updatedAt: new Date().toISOString(),
    };

    writeIndexFile(context.dir, next);

    return next;
}

/**
 * 默认只解除关联：从登记表移除，磁盘目录与文件原样保留，由用户自行决定是否删除。
 * 需要连文件一起删除时显式传 `deleteFiles: true`。
 *
 * 递归 `rmSync` 不可逆。相册本体允许放在任意路径（「关联已有相册」/自定义目录），
 * 所以不能靠“是否在 albumsRoot 内”认位置，只能靠内容认身份：index.json 必须可解析
 * 且其 id 与 albumId 一致。首次扫描会把任何含 index.json 的目录登记；用户把该目录
 * 改作他用后（index 丢失或换成别的相册），身份校验失败即只解除关联，绝不动磁盘。
 */
function isSameAlbum(dir: string, id: string): boolean {
    const index = readIndexFile(dir);

    return Boolean(index) && index?.id === id;
}

export function deleteAlbum(
    settings: Settings,
    id: string,
    options: { deleteFiles?: boolean } = {},
): void {
    const entry = findRegisteredAlbum(settings, id);

    if (!entry) {
        throw new ApiError(404, 'album_not_found', 'The requested album does not exist.');
    }

    if (!closeAlbumDatabase(entry.dir)) {
        throw new ApiError(409, 'album_busy', 'The album has a running import or AI job.');
    }
    reconciledDirs.delete(entry.dir);

    if (options.deleteFiles) {
        if (existsSync(entry.dir) && isSameAlbum(entry.dir, id)) {
            rmSync(entry.dir, { recursive: true, force: true });
        }
        // 即使目录身份不符/已丢失，数据根目录的缩略图缓存也随相册移除
        removeAlbumThumbnailDatabase(id);
    }
    // 身份不符：保留磁盘内容，下面只解除关联

    // 任务历史集中存在数据根，不随相册搬移；解除关联时一并清理，避免留下孤儿任务
    deleteAlbumImportJobs(id);
    deleteAlbumAiJobs(id);

    unregisterAlbum(settings, id);
}

export function listTags(settings: Settings, albumId: string): TagRecord[] {
    const context = getAlbum(settings, albumId);

    return listTagRecords(context.db.tags);
}

export function createTag(settings: Settings, albumId: string, input: { name: string, color?: string }): TagRecord {
    const context = getAlbum(settings, albumId);

    return createTagRecord(context.db.tags, input, { autoColor: true });
}

export function updateTag(
    settings: Settings,
    albumId: string,
    tagId: string,
    patch: { name?: string, color?: string },
): TagRecord {
    const context = getAlbum(settings, albumId);

    return updateTagRecord(context.db.tags, tagId, patch);
}

export function deleteTag(settings: Settings, albumId: string, tagId: string): void {
    const context = getAlbum(settings, albumId);

    if (!getTagRecord(context.db.tags, tagId)) {
        throw new ApiError(404, 'tag_not_found', 'The requested tag does not exist.');
    }

    deleteTagRecords(context.db.tags, [tagId]);
    context.db.album.delete(assetTags).where(eq(assetTags.tagId, tagId)).run();
}

export interface TagImportInput {
    name: string
    color?: string
}

/** 从导出文件或任意 `{ tags: [...] }` 导入：按名称去重，已存在的跳过 */
export function importTags(
    settings: Settings,
    albumId: string,
    inputs: TagImportInput[],
): { added: number, skipped: number } {
    const context = getAlbum(settings, albumId);

    return importTagRecords(context.db.tags, inputs, { autoColor: true });
}

export interface TagColorResult {
    updated: number
    tags: TagRecord[]
}

/** 自动配色：auto 按标签名稳定取色，random 从调色板随机取色 */
export function recolorTags(
    settings: Settings,
    albumId: string,
    options: { mode: 'auto' | 'random', onlyEmpty: boolean },
): TagColorResult {
    const context = getAlbum(settings, albumId);

    return recolorTagRecords(context.db.tags, options);
}

/** 删除全部标签及关联；返回删除的标签数量 */
export function deleteAllTags(settings: Settings, albumId: string): number {
    const context = getAlbum(settings, albumId);
    const removed = deleteAllTagRecords(context.db.tags);

    if (removed > 0) {
        context.db.album.delete(assetTags).run();
    }

    return removed;
}

/** 批量删除标签，同时清理资产关联；返回实际删除数量 */
export function deleteTags(settings: Settings, albumId: string, ids: string[]): number {
    const context = getAlbum(settings, albumId);
    const targets = [...new Set(ids)];

    if (targets.length === 0) {
        return 0;
    }

    const removed = deleteTagRecords(context.db.tags, targets);
    context.db.album.delete(assetTags).where(inArray(assetTags.tagId, targets)).run();

    return removed;
}

/** 把 sourceIds 合并进 targetId：关联去重合并，来源标签删除 */
export function mergeTags(
    settings: Settings,
    albumId: string,
    sourceIds: string[],
    targetId: string,
): { removed: number, moved: number } {
    const context = getAlbum(settings, albumId);
    const { sources } = resolveMergeSources(context.db.tags, sourceIds, targetId);

    if (sources.length === 0) {
        return { removed: 0, moved: 0 };
    }

    const ids = sources.map(tag => tag.id);
    const placeholders = ids.map(() => '?').join(', ');
    // 目标标签已关联同一资产时跳过该行，下面再统一清掉来源行
    const result = context.db.album.$client
        .prepare(`UPDATE OR IGNORE asset_tags SET tag_id = ? WHERE tag_id IN (${placeholders})`)
        .run(targetId, ...ids);

    context.db.album.delete(assetTags).where(inArray(assetTags.tagId, ids)).run();
    deleteTagRecords(context.db.tags, ids);

    return { removed: ids.length, moved: Number(result.changes ?? 0) };
}
