import { and, count, desc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type { AlbumDatabase } from '../database/album';
import { assets, assetTags, duplicateFiles } from '../database/schemas/album';

/**
 * 相册内的对账：删除指向已不存在资产的重复文件行，并重新计算资产数与封面。
 * 只读/写当前相册库，由调用方决定何时落盘 index.json。
 */

export interface AlbumFacts {
    assetCount: number
    coverAssetId: string | null
}

export function pruneOrphanDuplicates(db: AlbumDatabase): number {
    const known = db
        .select({ sha256: assets.sha256 })
        .from(assets)
        .where(isNotNull(assets.sha256));

    const result = db
        .delete(duplicateFiles)
        .where(notInArray(duplicateFiles.sha256, known))
        .run();

    return Number(result.changes ?? 0);
}

/** 删除指向不存在标签的关联；tag.db 是标签主数据的唯一事实源 */
export function pruneOrphanTagLinks(db: AlbumDatabase, tagIds: string[]): number {
    const result = tagIds.length === 0
        ? db.delete(assetTags).run()
        : db.delete(assetTags).where(notInArray(assetTags.tagId, tagIds)).run();

    return Number(result.changes ?? 0);
}

export function computeAlbumFacts(db: AlbumDatabase, currentCover: string | null): AlbumFacts {
    let cover = currentCover;

    if (cover) {
        const existing = db
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.id, cover), isNull(assets.deletedAt)))
            .get();

        if (!existing) {
            cover = null;
        }
    }

    if (!cover) {
        cover = db
            .select({ id: assets.id })
            .from(assets)
            .where(isNull(assets.deletedAt))
            .orderBy(desc(assets.addedAt))
            .limit(1)
            .get()?.id ?? null;
    }

    const total = db
        .select({ value: count() })
        .from(assets)
        .where(isNull(assets.deletedAt))
        .get();

    return { assetCount: Number(total?.value ?? 0), coverAssetId: cover };
}
