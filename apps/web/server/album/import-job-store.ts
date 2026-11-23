import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { taskDatabase } from '../database/task';
import { importJobs } from '../database/schemas/task';
import { ApiError } from '../hono/problem';
import { nowSeconds, toIso, toIsoRequired } from '../utils/time';

/**
 * 导入任务读写（<dataDir>/data/task.db）。
 * 任务按 album_id 归属相册，但不再存在相册自己的库里：全局任务页只打开一个库即可聚合，
 * 相册目录搬去别的设备时也不会把历史任务一起带走。
 */

export type ImportStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ImportJobDto {
    id: string
    rootPath: string
    status: ImportStatus
    cursor: string | null
    total: number
    processed: number
    added: number
    duplicates: number
    skipped: number
    errors: number
    error: string | null
    startedAt: string
    updatedAt: string
    finishedAt: string | null
}

function toDto(row: typeof importJobs.$inferSelect): ImportJobDto {
    return {
        id: row.id,
        rootPath: row.rootPath,
        status: row.status as ImportStatus,
        cursor: row.cursor,
        total: row.total,
        processed: row.processed,
        added: row.added,
        duplicates: row.duplicates,
        skipped: row.skipped,
        errors: row.errors,
        error: row.error,
        startedAt: toIsoRequired(row.startedAt),
        updatedAt: toIsoRequired(row.updatedAt),
        finishedAt: toIso(row.finishedAt),
    };
}

function byId(albumId: string, id: string) {
    return and(eq(importJobs.albumId, albumId), eq(importJobs.id, id));
}

export function createImportJob(albumId: string, id: string, rootPath: string): ImportJobDto {
    const now = nowSeconds();

    taskDatabase().insert(importJobs).values({
        id,
        albumId,
        rootPath,
        status: 'running',
        cursor: null,
        total: 0,
        processed: 0,
        added: 0,
        duplicates: 0,
        skipped: 0,
        errors: 0,
        error: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
    }).run();

    return getImportJob(albumId, id);
}

export function getImportJob(albumId: string, id: string): ImportJobDto {
    const row = taskDatabase()
        .select()
        .from(importJobs)
        .where(byId(albumId, id))
        .get();

    if (!row) {
        throw new ApiError(404, 'import_not_found', 'The import job does not exist.');
    }

    return toDto(row);
}

export function findImportJob(albumId: string, id: string): ImportJobDto | null {
    const row = taskDatabase()
        .select()
        .from(importJobs)
        .where(byId(albumId, id))
        .get();

    return row ? toDto(row) : null;
}

export function findResumableImport(albumId: string, rootPath: string): ImportJobDto | null {
    const row = taskDatabase()
        .select()
        .from(importJobs)
        .where(and(
            eq(importJobs.albumId, albumId),
            eq(importJobs.rootPath, rootPath),
            inArray(importJobs.status, ['running', 'paused']),
        ))
        .orderBy(desc(importJobs.updatedAt))
        .limit(1)
        .get();

    return row ? toDto(row) : null;
}

export function listImportJobs(albumId: string, limit = 50): ImportJobDto[] {
    return taskDatabase()
        .select()
        .from(importJobs)
        .where(eq(importJobs.albumId, albumId))
        .orderBy(desc(importJobs.startedAt))
        .limit(limit)
        .all()
        .map(toDto);
}

/** 任务页聚合：按最近更新时间跨相册取前 N，避免为每个相册各查一次 */
export function listRecentImportJobs(limit: number, albumId?: string): Array<{ albumId: string, job: ImportJobDto }> {
    const rows = (albumId
        ? taskDatabase().select().from(importJobs).where(eq(importJobs.albumId, albumId))
        : taskDatabase().select().from(importJobs))
        .orderBy(desc(importJobs.updatedAt))
        .limit(limit)
        .all();

    return rows.map(row => ({ albumId: row.albumId, job: toDto(row) }));
}

/**
 * 批量把残留的 running 任务归一化为 paused：不属于 activeAlbumIds 的 running 视为崩溃残留。
 * 传入 scopeAlbumId 时只处理该相册。一次 UPDATE 完成，避免逐相册扫描。
 */
export function pauseStaleImportsExcept(
    activeAlbumIds: ReadonlySet<string>,
    scopeAlbumId?: string,
): number {
    const active = [...activeAlbumIds];
    const conditions = [eq(importJobs.status, 'running')];

    if (scopeAlbumId) {
        conditions.push(eq(importJobs.albumId, scopeAlbumId));
    }
    if (active.length > 0) {
        conditions.push(notInArray(importJobs.albumId, active));
    }

    const result = taskDatabase()
        .update(importJobs)
        .set({
            status: 'paused',
            error: 'Interrupted by a process restart.',
            updatedAt: nowSeconds(),
        })
        .where(and(...conditions))
        .run();

    return Number(result.changes ?? 0);
}

/**
 * 进程崩溃/重启后残留的 running 任务归一化为 paused：
 * 游标还在，前端会显示「继续导入」，用户可以原 root 断点续导。
 */
export function pauseStaleImports(albumId: string, albumActive: boolean): number {
    if (albumActive) {
        return 0;
    }

    return pauseStaleImportsExcept(new Set<string>(), albumId);
}

/**
 * 只允许删除已结束的任务：running/paused 仍可继续或取消，
 * 直接删掉会让断点续导与状态机失去依据。
 */
export function deleteImportJob(albumId: string, id: string): void {
    const job = getImportJob(albumId, id);

    if (job.status === 'running' || job.status === 'paused') {
        throw new ApiError(409, 'job_not_finished', 'Only finished jobs can be deleted.');
    }

    taskDatabase().delete(importJobs).where(byId(albumId, id)).run();
}

/** 相册解除关联时清理它的全部导入任务 */
export function deleteAlbumImportJobs(albumId: string): number {
    const db = taskDatabase();
    const rows = db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.albumId, albumId)).all();

    if (rows.length === 0) {
        return 0;
    }

    db.delete(importJobs).where(eq(importJobs.albumId, albumId)).run();

    return rows.length;
}

export interface ImportJobPatch { status?: ImportStatus
    cursor?: string | null
    total?: number
    processed?: number
    added?: number
    duplicates?: number
    skipped?: number
    errors?: number
    error?: string | null
    updatedAt?: number
    finishedAt?: number | null
}

export function updateImportJob(albumId: string, id: string, patch: ImportJobPatch): ImportJobDto {
    const values: ImportJobPatch = { ...patch, updatedAt: patch.updatedAt ?? nowSeconds() };

    taskDatabase().update(importJobs).set(values).where(byId(albumId, id)).run();

    return getImportJob(albumId, id);
}
