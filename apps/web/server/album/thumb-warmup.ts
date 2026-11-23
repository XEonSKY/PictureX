import type Database from 'better-sqlite3';
import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { assets } from '../database/schemas/album';
import { leaseAlbumDatabase } from '../database/album';
import { logger } from '../logger';
import type { Settings } from '../settings/setting-schema';
import { nowSeconds } from '../utils/time';
import type { AlbumContext } from './album-store';
import { ensureThumbnail } from './thumb-service';
import { createThumbStore } from './thumb-store';

/**
 * 缩略图预热：按相册默认排序（新增优先）只生成最小配置尺寸。
 * - 串行低优先级，不阻塞首屏交互；
 * - 游标写入 thumb_meta，暂停/重启后可继续；
 * - 已存在缩略图或负缓存的资产快速跳过。
 */

export type ThumbWarmupStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface ThumbWarmupState {
    status: ThumbWarmupStatus
    scope: 'album' | 'import' | null
    total: number
    processed: number
    generated: number
    skipped: number
    failed: number
    currentAssetId: string | null
    startedAt: string | null
    finishedAt: string | null
    error: string | null
    /** 是否存在可继续的持久化游标 */
    resumable: boolean
    size: number
}

const IDLE: ThumbWarmupState = {
    status: 'idle',
    scope: null,
    total: 0,
    processed: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    currentAssetId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    resumable: false,
    size: 0,
};

const CURSOR_KEY = 'warmup_cursor';
const COMPLETED_KEY = 'warmup_completed_at';
const BATCH_SIZE = 64;

const states = new Map<string, ThumbWarmupState>();
const running = new Set<string>();
const pauseRequested = new Set<string>();
const cancelRequested = new Set<string>();

function readMeta(client: Database.Database, albumId: string, key: string): string | null {
    const row = client
        .prepare('SELECT value FROM thumb_meta WHERE album_id = ? AND key = ?')
        .get(albumId, key) as { value?: string } | undefined;

    return row?.value ?? null;
}

function writeMeta(client: Database.Database, albumId: string, key: string, value: string): void {
    client
        .prepare(`
            INSERT INTO thumb_meta (album_id, key, value) VALUES (?, ?, ?)
            ON CONFLICT(album_id, key) DO UPDATE SET value = excluded.value
        `)
        .run(albumId, key, value);
}

function clearMeta(client: Database.Database, albumId: string, key: string): void {
    client.prepare('DELETE FROM thumb_meta WHERE album_id = ? AND key = ?').run(albumId, key);
}

function readCursor(context: AlbumContext): string | null {
    return readMeta(context.db.thumbnails.$client, context.index.id, CURSOR_KEY);
}

function writeCursor(context: AlbumContext, value: string | null): void {
    if (value === null) {
        clearMeta(context.db.thumbnails.$client, context.index.id, CURSOR_KEY);
    }
    else {
        writeMeta(context.db.thumbnails.$client, context.index.id, CURSOR_KEY, value);
    }
}

function warmupSize(settings: Settings): number {
    const sizes = [...new Set(settings.thumbnails.sizes)].sort((left, right) => left - right);

    return sizes[0] ?? 256;
}

function updateState(albumId: string, patch: Partial<ThumbWarmupState>): ThumbWarmupState {
    const current = states.get(albumId) ?? { ...IDLE, resumable: false };
    const next: ThumbWarmupState = { ...current, ...patch };

    states.set(albumId, next);

    return next;
}

export function thumbnailWarmupState(albumId: string, context: AlbumContext): ThumbWarmupState {
    const current = states.get(albumId);

    if (current) {
        return current;
    }

    const cursor = readCursor(context);

    return {
        ...IDLE,
        resumable: Boolean(cursor),
    };
}

/**
 * 当前正在/暂停预热的相册（纯内存，不打开任何相册库）。
 * 磁盘活动视图用它回答「现在谁在批量读原图」。
 */
export function activeThumbnailWarmups(): Array<{ albumId: string, state: ThumbWarmupState }> {
    return [...states.entries()]
        .filter(([, state]) => state.status === 'running' || state.status === 'paused')
        .map(([albumId, state]) => ({ albumId, state }));
}

export interface ThumbWarmupStartOptions {
    /** 从相册起点重新预热；默认沿用持久化游标 */
    restart?: boolean
    /** 只预热指定资产（导入后）；不写相册游标 */
    assetIds?: string[]
}

export function startThumbnailWarmup(
    settings: Settings,
    context: AlbumContext,
    options: ThumbWarmupStartOptions = {},
): ThumbWarmupState {
    const albumId = context.index.id;
    const current = states.get(albumId);

    if (running.has(albumId)) {
        return current ?? thumbnailWarmupState(albumId, context);
    }

    const scope: ThumbWarmupState['scope'] = options.assetIds ? 'import' : 'album';
    const ids = options.assetIds
        ? [...new Set(options.assetIds)].filter(id => id !== '')
        : null;

    if (ids && ids.length === 0) {
        return current ?? thumbnailWarmupState(albumId, context);
    }

    if (ids && current && (current.status === 'running' || current.status === 'paused')) {
        // 全量任务正在进行/暂停中：不覆盖它的游标与进度
        return current;
    }

    if (options.restart) {
        writeCursor(context, null);
    }

    const size = warmupSize(settings);
    const total = ids
        ? ids.length
        : Number(context.db.album
            .select({ total: count() })
            .from(assets)
            .where(isNull(assets.deletedAt))
            .get()?.total ?? 0);

    pauseRequested.delete(albumId);
    cancelRequested.delete(albumId);
    running.add(albumId);

    const state = updateState(albumId, {
        status: 'running',
        scope,
        total,
        processed: 0,
        generated: 0,
        skipped: 0,
        failed: 0,
        currentAssetId: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        resumable: scope === 'album',
        size,
    });

    setImmediate(() => {
        void runWarmup(settings, context, ids, size);
    });

    return state;
}

export function pauseThumbnailWarmup(albumId: string, context: AlbumContext): ThumbWarmupState {
    if (!running.has(albumId)) {
        return thumbnailWarmupState(albumId, context);
    }

    pauseRequested.add(albumId);

    return updateState(albumId, {
        status: 'paused',
        currentAssetId: null,
        finishedAt: new Date().toISOString(),
    });
}

export function cancelThumbnailWarmup(albumId: string, context: AlbumContext): ThumbWarmupState {
    if (!running.has(albumId)) {
        return thumbnailWarmupState(albumId, context);
    }

    cancelRequested.add(albumId);

    return updateState(albumId, {
        status: 'cancelled',
        currentAssetId: null,
        finishedAt: new Date().toISOString(),
    });
}

/** 清空缩略图后一并重置预热位置，下一次重新从头扫描 */
export function resetThumbnailWarmupPosition(context: AlbumContext): void {
    writeCursor(context, null);
    clearMeta(context.db.thumbnails.$client, context.index.id, COMPLETED_KEY);
    states.delete(context.index.id);
}

interface WarmupCursor {
    addedAt: number
    id: string
}

function parseCursor(value: string | null): WarmupCursor | null {
    if (!value) {
        return null;
    }

    const index = value.indexOf(':');

    if (index <= 0) {
        return null;
    }

    const addedAt = Number(value.slice(0, index));
    const id = value.slice(index + 1);

    return Number.isFinite(addedAt) && id !== '' ? { addedAt, id } : null;
}

function cursorString(row: { addedAt: number, id: string }): string {
    return `${row.addedAt}:${row.id}`;
}

async function runWarmup(
    settings: Settings,
    context: AlbumContext,
    assetIds: string[] | null,
    size: number,
): Promise<void> {
    const albumId = context.index.id;
    const lease = leaseAlbumDatabase(context.dir);

    try {
        const db = lease.handle.album;
        const store = createThumbStore(lease.handle.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);

        if (assetIds) {
            for (const assetId of assetIds) {
                if (pauseRequested.has(albumId) || cancelRequested.has(albumId)) {
                    break;
                }

                await processAsset(settings, albumId, context, store, assetId, size);
                await yieldToLoop();
            }
        }
        else {
            let cursor = parseCursor(readCursor(context));

            for (;;) {
                if (pauseRequested.has(albumId) || cancelRequested.has(albumId)) {
                    break;
                }

                const rows = db
                    .select({ id: assets.id, addedAt: assets.addedAt })
                    .from(assets)
                    .where(and(
                        isNull(assets.deletedAt),
                        cursor
                            ? or(
                                lt(assets.addedAt, cursor.addedAt),
                                and(eq(assets.addedAt, cursor.addedAt), lt(assets.id, cursor.id)),
                            )
                            : undefined,
                    ))
                    .orderBy(desc(assets.addedAt), desc(assets.id))
                    .limit(BATCH_SIZE)
                    .all();

                if (rows.length === 0) {
                    break;
                }

                for (const row of rows) {
                    if (pauseRequested.has(albumId) || cancelRequested.has(albumId)) {
                        break;
                    }

                    await processAsset(settings, albumId, context, store, row.id, size);
                    cursor = { addedAt: row.addedAt, id: row.id };
                    writeCursor(context, cursorString(cursor));
                    await yieldToLoop();
                }

                if (pauseRequested.has(albumId) || cancelRequested.has(albumId)) {
                    break;
                }
            }
        }

        if (!assetIds && !pauseRequested.has(albumId) && !cancelRequested.has(albumId)) {
            writeCursor(context, null);
            writeMeta(lease.handle.thumbnails.$client, albumId, COMPLETED_KEY, String(nowSeconds()));
        }

        const status: ThumbWarmupStatus = cancelRequested.has(albumId)
            ? 'cancelled'
            : pauseRequested.has(albumId)
                ? 'paused'
                : 'completed';

        updateState(albumId, {
            status,
            currentAssetId: null,
            finishedAt: new Date().toISOString(),
            resumable: status !== 'completed' && Boolean(readCursor(context)),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logger.warn({ err: error, albumId }, 'thumbnail warmup failed');
        updateState(albumId, {
            status: 'failed',
            currentAssetId: null,
            finishedAt: new Date().toISOString(),
            error: message,
        });
    }
    finally {
        running.delete(albumId);
        pauseRequested.delete(albumId);
        cancelRequested.delete(albumId);
        lease.release();
    }
}

async function processAsset(
    settings: Settings,
    albumId: string,
    context: AlbumContext,
    store: ReturnType<typeof createThumbStore>,
    assetId: string,
    size: number,
): Promise<void> {
    const state = states.get(albumId);
    const existed = store.has(assetId, size);

    updateState(albumId, { currentAssetId: assetId });

    if (existed) {
        updateState(albumId, {
            processed: (state?.processed ?? 0) + 1,
            skipped: (state?.skipped ?? 0) + 1,
        });

        return;
    }

    const ok = await ensureThumbnail(albumId, context.dir, settings, assetId, size, 'background').catch(() => false);

    const current = states.get(albumId);

    updateState(albumId, {
        processed: (current?.processed ?? 0) + 1,
        generated: (current?.generated ?? 0) + (ok ? 1 : 0),
        failed: (current?.failed ?? 0) + (ok ? 0 : 1),
    });
}

function yieldToLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export function resetThumbnailWarmupForTests(): void {
    states.clear();
    running.clear();
    pauseRequested.clear();
    cancelRequested.clear();
}
