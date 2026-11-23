import { and, desc, eq, notInArray } from 'drizzle-orm';
import { taskDatabase } from '../database/task';
import { aiJobs } from '../database/schemas/task';
import { ApiError } from '../hono/problem';
import { nowSeconds, toIso, toIsoRequired } from '../utils/time';

/**
 * AI 打标任务读写（<dataDir>/data/task.db），与导入任务同库统一管理。
 */

export type AiJobStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface AiJobDto {
    id: string
    mode: string
    status: AiJobStatus
    total: number
    processed: number
    errors: number
    error: string | null
    startedAt: string
    updatedAt: string
    finishedAt: string | null
}

function toDto(row: typeof aiJobs.$inferSelect): AiJobDto {
    return {
        id: row.id,
        mode: row.mode,
        status: row.status as AiJobStatus,
        total: row.total,
        processed: row.processed,
        errors: row.errors,
        error: row.error,
        startedAt: toIsoRequired(row.startedAt),
        updatedAt: toIsoRequired(row.updatedAt),
        finishedAt: toIso(row.finishedAt),
    };
}

function byId(albumId: string, id: string) {
    return and(eq(aiJobs.albumId, albumId), eq(aiJobs.id, id));
}

export function createAiJob(albumId: string, id: string, mode: string, total: number): AiJobDto {
    const now = nowSeconds();

    taskDatabase().insert(aiJobs).values({
        id,
        albumId,
        mode,
        status: 'running',
        total,
        processed: 0,
        errors: 0,
        error: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
    }).run();

    return getAiJob(albumId, id);
}

export function getAiJob(albumId: string, id: string): AiJobDto {
    const row = taskDatabase()
        .select()
        .from(aiJobs)
        .where(byId(albumId, id))
        .get();

    if (!row) {
        throw new ApiError(404, 'job_not_found', 'The AI job does not exist.');
    }

    return toDto(row);
}

export function listAiJobs(albumId: string, limit = 50): AiJobDto[] {
    return taskDatabase()
        .select()
        .from(aiJobs)
        .where(eq(aiJobs.albumId, albumId))
        .orderBy(desc(aiJobs.startedAt))
        .limit(limit)
        .all()
        .map(toDto);
}

/** 任务页聚合：按最近更新时间跨相册取前 N，避免为每个相册各查一次 */
export function listRecentAiJobs(limit: number, albumId?: string): Array<{ albumId: string, job: AiJobDto }> {
    const rows = (albumId
        ? taskDatabase().select().from(aiJobs).where(eq(aiJobs.albumId, albumId))
        : taskDatabase().select().from(aiJobs))
        .orderBy(desc(aiJobs.updatedAt))
        .limit(limit)
        .all();

    return rows.map(row => ({ albumId: row.albumId, job: toDto(row) }));
}

/** 批量把残留 running AI 任务归一化为 paused；scopeAlbumId 只处理该相册 */
export function pauseStaleAiJobsExcept(
    activeAlbumIds: ReadonlySet<string>,
    scopeAlbumId?: string,
): number {
    const active = [...activeAlbumIds];
    const conditions = [eq(aiJobs.status, 'running')];

    if (scopeAlbumId) {
        conditions.push(eq(aiJobs.albumId, scopeAlbumId));
    }
    if (active.length > 0) {
        conditions.push(notInArray(aiJobs.albumId, active));
    }

    const result = taskDatabase()
        .update(aiJobs)
        .set({
            status: 'paused',
            error: 'Interrupted by a process restart.',
            updatedAt: nowSeconds(),
        })
        .where(and(...conditions))
        .run();

    return Number(result.changes ?? 0);
}

/** 进程崩溃后残留的 running AI 任务归一化为 paused，任务页可直接恢复 */
export function pauseStaleAiJobs(albumId: string, albumActive: boolean): number {
    if (albumActive) {
        return 0;
    }

    return pauseStaleAiJobsExcept(new Set<string>(), albumId);
}

/** 只允许删除已结束的任务，running/paused 需要先取消 */
export function deleteAiJob(albumId: string, id: string): void {
    const job = getAiJob(albumId, id);

    if (job.status === 'running' || job.status === 'paused') {
        throw new ApiError(409, 'job_not_finished', 'Only finished jobs can be deleted.');
    }

    taskDatabase().delete(aiJobs).where(byId(albumId, id)).run();
}

/** 相册解除关联时清理它的全部 AI 任务 */
export function deleteAlbumAiJobs(albumId: string): number {
    const db = taskDatabase();
    const rows = db.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.albumId, albumId)).all();

    if (rows.length === 0) {
        return 0;
    }

    db.delete(aiJobs).where(eq(aiJobs.albumId, albumId)).run();

    return rows.length;
}

export interface AiJobPatch {
    status?: AiJobStatus
    total?: number
    processed?: number
    errors?: number
    error?: string | null
    updatedAt?: number
    finishedAt?: number | null
}

export function updateAiJob(albumId: string, id: string, patch: AiJobPatch): AiJobDto {
    taskDatabase()
        .update(aiJobs)
        .set({ ...patch, updatedAt: patch.updatedAt ?? nowSeconds() })
        .where(byId(albumId, id))
        .run();

    return getAiJob(albumId, id);
}
