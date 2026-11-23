import { and, eq } from 'drizzle-orm';
import { cloudDatabase } from '../database/cloud';
import { logger } from '../logger';
import { pixivLocals } from '../database/schemas/cloud';
import { nowSeconds } from '../utils/time';

/** Pixiv 原图缓存读写（<dataDir>/data/cloud.db.pixiv_locals）。 */

export interface CloudPixivImage {
    mime: string
    blob: Buffer
    sizeBytes: number
    fetchedAt: number
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** 云端原图缓存默认上限 2 GiB，可用 PX_PIXIV_CLOUD_MAX_MB 覆盖（≥64） */
const DEFAULT_MAX_CACHE_BYTES = 2048 * 1024 * 1024;
const EVICT_TARGET_RATIO = 0.8;

function maxCacheBytes(): number {
    const raw = Number(process.env.PX_PIXIV_CLOUD_MAX_MB ?? '');

    if (Number.isFinite(raw) && raw >= 64) {
        return Math.floor(raw) * 1024 * 1024;
    }

    return DEFAULT_MAX_CACHE_BYTES;
}

function totalCacheBytes(): number {
    const row = cloudDatabase().$client
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM pixiv_locals')
        .get() as { total: number } | undefined;

    return Number(row?.total ?? 0);
}

/**
 * 超出上限时按 last_accessed_at 逐批淘汰到 80%。
 * 总量走 size_bytes 覆盖索引，不会为统计去读 BLOB 页。
 */
export function pruneCloudPixivImageCache(maxBytes = maxCacheBytes()): number {
    try {
        let total = totalCacheBytes();

        if (total <= maxBytes) {
            return 0;
        }

        const target = Math.floor(maxBytes * EVICT_TARGET_RATIO);
        const client = cloudDatabase().$client;
        // 按累积体积精确删除最久未访问的行，避免固定批量把远超上限的缓存一起清掉
        const deleteOldestBytes = client.prepare(`
            DELETE FROM pixiv_locals WHERE rowid IN (
                SELECT rowid FROM (
                    SELECT rowid, SUM(size_bytes) OVER (ORDER BY last_accessed_at ASC, rowid ASC) AS cumulative
                    FROM pixiv_locals
                ) WHERE cumulative <= ?
            )
        `);
        let removed = 0;

        while (total > target) {
            const result = deleteOldestBytes.run(total - target);
            const changes = Number(result.changes ?? 0);

            if (changes === 0) {
                // 已经压到上限以内就停：继续删会为了 80% 目标把最后一张也清掉
                if (total <= maxBytes) {
                    break;
                }

                // 仍在超限：至少删掉最久未访问的一行，避免永久超限
                const fallback = client.prepare(`
                    DELETE FROM pixiv_locals WHERE rowid = (
                        SELECT rowid FROM pixiv_locals
                        ORDER BY last_accessed_at ASC, rowid ASC
                        LIMIT 1
                    )
                `).run();

                if (Number(fallback.changes ?? 0) === 0) {
                    break;
                }

                removed += Number(fallback.changes ?? 0);
                total = totalCacheBytes();

                continue;
            }

            removed += changes;
            total = totalCacheBytes();
        }

        logger.info({ removed, total, maxBytes }, 'evicted pixiv cloud image cache');

        return removed;
    }
    catch (error) {
        // 缓存淘汰失败不影响图片读取，下次写入再试
        logger.warn({ err: error }, 'failed to evict pixiv cloud image cache');

        return 0;
    }
}

export function readCloudPixivImage(illustId: string, pageIndex: number): CloudPixivImage | null {
    try {
        const db = cloudDatabase();
        const row = db
            .select()
            .from(pixivLocals)
            .where(and(eq(pixivLocals.illustId, illustId), eq(pixivLocals.pageIndex, pageIndex)))
            .get();

        if (!row) {
            return null;
        }

        const lastAccess = row.lastAccessedAt * 1000;

        if (!Number.isFinite(lastAccess) || Date.now() - lastAccess > TOUCH_INTERVAL_MS) {
            db.update(pixivLocals)
                .set({ lastAccessedAt: nowSeconds() })
                .where(and(eq(pixivLocals.illustId, illustId), eq(pixivLocals.pageIndex, pageIndex)))
                .run();
        }

        return {
            mime: row.mime,
            blob: Buffer.from(row.blob),
            sizeBytes: row.sizeBytes,
            fetchedAt: row.fetchedAt,
        };
    }
    catch (error) {
        // cloud.db 损坏/被锁时按缓存未命中处理，让路由回退到流式代理
        logger.warn({ err: error, illustId, pageIndex }, 'failed to read cloud pixiv cache');

        return null;
    }
}

export function writeCloudPixivImage(
    illustId: string,
    pageIndex: number,
    mime: string,
    blob: Buffer,
): void {
    const now = nowSeconds();

    cloudDatabase()
        .insert(pixivLocals)
        .values({
            illustId,
            pageIndex,
            mime,
            sizeBytes: blob.byteLength,
            blob,
            fetchedAt: now,
            lastAccessedAt: now,
        })
        .onConflictDoUpdate({
            target: [pixivLocals.illustId, pixivLocals.pageIndex],
            set: {
                mime,
                sizeBytes: blob.byteLength,
                blob,
                fetchedAt: now,
                lastAccessedAt: now,
            },
        })
        .run();

    pruneCloudPixivImageCache();
}
