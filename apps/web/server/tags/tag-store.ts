import { asc, count, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { randomTagColor } from '../../shared/tag-color';
import { assertTagMasterReadable, type TagDatabase } from '../database/tags';
import { tags } from '../database/schemas/tags';
import { nowSeconds, toIsoRequired, toSeconds } from '../utils/time';
import {
    normalizeTagName,
    requireTagName,
    resolveTagColor,
    tagNameConflict,
    tagNameKey,
    tagNotFound,
    type TagOperationOptions,
    type TagPatchInput,
    type TagWriteInput,
} from './tag-file';
import type { TagRecord } from './types';

/**
 * 标签主数据的数据库读写。名称去重、配色规则复用 tag-file.ts；
 * 相册与全局标签共用本模块，关联（asset_tags / viewer_media_tags）由各自 store 处理。
 * 标签库只存应用自身生成的标签，Pixiv 作品标签属于 pixiv.db。
 */

type TagRow = typeof tags.$inferSelect;

function toRecord(row: TagRow): TagRecord {
    return {
        id: row.id,
        name: row.name,
        color: row.color,
        createdAt: toIsoRequired(row.createdAt),
    };
}

export function listTagRecords(db: TagDatabase): TagRecord[] {
    return db
        .select()
        .from(tags)
        .orderBy(asc(tags.createdAt), asc(tags.id))
        .all()
        .map(toRecord);
}

export function tagIds(db: TagDatabase): string[] {
    return db.select({ id: tags.id }).from(tags).all().map(row => row.id);
}

export function countTags(db: TagDatabase): number {
    return Number(db.select({ total: count() }).from(tags).get()?.total ?? 0);
}

export function getTagRecord(db: TagDatabase, tagId: string): TagRecord | undefined {
    const row = db.select().from(tags).where(eq(tags.id, tagId)).get();

    return row ? toRecord(row) : undefined;
}

export function createTagRecord(
    db: TagDatabase,
    input: TagWriteInput,
    options: TagOperationOptions = {},
): TagRecord {
    assertTagMasterReadable(db);

    const name = requireTagName(input.name, options);
    const key = tagNameKey(name);

    if (db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, key)).get()) {
        throw tagNameConflict();
    }

    const now = nowSeconds();
    const record: TagRecord = {
        id: uuidv7(),
        name,
        color: resolveTagColor(name, input.color, options),
        createdAt: toIsoRequired(now),
    };

    db.insert(tags)
        .values({
            id: record.id,
            name: record.name,
            nameKey: key,
            color: record.color,
            createdAt: now,
        })
        .run();
    return record;
}

/** 按调用方给定的 id 落库（长任务先分配 id 建关联，再批量 flush） */
export function insertTagRecord(db: TagDatabase, record: TagRecord): boolean {
    assertTagMasterReadable(db);

    const name = normalizeTagName(record.name);
    const key = tagNameKey(name);

    if (name === '') {
        return false;
    }

    const exists = db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, key)).get();

    if (exists) {
        return false;
    }

    const now = nowSeconds();

    db.insert(tags)
        .values({
            id: record.id || uuidv7(),
            name,
            nameKey: key,
            color: record.color?.trim() ?? '',
            createdAt: toSeconds(record.createdAt) ?? now,
        })
        .run();
    return true;
}

export function updateTagRecord(
    db: TagDatabase,
    tagId: string,
    patch: TagPatchInput,
    options: TagOperationOptions = {},
): TagRecord {
    assertTagMasterReadable(db);

    const current = db.select().from(tags).where(eq(tags.id, tagId)).get();

    if (!current) {
        throw tagNotFound();
    }

    let name = current.name;
    let nameKey = current.nameKey;

    if (patch.name !== undefined) {
        name = requireTagName(patch.name, options);
        nameKey = tagNameKey(name);
        const conflict = db.select({ id: tags.id }).from(tags).where(eq(tags.nameKey, nameKey)).get();

        if (conflict && conflict.id !== tagId) {
            throw tagNameConflict();
        }
    }

    const color = patch.color !== undefined ? patch.color.trim() : current.color;

    db.update(tags)
        .set({ name, nameKey, color })
        .where(eq(tags.id, tagId))
        .run();
    return {
        id: tagId,
        name,
        color,
        createdAt: toIsoRequired(current.createdAt),
    };
}

export function deleteTagRecords(db: TagDatabase, ids: string[]): number {
    assertTagMasterReadable(db);

    const targets = [...new Set(ids)];

    if (targets.length === 0) {
        return 0;
    }

    const result = db.delete(tags).where(inArray(tags.id, targets)).run();
    return Number(result.changes ?? 0);
}

/** 整表替换：仅供旧接口兼容/测试夹具使用；常规路径应使用增量 CRUD */
export function deleteAllTagRecords(db: TagDatabase): number {
    assertTagMasterReadable(db);

    const removed = countTags(db);

    if (removed > 0) {
        db.delete(tags).run();
    }

    return removed;
}

export function importTagRecords(
    db: TagDatabase,
    inputs: TagWriteInput[],
    options: TagOperationOptions = {},
): { added: number, skipped: number } {
    assertTagMasterReadable(db);
    const now = nowSeconds();
    let added = 0;
    let skipped = 0;

    db.transaction((tx) => {
        const existing = new Set(
            tx.select({ key: tags.nameKey }).from(tags).all().map(row => row.key),
        );

        for (const input of inputs) {
            const name = normalizeTagName(input.name, options.maxNameLength);
            const key = tagNameKey(name);

            if (name === '' || existing.has(key)) {
                skipped += 1;

                continue;
            }

            existing.add(key);
            tx.insert(tags)
                .values({
                    id: uuidv7(),
                    name,
                    nameKey: key,
                    color: resolveTagColor(name, input.color, options),
                    createdAt: now,
                })
                .run();
            added += 1;
        }
    });

    return { added, skipped };
}

export function recolorTagRecords(
    db: TagDatabase,
    options: { mode: 'auto' | 'random', onlyEmpty: boolean },
): { updated: number, tags: TagRecord[] } {
    assertTagMasterReadable(db);

    const rows = db.select().from(tags).all();
    let updated = 0;

    db.transaction((tx) => {
        for (const row of rows) {
            if (options.onlyEmpty && row.color.trim() !== '') {
                continue;
            }

            const color = options.mode === 'random' ? randomTagColor() : resolveTagColor(row.name, '', { autoColor: true });

            if (row.color === color) {
                continue;
            }

            tx.update(tags)
                .set({ color })
                .where(eq(tags.id, row.id))
                .run();
            updated += 1;
        }
    });

    return { updated, tags: listTagRecords(db) };
}

/** 目标标签必须存在；来源去重并排除目标。合并后的关联迁移由调用方完成 */
export function resolveMergeSources(
    db: TagDatabase,
    sourceIds: string[],
    targetId: string,
): { target: TagRecord, sources: TagRecord[] } {
    assertTagMasterReadable(db);

    const targetRow = db.select().from(tags).where(eq(tags.id, targetId)).get();

    if (!targetRow) {
        throw tagNotFound();
    }

    const ids = [...new Set(sourceIds)].filter(id => id !== targetId);

    if (ids.length === 0) {
        return { target: toRecord(targetRow), sources: [] };
    }

    const sourceRows = db.select().from(tags).where(inArray(tags.id, ids)).all();

    return { target: toRecord(targetRow), sources: sourceRows.map(toRecord) };
}
