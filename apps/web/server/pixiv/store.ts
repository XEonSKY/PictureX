import { and, asc, eq, inArray, isNull, like, ne } from 'drizzle-orm';
import { writePixivIllustSnapshot, type PixivDatabase } from '../database/pixiv';
import { assets, pixivAssetLinks } from '../database/schemas/album';
import { illusts } from '../database/schemas/pixiv';
import type { AlbumDatabase } from '../database/album';
import type { AlbumPixivDatabase } from '../database/album-pixiv';
import type { AssetRow } from '../database/schemas/album';
import { nowSeconds } from '../utils/time';
import { parsePixivFilename } from './filename';
import { readPixivIllust, type GlobalCachedIllust } from './global-cache';
import type { PixivIllust, PixivLocalPage } from './types';

/**
 * 相册内的 Pixiv 数据。
 *
 * 作品详情存在 `<album>/data/pixiv.db`（与数据根全局库同构的按相册副本），
 * 分P 映射与补全断点存在 `picture.db`：映射外键依赖 assets 的级联删除，不能拆走。
 */

export type CachedIllust = GlobalCachedIllust;

export function getCachedIllust(db: PixivDatabase, illustId: string): CachedIllust | null {
    try {
        return readPixivIllust(db, illustId);
    }
    catch {
        return null;
    }
}

export function upsertIllust(db: PixivDatabase, illust: PixivIllust): void {
    writePixivIllustSnapshot(db.$client, illust, nowSeconds());
}

/** @returns 该资产最终是否映射到目标分P（已有同分P映射或新绑定为 true） */
export function linkPixivAsset(
    db: AlbumDatabase,
    illustId: string,
    pageIndex: number,
    assetId: string,
): boolean {
    const current = db
        .select({ illustId: pixivAssetLinks.illustId, pageIndex: pixivAssetLinks.pageIndex })
        .from(pixivAssetLinks)
        .where(eq(pixivAssetLinks.assetId, assetId))
        .get();

    // 一个资产只能映射到一个分P。重复字节折叠时，两个分P会解析到同一个 asset：
    // 此时保留已存在的映射，否则新分P会把旧分P挤掉，collectLocalPages 又按文件名补链，
    // 两个分P会来回改绑、不断丢映射。调用方必须把 false 当成该页下载失败。
    if (current) {
        return current.illustId === illustId && current.pageIndex === pageIndex;
    }

    // 同一分P只保留一条映射：同页重新导入时以最新的资产为准
    db.delete(pixivAssetLinks)
        .where(and(
            eq(pixivAssetLinks.illustId, illustId),
            eq(pixivAssetLinks.pageIndex, pageIndex),
            ne(pixivAssetLinks.assetId, assetId),
        ))
        .run();

    db.insert(pixivAssetLinks)
        .values({ assetId, illustId, pageIndex })
        .onConflictDoNothing()
        .run();

    return true;
}

export interface PixivRef {
    illustId: string
    pageIndex: number
}

export function pixivRefForAsset(db: AlbumDatabase, asset: AssetRow): PixivRef | null {
    const link = db
        .select({ illustId: pixivAssetLinks.illustId, pageIndex: pixivAssetLinks.pageIndex })
        .from(pixivAssetLinks)
        .where(eq(pixivAssetLinks.assetId, asset.id))
        .get();

    if (link) {
        return link;
    }

    return parsePixivFilename(asset.filename);
}

/**
 * 找出作品在本地已管理的分P：
 * 先读显式映射，再用文件名补链（导入早于打开详情、尚未建立映射的情况）。
 */
export function collectLocalPages(db: AlbumDatabase, illustId: string): PixivLocalPage[] {
    const linked = db
        .select({
            index: pixivAssetLinks.pageIndex,
            assetId: assets.id,
            filename: assets.filename,
            addedAt: assets.addedAt,
        })
        .from(pixivAssetLinks)
        .innerJoin(assets, eq(assets.id, pixivAssetLinks.assetId))
        .where(and(
            eq(pixivAssetLinks.illustId, illustId),
            isNull(assets.deletedAt),
        ))
        .orderBy(asc(assets.addedAt))
        .all();
    const pages = new Map<number, PixivLocalPage>();

    for (const row of linked) {
        if (!pages.has(row.index)) {
            pages.set(row.index, { index: row.index, assetId: row.assetId, filename: row.filename });
        }
    }

    const candidates = db
        .select({ id: assets.id, filename: assets.filename, addedAt: assets.addedAt })
        .from(assets)
        .where(and(
            isNull(assets.deletedAt),
            like(assets.filename, `${illustId}_p%`),
        ))
        .orderBy(asc(assets.addedAt))
        .all();

    for (const candidate of candidates) {
        const ref = parsePixivFilename(candidate.filename);

        if (!ref || ref.illustId !== illustId || pages.has(ref.pageIndex)) {
            continue;
        }

        pages.set(ref.pageIndex, {
            index: ref.pageIndex,
            assetId: candidate.id,
            filename: candidate.filename,
        });
        linkPixivAsset(db, illustId, ref.pageIndex, candidate.id);
    }

    return [...pages.values()].sort((left, right) => left.index - right.index);
}

export function findAssetBySha(db: AlbumDatabase, sha256: string): AssetRow | null {
    return db
        .select()
        .from(assets)
        .where(eq(assets.sha256, sha256))
        .get() ?? null;
}

function chunked(items: string[], size: number): string[][] {
    const batches: string[][] = [];

    for (let index = 0; index < items.length; index += size) {
        batches.push(items.slice(index, index + size));
    }

    return batches;
}

/**
 * 相册 Pixiv 副本只保留相册内实际存在的作品（按映射判定），
 * 避免删除资产后详情长期留在相册库里随目录跨设备同步。
 * 画师与标签随后清理，保证副本里没有悬空行。
 */
export function pruneAlbumPixivData(albumDb: AlbumDatabase, pixivDb: AlbumPixivDatabase): number {
    const kept = new Set(
        albumDb
            .select({ illustId: pixivAssetLinks.illustId })
            .from(pixivAssetLinks)
            .all()
            .map(row => row.illustId),
    );
    const stale = pixivDb
        .select({ illustId: illusts.illustId })
        .from(illusts)
        .all()
        .map(row => row.illustId)
        .filter(illustId => !kept.has(illustId));

    if (stale.length === 0) {
        return 0;
    }

    pixivDb.$client.transaction(() => {
        for (const batch of chunked(stale, 500)) {
            // illust_tags 由外键级联删除
            pixivDb.delete(illusts).where(inArray(illusts.illustId, batch)).run();
        }

        pixivDb.$client.exec('DELETE FROM tags WHERE tag_id NOT IN (SELECT DISTINCT tag_id FROM illust_tags)');
        pixivDb.$client.exec('DELETE FROM users WHERE user_id NOT IN (SELECT DISTINCT user_id FROM illusts)');
    })();

    return stale.length;
}
