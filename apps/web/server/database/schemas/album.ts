import { defineRelations, sql } from 'drizzle-orm';

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 相册媒体索引 <album>/data/picture.db。
 * 约定：主键 text（UUID v7）、时间戳 integer（Unix 秒）、JSON 存 text（领域层序列化）。
 */

export const albumMeta = sqliteTable('album_meta', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
});

export const assets = sqliteTable('assets', {
    id: text('id').primaryKey(),
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    mime: text('mime').notNull(),
    kind: text('kind').notNull(),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sha256: text('sha256').notNull(),
    phash: text('phash'),
    takenAt: integer('taken_at'),
    addedAt: integer('added_at').notNull(),
    /** 非空表示已移入回收站；列表/统计/导出默认排除 */
    deletedAt: integer('deleted_at'),
    /** 1 表示收藏 */
    favorite: integer('favorite').notNull().default(0),
    meta: text('meta').notNull(),
    /** 生成列：Pixiv 作品 ID；AI 候选查询直接判空，避免逐行 json_extract */
    pixivIllustId: text('pixiv_illust_id').generatedAlwaysAs(sql`json_extract(meta, '$.pixiv.illustId')`),
    /** 生成列：作品 ID 的数值形式（非 Pixiv 资产为 0），供「按 Pixiv ID」排序走索引 */
    pixivIllustNum: integer('pixiv_illust_num').generatedAlwaysAs(
        sql`coalesce(cast(json_extract(meta, '$.pixiv.illustId') as integer), 0)`,
    ),
}, table => [
    index('assets_sha256_idx').on(table.sha256),
    index('assets_phash_idx').on(table.phash),
    index('assets_added_at_idx').on(table.addedAt),
    index('assets_taken_at_idx').on(table.takenAt),
    index('assets_taken_sort_idx').on(sql`coalesce(${table.takenAt}, ${table.addedAt})`),
    index('assets_filename_idx').on(table.filename),
    index('assets_deleted_at_idx').on(table.deletedAt),
    index('assets_favorite_idx').on(table.favorite, table.addedAt),
    // 列表默认只看未删除资产并按键集游标翻页：带 id 的排序键保证无需临时排序
    index('assets_active_added_idx').on(table.addedAt, table.id).where(sql`${table.deletedAt} is null`),
    index('assets_active_taken_idx')
        .on(sql`coalesce(${table.takenAt}, ${table.addedAt})`, table.id)
        .where(sql`${table.deletedAt} is null`),
    index('assets_active_filename_idx').on(table.filename, table.id).where(sql`${table.deletedAt} is null`),
    index('assets_active_favorite_idx')
        .on(table.favorite, table.addedAt, table.id)
        .where(sql`${table.deletedAt} is null`),
    index('assets_active_pixiv_idx')
        .on(table.pixivIllustNum, table.id)
        .where(sql`${table.deletedAt} is null`),
]);

export const assetTags = sqliteTable('asset_tags', {
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    tagId: text('tag_id').notNull(),
}, table => [
    primaryKey({ columns: [table.assetId, table.tagId] }),
    index('asset_tags_tag_idx').on(table.tagId),
]);

export const duplicateFiles = sqliteTable('duplicate_files', {
    id: text('id').primaryKey(),
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    foundAt: integer('found_at').notNull(),
}, table => [
    index('duplicate_files_sha_idx').on(table.sha256),
    index('duplicate_files_asset_idx').on(table.assetId),
    uniqueIndex('duplicate_files_path_idx').on(table.sha256, table.sourcePath),
]);

export const similarGroups = sqliteTable('similar_groups', {
    id: text('id').primaryKey(),
    threshold: integer('threshold').notNull(),
    representativeId: text('representative_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    itemCount: integer('item_count').notNull(),
    maxDistance: integer('max_distance').notNull(),
}, table => [
    index('similar_groups_threshold_idx').on(table.threshold, table.itemCount),
]);

export const similarGroupItems = sqliteTable('similar_group_items', {
    groupId: text('group_id').notNull().references(() => similarGroups.id, { onDelete: 'cascade' }),
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    distance: integer('distance').notNull(),
}, table => [
    primaryKey({ columns: [table.groupId, table.assetId] }),
    index('similar_group_items_asset_idx').on(table.assetId),
]);

/** 分P → 本地资产映射；按 (illust_id, page_index) 唯一，资产删除时级联清理 */
export const pixivAssetLinks = sqliteTable('pixiv_asset_links', {
    assetId: text('asset_id').primaryKey().references(() => assets.id, { onDelete: 'cascade' }),
    illustId: text('illust_id').notNull(),
    pageIndex: integer('page_index').notNull(),
}, table => [
    uniqueIndex('pixiv_asset_links_page_idx').on(table.illustId, table.pageIndex),
    index('pixiv_asset_links_illust_idx').on(table.illustId),
]);

/**
 * 后台补全断点：记录每个 Pixiv 作品的最近一次处理结果。
 * done 且元数据仍在缓存期内 → 跳过；failed/missing 在冷却期内 → 不再重复检查。
 */
export const pixivFetchMarks = sqliteTable('pixiv_fetch_marks', {
    illustId: text('illust_id').primaryKey(),
    status: text('status').notNull(),
    attemptedAt: integer('attempted_at').notNull(),
}, table => [
    index('pixiv_fetch_marks_status_idx').on(table.status, table.attemptedAt),
]);

export const albumSchema = {
    albumMeta,
    assets,
    assetTags,
    duplicateFiles,
    similarGroups,
    similarGroupItems,
    pixivAssetLinks,
    pixivFetchMarks,
};

export const albumRelations = defineRelations(albumSchema, () => ({}));

export type AssetRow = typeof assets.$inferSelect;
