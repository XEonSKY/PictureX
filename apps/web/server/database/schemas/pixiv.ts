import { defineRelations } from 'drizzle-orm';
import {
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * 全局 Pixiv 库 <dataDir>/data/pixiv.db。
 *
 * - illusts：作品详情；按 illust_id 建行，仅凭文件名/映射识别到的作品先写占位行
 *   （fetched_at = 0），后台补全后覆盖为完整详情；
 * - users：画师信息，按 user_id 唯一；
 * - tags：Pixiv 标签字典（name_key 大小写不敏感唯一）；
 * - illust_tags：作品 ↔ 标签关系，带原始顺序；
 * - meta：迁移/同步状态等键值。
 *
 * 相册内的 asset ↔ illust/page 映射只保存在各相册 picture.db，不再写入全局库。
 * 时间戳统一 integer（Unix 秒）。
 */

export const illusts = sqliteTable('illusts', {
    illustId: text('illust_id').primaryKey(),
    userId: text('user_id').notNull().default(''),
    title: text('title').notNull().default(''),
    type: text('type').notNull().default('illust'),
    caption: text('caption').notNull().default(''),
    pageCount: integer('page_count').notNull().default(1),
    width: integer('width'),
    height: integer('height'),
    xRestrict: integer('x_restrict').notNull().default(0),
    sanityLevel: integer('sanity_level').notNull().default(0),
    illustAiType: integer('illust_ai_type').notNull().default(0),
    createDate: integer('create_date'),
    totalView: integer('total_view').notNull().default(0),
    totalBookmarks: integer('total_bookmarks').notNull().default(0),
    /** 紧凑分P：[[square, medium, large, original], ...]，索引即分P序号 */
    pages: text('pages').notNull().default('[]'),
    /** ugoira：{"zipUrl":"...","frames":[{"file","delay"}]} */
    ugoira: text('ugoira'),
    /** 0 表示仅占位、详情尚未拉取 */
    fetchedAt: integer('fetched_at').notNull().default(0),
    /** >0 表示 Pixiv 已返回 404（作品删除/不可见）；成功的详情快照会清零 */
    invalidAt: integer('invalid_at').notNull().default(0),
}, table => [
    index('illusts_fetched_idx').on(table.fetchedAt),
    index('illusts_user_idx').on(table.userId),
]);

export const pixivUsers = sqliteTable('users', {
    userId: text('user_id').primaryKey(),
    name: text('name').notNull().default(''),
    account: text('account').notNull().default(''),
    updatedAt: integer('updated_at').notNull().default(0),
});

export const pixivTags = sqliteTable('tags', {
    tagId: integer('tag_id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    translatedName: text('translated_name'),
}, table => [
    uniqueIndex('tags_name_key_idx').on(table.nameKey),
]);

export const illustTags = sqliteTable('illust_tags', {
    illustId: text('illust_id').notNull().references(() => illusts.illustId, { onDelete: 'cascade' }),
    tagId: integer('tag_id').notNull().references(() => pixivTags.tagId, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
}, table => [
    primaryKey({ columns: [table.illustId, table.tagId] }),
    index('illust_tags_tag_idx').on(table.tagId),
]);

export const meta = sqliteTable('meta', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
});

export const pixivSchema = {
    illusts,
    users: pixivUsers,
    tags: pixivTags,
    illustTags,
    meta,
};

export const pixivRelations = defineRelations(pixivSchema, () => ({}));
