import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { readMeta, writeMeta } from '../album/album-meta';
import { getAlbum, listAlbumSummaries } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import { assets, pixivAssetLinks } from '../database/schemas/album';
import { logger } from '../logger';
import { getSettings } from '../settings/setting-store';
import { schedulePixivDatabaseSync } from './database-sync';
import { parsePixivFilename } from './filename';
import { pruneAlbumPixivData } from './store';
import { clearLocalPixivPageCache } from './local-assets';

/**
 * 旧相册里已有大量 Pixiv 图片，但 pixiv_asset_links 只覆盖打开过/补全过的作品。
 * 这里按有效文件名一次性补齐映射（后台分批，不阻塞请求），让全局 pixiv.db 覆盖整个相册。
 */

const LINKS_KEY = 'pixiv_links_backfilled_v1';
const PRUNE_KEY = 'pixiv_data_pruned_v1';
const PIXIV_META_KEY = 'pixiv_meta_backfilled_v1';
const BATCH_SIZE = 1000;

export interface PixivLinkBackfillResult {
    added: number
    skipped: boolean
}

/**
 * 旧资产的映射可能由文件名回填而来，但 meta.pixiv 只有打开详情时才补。
 * 统一把 links 里的 illust/page 写回 meta，保证 Pixiv ID 排序与搜索对所有资产生效。
 */
function backfillPixivMeta(db: AlbumDatabase): number {
    let lastRowid = 0;
    let updated = 0;

    for (;;) {
        const rows = db.$client.prepare(`
            SELECT a.rowid AS rid, a.id, a.meta, l.illust_id, l.page_index
            FROM assets a
            JOIN pixiv_asset_links l ON l.asset_id = a.id
            WHERE a.rowid > ?
              AND a.deleted_at IS NULL
              AND json_extract(a.meta, '$.pixiv') IS NULL
            ORDER BY a.rowid
            LIMIT 1000
        `).all(lastRowid) as {
            rid: number
            id: string
            meta: string
            illust_id: string
            page_index: number
        }[];

        if (rows.length === 0) {
            return updated;
        }

        lastRowid = rows[rows.length - 1]!.rid;

        const update = db.$client.prepare(`
            UPDATE assets
            SET meta = json_set(coalesce(meta, '{}'), '$.pixiv.illustId', ?, '$.pixiv.pageIndex', ?)
            WHERE id = ?
        `);

        db.$client.transaction(() => {
            for (const row of rows) {
                update.run(row.illust_id, row.page_index, row.id);
                updated += 1;
            }
        })();
    }
}

export async function backfillAlbumPixivLinks(albumId: string): Promise<PixivLinkBackfillResult> {
    const settings = getSettings();
    const context = getAlbum(settings, albumId);
    const lease = leaseAlbumDatabase(context.dir);

    try {
        const db = lease.handle.album;
        const pixiv = lease.handle.pixiv;

        if (readMeta(db, LINKS_KEY) === '1') {
            if (readMeta(db, PIXIV_META_KEY) !== '1') {
                backfillPixivMeta(db);
                writeMeta(db, PIXIV_META_KEY, '1');
                clearLocalPixivPageCache();
            }

            // 老版本只补了映射；这里再裁剪一次不属于本相册的详情/断点
            if (readMeta(db, PRUNE_KEY) !== '1') {
                pruneAlbumPixivData(db, pixiv);
                writeMeta(db, PRUNE_KEY, '1');
            }

            return { added: 0, skipped: true };
        }

        let added = 0;
        let scanned = 0;
        let cursor = '';

        // 按 assets.id keyset 分批：回填过程中新写入的映射会从结果集消失，
        // 用 offset 会跳行；UUID v7 可按二进制顺序稳定推进。
        for (;;) {
            const rows = db
                .select({ assetId: assets.id, filename: assets.filename })
                .from(assets)
                .leftJoin(pixivAssetLinks, eq(pixivAssetLinks.assetId, assets.id))
                .where(and(
                    isNull(assets.deletedAt),
                    isNull(pixivAssetLinks.assetId),
                    cursor === '' ? undefined : gt(assets.id, cursor),
                ))
                .orderBy(asc(assets.id))
                .limit(BATCH_SIZE)
                .all();

            if (rows.length === 0) {
                break;
            }

            const values: { assetId: string, illustId: string, pageIndex: number }[] = [];

            for (const row of rows) {
                const ref = parsePixivFilename(row.filename);

                if (ref) {
                    values.push({
                        assetId: row.assetId,
                        illustId: ref.illustId,
                        pageIndex: ref.pageIndex,
                    });
                }
            }

            if (values.length > 0) {
                const result = db.transaction(tx => tx
                    .insert(pixivAssetLinks)
                    .values(values)
                    .onConflictDoNothing()
                    .run());

                added += Number(result.changes ?? 0);
            }

            scanned += rows.length;
            cursor = rows[rows.length - 1]!.assetId;

            // 大批量回填时让出事件循环，避免与首次浏览争抢 SQLite
            await new Promise<void>(resolve => setImmediate(resolve));
        }

        writeMeta(db, LINKS_KEY, '1');
        const metaUpdated = backfillPixivMeta(db);
        writeMeta(db, PIXIV_META_KEY, '1');
        clearLocalPixivPageCache();
        pruneAlbumPixivData(db, pixiv);
        writeMeta(db, PRUNE_KEY, '1');

        if (added > 0) {
            schedulePixivDatabaseSync(0);
        }

        logger.info({ albumId, added, metaUpdated, scanned }, 'pixiv asset links backfilled');

        return { added, skipped: false };
    }
    finally {
        lease.release();
    }
}

const pending: string[] = [];
const active = new Set<string>();
let pumping = false;

/** 启动/打开相册时补齐所有相册（或指定相册）的映射；已完成标记的相册会快速跳过 */
export function schedulePixivLinkBackfill(albumId?: string): void {
    if (process.env.NODE_ENV === 'test' && process.env.PX_TEST_PIXIV_LINK_BACKFILL !== '1') {
        return;
    }

    const ids = albumId
        ? [albumId]
        : listAlbumSummaries(getSettings())
            .filter(album => !album.missing && !album.corrupt)
            .map(album => album.id);

    for (const id of ids) {
        if (!active.has(id) && !pending.includes(id)) {
            pending.push(id);
        }
    }

    // 先让触发它的 GET / 导入响应返回，再开始扫描大相册
    setImmediate(() => {
        void pump();
    });
}

async function pump(): Promise<void> {
    if (pumping) {
        return;
    }

    pumping = true;

    try {
        while (pending.length > 0) {
            const albumId = pending.shift();

            if (!albumId) {
                break;
            }

            active.add(albumId);

            try {
                await backfillAlbumPixivLinks(albumId);
            }
            catch (error) {
                logger.warn({ err: error, albumId }, 'pixiv asset link backfill failed');
            }
            finally {
                active.delete(albumId);
            }
        }
    }
    finally {
        pumping = false;
    }
}
