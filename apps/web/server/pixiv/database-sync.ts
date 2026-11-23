import { existsSync, statSync } from 'node:fs';
import { eq, gt } from 'drizzle-orm';
import { listAlbumSummaries } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import type { AlbumPixivDatabase } from '../database/album-pixiv';
import { markPixivIllustInvalid, pixivDatabase, writePixivIllustSnapshot } from '../database/pixiv';
import { pixivAssetLinks } from '../database/schemas/album';
import { illusts, illustTags, pixivTags, pixivUsers } from '../database/schemas/pixiv';
import { logger } from '../logger';
import { getSettings } from '../settings/setting-store';
import { albumPictureDbPath, albumPixivDbPath, describeDataDirectories } from '../utils/data-dir';
import { nowSeconds } from '../utils/time';
import { buildPixivIllust } from './global-cache';
import type { PixivIllust, PixivTag } from './types';

/**
 * 全局 Pixiv 库 <dataDir>/data/pixiv.db 的汇总：把各相册 <album>/data/pixiv.db 的同构副本
 * 按作品重放进全局库，再由 picture.db 的分P映射补占位行。
 * 因此全局库可以随时删除重建，数据事实源在各相册里。
 */

/** 相册副本 → 领域对象（三次批量查询，避免逐作品往返） */
function readAlbumPixivCopy(pixiv: AlbumPixivDatabase): Array<{ illust: PixivIllust, fetchedAt: number }> {
    const rows = pixiv
        .select()
        .from(illusts)
        .where(gt(illusts.fetchedAt, 0))
        .all();

    if (rows.length === 0) {
        return [];
    }

    const users = new Map(
        pixiv.select({ userId: pixivUsers.userId, name: pixivUsers.name, account: pixivUsers.account })
            .from(pixivUsers)
            .all()
            .map(user => [user.userId, user]),
    );
    const tagsByIllust = new Map<string, PixivTag[]>();

    for (const tag of pixiv
        .select({
            illustId: illustTags.illustId,
            name: pixivTags.name,
            translatedName: pixivTags.translatedName,
        })
        .from(illustTags)
        .innerJoin(pixivTags, eq(illustTags.tagId, pixivTags.tagId))
        .orderBy(illustTags.illustId, illustTags.sortOrder)
        .all()) {
        const list = tagsByIllust.get(tag.illustId);

        if (list) {
            list.push({ name: tag.name, translatedName: tag.translatedName });
        }
        else {
            tagsByIllust.set(tag.illustId, [{ name: tag.name, translatedName: tag.translatedName }]);
        }
    }

    return rows.map(row => ({
        fetchedAt: row.fetchedAt,
        illust: buildPixivIllust(row, users.get(row.userId), tagsByIllust.get(row.illustId) ?? []),
    }));
}

function readAlbumPixivInvalid(pixiv: AlbumPixivDatabase): Array<{ illustId: string, invalidAt: number }> {
    return pixiv
        .select({ illustId: illusts.illustId, invalidAt: illusts.invalidAt })
        .from(illusts)
        .where(gt(illusts.invalidAt, 0))
        .all();
}

function listLinkedIllustIds(album: AlbumDatabase): string[] {
    return album
        .select({ illustId: pixivAssetLinks.illustId })
        .from(pixivAssetLinks)
        .all()
        .map(row => row.illustId);
}

export interface PixivDatabaseSyncResult {
    albums: number
    illusts: number
    users: number
    tags: number
    skipped: string[]
    syncedAt: string
}

export interface PixivDatabaseSyncStatus {
    syncing: boolean
    lastSyncedAt: string
    result: PixivDatabaseSyncResult | null
    error: string | null
    path: string
}

function countIn(client: ReturnType<typeof pixivDatabase>['$client'], table: string): number {
    const row = client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined;

    return Number(row?.n ?? 0);
}

function readMeta(client: ReturnType<typeof pixivDatabase>['$client'], key: string): string | null {
    const row = client.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;

    return row?.value ?? null;
}

function writeMeta(client: ReturnType<typeof pixivDatabase>['$client'], key: string, value: string): void {
    client
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
}

/** 相册库 + WAL 的 mtime/size；WAL 模式下只改主库 mtime 会漏掉尚未 checkpoint 的写入 */
function albumSignature(path: string): string {
    const main = statSync(path);
    const walPath = `${path}-wal`;
    const wal = existsSync(walPath) ? statSync(walPath) : null;

    return `${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
}

export function syncPixivDatabase(): PixivDatabaseSyncResult {
    const settings = getSettings();
    const db = pixivDatabase();
    const client = db.$client;
    const syncedAt = new Date().toISOString();
    const skipped: string[] = [];
    const allAlbums = listAlbumSummaries(settings);
    const enabled = allAlbums.filter(album => (
        !album.missing && !album.corrupt && album.settings.pixivEnabled
    ));
    let albums = 0;

    for (const album of enabled) {
        const picturePath = albumPictureDbPath(album.dir);
        const copyPath = albumPixivDbPath(album.dir);
        const hasCopy = existsSync(copyPath);

        if (!existsSync(picturePath)) {
            skipped.push(album.id);
            continue;
        }

        const signature = `${albumSignature(picturePath)}|${hasCopy ? albumSignature(copyPath) : 'none'}`;

        // 相册库没有变化时跳过整组重放，重启后首次汇总不再阻塞
        if (readMeta(client, `album_sig:${album.id}`) === signature) {
            continue;
        }

        let lease: ReturnType<typeof leaseAlbumDatabase>;

        try {
            lease = leaseAlbumDatabase(album.dir);
        }
        catch (error) {
            skipped.push(album.id);
            logger.warn({ err: error, albumId: album.id }, 'pixiv database sync could not open album');
            continue;
        }

        try {
            const links = listLinkedIllustIds(lease.handle.album);
            const placeholder = client.prepare('INSERT OR IGNORE INTO illusts (illust_id, fetched_at) VALUES (?, 0)');
            const copy = hasCopy ? readAlbumPixivCopy(lease.handle.pixiv) : [];
            const invalid = hasCopy ? readAlbumPixivInvalid(lease.handle.pixiv) : [];

            client.transaction(() => {
                for (const illustId of links) {
                    if (illustId !== '') {
                        placeholder.run(illustId);
                    }
                }

                // 复用低层写入：更旧的相册快照不会回退全局详情，也不会改写画师与标签关系
                for (const { illust, fetchedAt } of copy) {
                    writePixivIllustSnapshot(client, illust, fetchedAt);
                }

                // 失效标记最后写：比失效观察更新的成功快照会保留为有效
                for (const item of invalid) {
                    markPixivIllustInvalid(client, item.illustId, item.invalidAt);
                }
            })();

            writeMeta(client, `album_sig:${album.id}`, signature);
            albums += 1;
        }
        catch (error) {
            skipped.push(album.id);
            logger.warn({ err: error, albumId: album.id }, 'pixiv database sync skipped album');
        }
        finally {
            lease.release();
        }
    }

    // 清理已经不再登记的相册签名，避免 meta 无限增长
    const registered = new Set(allAlbums.map(album => album.id));
    const signatures = client
        .prepare("SELECT key FROM meta WHERE key LIKE 'album_sig:%'")
        .all() as { key: string }[];

    for (const row of signatures) {
        const albumId = row.key.slice('album_sig:'.length);

        if (!registered.has(albumId)) {
            client.prepare('DELETE FROM meta WHERE key = ?').run(row.key);
        }
    }

    const result: PixivDatabaseSyncResult = {
        albums,
        illusts: countIn(client, 'illusts'),
        users: countIn(client, 'users'),
        tags: countIn(client, 'tags'),
        skipped,
        syncedAt,
    };

    writeMeta(client, 'last_sync_at', String(nowSeconds()));
    writeMeta(client, 'last_sync_result', JSON.stringify(result));

    logger.info({
        albums,
        illusts: result.illusts,
        users: result.users,
        tags: result.tags,
        skipped: skipped.length,
    }, 'pixiv database synced');

    return result;
}

let status: PixivDatabaseSyncStatus = {
    syncing: false,
    lastSyncedAt: '',
    result: null,
    error: null,
    path: describeDataDirectories().pixivDbPath,
};
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;

function statusFromResult(result: PixivDatabaseSyncResult): PixivDatabaseSyncStatus {
    return {
        syncing: false,
        lastSyncedAt: result.syncedAt,
        result,
        error: null,
        path: describeDataDirectories().pixivDbPath,
    };
}

export function getPixivDatabaseStatus(): PixivDatabaseSyncStatus {
    return {
        ...status,
        path: describeDataDirectories().pixivDbPath,
    };
}

export function syncPixivDatabaseNow(): PixivDatabaseSyncResult {
    const result = syncPixivDatabase();

    status = statusFromResult(result);

    return result;
}

/**
 * 汇总是幂等的轻量重活：写入后合并触发，1.5 秒内的多次调用只执行一次。
 * 测试环境默认关闭，避免路由测试产生后台任务；PX_TEST_PIXIV_DB_SYNC=1 可打开。
 */
export function schedulePixivDatabaseSync(delayMs = 1500): void {
    if (process.env.NODE_ENV === 'test' && process.env.PX_TEST_PIXIV_DB_SYNC !== '1') {
        return;
    }
    if (timer) {
        return;
    }

    timer = setTimeout(() => {
        timer = null;
        runScheduledSync();
    }, Math.max(0, delayMs));
    timer.unref?.();
}

function runScheduledSync(): void {
    if (running) {
        dirty = true;

        return;
    }

    running = true;
    status = { ...status, syncing: true, error: null };

    try {
        status = statusFromResult(syncPixivDatabase());
    }
    catch (error) {
        status = {
            ...status,
            syncing: false,
            error: error instanceof Error ? error.message : String(error),
        };
        logger.warn({ err: error }, 'pixiv database background sync failed');
    }
    finally {
        running = false;

        if (dirty) {
            dirty = false;
            schedulePixivDatabaseSync(0);
        }
    }
}

export function resetPixivDatabaseSyncForTests(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }

    running = false;
    dirty = false;
    status = {
        syncing: false,
        lastSyncedAt: '',
        result: null,
        error: null,
        path: describeDataDirectories().pixivDbPath,
    };
}
