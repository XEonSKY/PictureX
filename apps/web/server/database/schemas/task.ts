import { defineRelations } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 统一任务库 <dataDir>/data/task.db：导入与 AI 任务集中管理，不再散落在各相册 picture.db。
 * 任务按 album_id 关联相册；相册目录搬走时任务历史留在数据根，删除相册时一并清理。
 * 约定与其余库一致：主键 text（UUID v7）、时间戳 integer（Unix 秒）。
 */

export const importJobs = sqliteTable('import_jobs', {
    id: text('id').primaryKey(),
    albumId: text('album_id').notNull(),
    rootPath: text('root_path').notNull(),
    status: text('status').notNull(),
    cursor: text('cursor'),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    added: integer('added').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
}, table => [
    index('import_jobs_album_idx').on(table.albumId, table.startedAt),
    index('import_jobs_resume_idx').on(table.albumId, table.rootPath, table.status),
]);

export const aiJobs = sqliteTable('ai_jobs', {
    id: text('id').primaryKey(),
    albumId: text('album_id').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
}, table => [
    index('ai_jobs_album_idx').on(table.albumId, table.startedAt),
]);

/** 任务状态是纯键值记录，跨库没有外键；相册归属由应用层与删除流程维护 */
export const taskSchema = { importJobs, aiJobs };

export const taskRelations = defineRelations(taskSchema, () => ({}));
