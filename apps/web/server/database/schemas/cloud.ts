import { defineRelations } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Pixiv 云端图片缓存 `<dataDir>/data/cloud.db`。
 *
 * 资料库优先读取相册里的本地图片；本地没有时把 Pixiv 原图下载到这里，
 * 同一 (illust_id, page_index) 只存一份原图，后续所有尺寸预览都从这份缓存读取。
 */

export const pixivLocals = sqliteTable('pixiv_locals', {
    illustId: text('illust_id').notNull(),
    pageIndex: integer('page_index').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    blob: blob('blob', { mode: 'buffer' }).notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    lastAccessedAt: integer('last_accessed_at').notNull(),
}, table => [
    primaryKey({ columns: [table.illustId, table.pageIndex] }),
    index('pixiv_locals_accessed_idx').on(table.lastAccessedAt),
]);

export const cloudSchema = {
    pixivLocals,
};

export const cloudRelations = defineRelations(cloudSchema, () => ({}));
