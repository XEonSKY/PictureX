import { and, eq, inArray } from 'drizzle-orm';
import { listAlbums } from '../album/album-store';
import { listRecentAiJobs, pauseStaleAiJobsExcept } from '../album/ai-job-store';
import { listRecentImportJobs, pauseStaleImportsExcept } from '../album/import-job-store';
import { taskDatabase } from '../database/task';
import { aiJobs, importJobs } from '../database/schemas/task';
import { isTagging } from '../ai/tagging-service';
import { isImporting } from '../ingest/ingest-service';
import { modelDownloader } from '../model/model-downloader';
import { modelRegistry } from '../model/model-registry';
import { getSettings } from '../settings/setting-store';
import type { AiJobDto } from '../album/ai-job-store';
import type { ImportJobDto } from '../album/import-job-store';

/**
 * 任务聚合视图：导入与 AI 任务集中在 <dataDir>/data/task.db，
 * 因此任务页不再为了列任务而逐个打开相册的 picture.db（旧实现会打开全部相册库）。
 */

export interface ImportJobView extends ImportJobDto {
    type: 'import'
    albumId: string
    albumName: string
}

export interface DownloadJobView {
    type: 'download'
    modelId: string
    name: string
    status: string
    totalBytes: number
    bytesDone: number
    speedBps: number
    updatedAt: string
    error: string | null
}

export interface AiJobView extends AiJobDto {
    type: 'ai'
    albumId: string
    albumName: string
}

export type JobView = ImportJobView | DownloadJobView | AiJobView;

const VIEW_CACHE_MS = 2_000;
const DEFAULT_VIEW_LIMIT = 200;
// 断点归一化只用于崩溃恢复，不必跟着 2.5s 轮询对每个相册各跑一次探测查询
const STALE_PROBE_MS = 10_000;

let cachedViews: { key: string, at: number, views: JobView[] } | null = null;
let lastStaleProbeAt = 0;

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export function invalidateJobViewCache(): void {
    cachedViews = null;
}

export interface ClearJobsResult {
    removed: number
    import: number
    ai: number
    download: number
}

/** 批量清空已结束的任务；type 省略表示当前范围内的全部类型 */
export function clearFinishedJobs(options: {
    type?: 'import' | 'download' | 'ai'
    albumId?: string
}): ClearJobsResult {
    const db = taskDatabase();
    const wantImport = options.type === undefined || options.type === 'import';
    const wantAi = options.type === undefined || options.type === 'ai';
    let imports = 0;
    let ai = 0;
    let download = 0;

    if (wantImport) {
        const result = db.delete(importJobs)
            .where(options.albumId
                ? and(eq(importJobs.albumId, options.albumId), inArray(importJobs.status, FINISHED_STATUSES))
                : inArray(importJobs.status, FINISHED_STATUSES))
            .run();

        imports = Number(result.changes ?? 0);
    }

    if (wantAi) {
        const result = db.delete(aiJobs)
            .where(options.albumId
                ? and(eq(aiJobs.albumId, options.albumId), inArray(aiJobs.status, FINISHED_STATUSES))
                : inArray(aiJobs.status, FINISHED_STATUSES))
            .run();

        ai = Number(result.changes ?? 0);
    }

    // 模型下载不属于任何相册；相册范围内不处理
    if (!options.albumId && (options.type === undefined || options.type === 'download')) {
        const downloader = modelDownloader();

        for (const task of downloader.listTasks()) {
            if (downloader.removeTask(task.modelId)) {
                download += 1;
            }
        }
    }

    invalidateJobViewCache();

    return { removed: imports + ai + download, import: imports, ai, download };
}

/**
 * 聚合导入/AI 任务与模型下载；传入 albumId 时只读该相册的任务。
 * 查询按「最近更新优先」每表取前 limit 条，不再逐相册各查一次。
 * 传 type 时只查对应任务表，limit 表示该类型的条数上限。
 */
export function listJobViews(
    albumId = '',
    limit = DEFAULT_VIEW_LIMIT,
    type?: 'import' | 'download' | 'ai',
): JobView[] {
    const cacheKey = `${albumId}:${limit}:${type ?? ''}`;

    if (cachedViews && cachedViews.key === cacheKey && Date.now() - cachedViews.at < VIEW_CACHE_MS) {
        return cachedViews.views;
    }

    const settings = getSettings();
    const albums = listAlbums(settings);
    const nameById = new Map(albums.map(album => [album.id, album.name]));
    const scope = albumId ? [albumId] : albums.map(album => album.id);
    const probeStale = Date.now() - lastStaleProbeAt >= STALE_PROBE_MS;

    if (probeStale) {
        lastStaleProbeAt = Date.now();

        const activeImports = new Set<string>();
        const activeAi = new Set<string>();

        for (const id of scope) {
            if (isImporting(id)) {
                activeImports.add(id);
            }
            if (isTagging(id)) {
                activeAi.add(id);
            }
        }

        // 每张表一条批量 UPDATE，替代逐相册探测
        pauseStaleImportsExcept(activeImports, albumId || undefined);
        pauseStaleAiJobsExcept(activeAi, albumId || undefined);
    }

    const views: JobView[] = [];

    if (type === undefined || type === 'import') {
        for (const { albumId: id, job } of listRecentImportJobs(limit, albumId || undefined)) {
            views.push({ ...job, type: 'import', albumId: id, albumName: nameById.get(id) ?? id });
        }
    }
    if (type === undefined || type === 'ai') {
        for (const { albumId: id, job } of listRecentAiJobs(limit, albumId || undefined)) {
            views.push({ ...job, type: 'ai', albumId: id, albumName: nameById.get(id) ?? id });
        }
    }

    // 模型下载不属于任何相册，相册任务页不展示
    if (!albumId && (type === undefined || type === 'download')) {
        const downloader = modelDownloader();
        const models = modelRegistry(settings).list();
        const modelNames = new Map(models.map(model => [model.id, model.name]));

        for (const task of downloader.listTasks()) {
            views.push({
                type: 'download',
                modelId: task.modelId,
                name: modelNames.get(task.modelId) ?? task.modelId,
                status: task.status,
                totalBytes: task.totalBytes,
                bytesDone: task.bytesDone,
                speedBps: task.speedBps,
                updatedAt: task.updatedAt,
                error: task.error,
            });
        }
    }

    const sorted = views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    cachedViews = { key: cacheKey, at: Date.now(), views: sorted };

    return sorted;
}
