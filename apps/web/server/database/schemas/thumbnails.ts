import { defineRelations } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 缩略图库 `<dataDir>/data/thumbnails.db`（所有相册共用一个文件）。
 * BLOB 按尺寸存放在 `thumbnails_s<size>` 分表（见 album/thumb-tables.ts），
 * 这里只保留生成失败的负缓存；Drizzle 不描述动态尺寸表。
 */

/** 生成失败的负缓存：按 (相册, 资产, 生成参数指纹) 记录，不同尺寸/DPR 各自独立、带 TTL */
export const thumbnailFailures = sqliteTable('thumbnail_failures', {
    albumId: text('album_id').notNull(),
    assetId: text('asset_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    failedAt: integer('failed_at').notNull(),
}, table => [
    primaryKey({ columns: [table.albumId, table.assetId, table.fingerprint] }),
]);

export const thumbnailsSchema = {
    thumbnailFailures,
};

export const thumbnailsRelations = defineRelations(thumbnailsSchema, () => ({}));
