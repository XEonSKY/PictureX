import { defineRelations } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 标签主数据 <album>/data/tag.db 与 <dataDir>/data/tag.db 共用。
 * - 只存应用自身生成/用户创建的标签；Pixiv 标签属于作品元数据，存放在 pixiv.db。
 * - name 保留用户展示的原始写法，name_key 为小写归一化键并唯一；
 * - 时间戳统一 integer（Unix 秒）。
 */

export const tags = sqliteTable('tags', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    color: text('color').notNull().default(''),
    createdAt: integer('created_at').notNull(),
}, table => [
    uniqueIndex('tags_name_key_idx').on(table.nameKey),
]);

export const tagMeta = sqliteTable('tag_meta', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
});

export const tagSchema = {
    tags,
    tagMeta,
};

export const tagRelations = defineRelations(tagSchema, () => ({}));
