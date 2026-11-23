import { eq, inArray, sql } from 'drizzle-orm';
import { globalTagDatabase } from '../database/global';
import { ApiError } from '../hono/problem';
import type { GlobalDatabase } from '../database/global';
import { viewerMediaTags } from '../database/schemas/global';
import {
    createTagRecord,
    deleteAllTagRecords,
    deleteTagRecords,
    getTagRecord,
    importTagRecords,
    listTagRecords,
    recolorTagRecords,
    resolveMergeSources,
    updateTagRecord,
} from '../tags/tag-store';
import type { TagRecord } from '../tags/types';

/**
 * 全局标签主数据（<dataDir>/data/tag.db）：只服务查看器手动标签与全局标签页。
 * 标签 CRUD 复用 server/tags/tag-store.ts；本模块只负责全局位置与 viewer_media_tags 关联。
 *
 * 旧 <dataDir>/tag.json 由 globalTagDatabase() 首次打开时自动迁移，之后不再写入。
 */

function tagDb() {
    return globalTagDatabase();
}

export function listGlobalTags(): TagRecord[] {
    return listTagRecords(tagDb());
}

export interface GlobalTagListItem extends TagRecord {
    count: number
}

/** 全局图库/全局标签页的标签栏：来源显式化，并带上关联媒体数量 */
export function listGlobalTagsWithCounts(db: GlobalDatabase): GlobalTagListItem[] {
    const counts = db
        .select({ tagId: viewerMediaTags.tagId, count: sql<number>`count(*)` })
        .from(viewerMediaTags)
        .groupBy(viewerMediaTags.tagId)
        .all();
    const byTag = new Map(counts.map(row => [row.tagId, Number(row.count)]));

    return listGlobalTags().map(tag => ({
        ...tag,
        count: byTag.get(tag.id) ?? 0,
    }));
}

export function createGlobalTag(input: { name: string, color?: string }): TagRecord {
    return createTagRecord(tagDb(), input, { autoColor: true });
}

export function updateGlobalTag(tagId: string, patch: { name?: string, color?: string }): TagRecord {
    return updateTagRecord(tagDb(), tagId, patch);
}

/** 删除标签：同时清理全局库里指向它的媒体关联 */
export function deleteGlobalTag(db: GlobalDatabase, tagId: string): void {
    if (!getTagRecord(tagDb(), tagId)) {
        throw new ApiError(404, 'tag_not_found', 'The requested tag does not exist.');
    }

    deleteTagRecords(tagDb(), [tagId]);
    db.delete(viewerMediaTags).where(eq(viewerMediaTags.tagId, tagId)).run();
}

/** 批量删除标签并清理关联，返回实际删除数量 */
export function deleteGlobalTags(db: GlobalDatabase, ids: string[]): number {
    const targets = [...new Set(ids)];

    if (targets.length === 0) {
        return 0;
    }

    const removed = deleteTagRecords(tagDb(), targets);

    // 即使主数据里已不存在（旧版本残留），也清掉可能存在的孤儿关联
    db.delete(viewerMediaTags).where(inArray(viewerMediaTags.tagId, targets)).run();

    return removed;
}

/** 删除全部全局标签与关联（相册标签会在下次同步时重新出现） */
export function deleteAllGlobalTags(db: GlobalDatabase): number {
    const removed = deleteAllTagRecords(tagDb());

    if (removed > 0) {
        db.delete(viewerMediaTags).run();
    }

    return removed;
}

export function importGlobalTags(inputs: { name: string, color?: string }[]): { added: number, skipped: number } {
    return importTagRecords(tagDb(), inputs, { autoColor: true });
}

export function recolorGlobalTags(
    options: { mode: 'auto' | 'random', onlyEmpty: boolean },
): { updated: number, tags: TagRecord[] } {
    return recolorTagRecords(tagDb(), options);
}

/** 把来源标签合并进目标：关联去重迁移，来源标签删除 */
export function mergeGlobalTags(
    db: GlobalDatabase,
    sourceIds: string[],
    targetId: string,
): { removed: number, moved: number } {
    const { sources } = resolveMergeSources(tagDb(), sourceIds, targetId);

    if (sources.length === 0) {
        return { removed: 0, moved: 0 };
    }

    const ids = sources.map(tag => tag.id);
    const placeholders = ids.map(() => '?').join(', ');
    // 目标标签已关联同一媒体时跳过该行，下面再统一清掉来源行
    const result = db.$client
        .prepare(`UPDATE OR IGNORE viewer_media_tags SET tag_id = ? WHERE tag_id IN (${placeholders})`)
        .run(targetId, ...ids);

    db.delete(viewerMediaTags).where(inArray(viewerMediaTags.tagId, ids)).run();
    deleteTagRecords(tagDb(), ids);

    return { removed: ids.length, moved: Number(result.changes ?? 0) };
}

export function knownGlobalTagIds(): Set<string> {
    return new Set(listGlobalTags().map(tag => tag.id));
}
