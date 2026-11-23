import { defineRelations } from 'drizzle-orm';

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 查看器全局库 <dataDir>/data/picture.db（不属于任何相册）。
 * - 记录被当作「图片/视频查看器」打开过的媒体，按内容 SHA-256 唯一标识。
 * - 标签主数据在 <dataDir>/data/tag.db，本库只存 sha256↔tagId 关联，绝不按文件路径关联（路径随时会变）。
 *
 * 约定：主键 text、时间戳 integer（Unix 秒）。
 */

export const viewerMedia = sqliteTable('viewer_media', {
    /** 内容 SHA-256，查看器媒体的稳定标识 */
    sha256: text('sha256').primaryKey(),
    kind: text('kind').notNull(),
    mime: text('mime').notNull(),
    /** 最近一次打开时看到的文件名，仅作展示，不作为关联依据 */
    filename: text('filename').notNull(),
    /** 最近一次打开时的绝对路径，仅作便捷再打开，路径可能已失效 */
    lastPath: text('last_path'),
    size: integer('size').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    addedAt: integer('added_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
}, table => [
    index('viewer_media_added_idx').on(table.addedAt, table.sha256),
]);

export const viewerMediaTags = sqliteTable('viewer_media_tags', {
    sha256: text('sha256').notNull().references(() => viewerMedia.sha256, { onDelete: 'cascade' }),
    /** tag.db 里的标签 id；跨文件，不加外键，靠应用层与对账维护 */
    tagId: text('tag_id').notNull(),
}, table => [
    primaryKey({ columns: [table.sha256, table.tagId] }),
    index('viewer_media_tags_tag_idx').on(table.tagId),
]);

export const globalSchema = {
    viewerMedia,
    viewerMediaTags,
};

export const globalRelations = defineRelations(globalSchema, () => ({}));

export type ViewerMediaRow = typeof viewerMedia.$inferSelect;
