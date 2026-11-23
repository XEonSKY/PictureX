import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createAiJob, getAiJob, updateAiJob, type AiJobDto } from '../album/ai-job-store';
import { assertAlbumRegistered, getAlbum, type AlbumContext, type TagRecord } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import { assets, assetTags } from '../database/schemas/album';
import { getAssetRow, parseMeta } from '../domain/asset-query';
import { ApiError } from '../hono/problem';
import { jobsBus } from '../jobs/event-bus';
import { logger } from '../logger';
import { nowSeconds } from '../utils/time';
import { isPixivAssetRow, NOT_PIXIV_ASSET } from '../pixiv/ai-filter';
import type { Settings } from '../settings/setting-schema';
import { getSettings } from '../settings/setting-store';
import { storageForAlbum } from '../storage/registry';
import { tagNameKey } from '../tags/tag-file';
import { insertTagRecord, listTagRecords } from '../tags/tag-store';
import { createTagger, MAX_ZERO_SHOT_LABELS, PipelineLoadError, requireLocalModel, type AiMode, type TagResult } from './tagger';

interface TagControl {
    jobId: string
    stop: boolean
    cancel: boolean
    remaining: string[]
}

interface PausedPlan {
    jobId: string
    remaining: string[]
}

const activeAlbums = new Map<string, TagControl>();
const pausedJobs = new Map<string, PausedPlan>();
const PERSIST_EVERY = 5;
const PERSIST_EVERY_MS = 1000;

export interface StartTaggingInput {
    mode?: AiMode
    assetIds?: string[]
    /** 不传则打标相册内全部资产 */
    limit?: number
}

function publish(job: AiJobDto, albumId: string): void {
    jobsBus.publish({
        type: 'ai',
        albumId,
        jobId: job.id,
        status: job.status,
        total: job.total,
        processed: job.processed,
        errors: job.errors,
        updatedAt: job.updatedAt,
    });
}

const AI_CONCURRENCY = 4;
const TAG_FLUSH_EVERY = 25;

function createTagIndex(context: AlbumContext): {
    resolve: (names: string[]) => TagRecord[]
    flush: () => void
} {
    const db = context.db.tags;
    const byName = new Map(listTagRecords(db).map(tag => [tagNameKey(tag.name), tag]));
    // 任务自己新建并已成功落盘的标签：若之后被用户删除，下次 flush 不得再写回
    const taskAuthored = new Set<string>();
    const pending = new Set<string>();

    return {
        resolve(names: string[]): TagRecord[] {
            const records: TagRecord[] = [];

            for (const raw of names) {
                const name = raw.trim().slice(0, 60);

                if (name === '') {
                    continue;
                }

                const key = tagNameKey(name);
                let tag = byName.get(key);

                if (!tag) {
                    tag = {
                        id: uuidv7(),
                        name,
                        color: '',
                        createdAt: new Date().toISOString(),
                    };
                    byName.set(key, tag);
                    pending.add(key);
                }

                if (!records.some(item => item.id === tag.id)) {
                    records.push(tag);
                }
            }

            return records;
        },
        flush(): void {
            if (pending.size === 0) {
                return;
            }

            // 重新读一次再合并，避免覆盖用户并发新建/重命名的标签
            const current = listTagRecords(db);
            const names = new Set(current.map(tag => tagNameKey(tag.name)));
            const ids = new Set(current.map(tag => tag.id));

            for (const key of [...pending]) {
                const tag = byName.get(key);

                if (!tag) {
                    pending.delete(key);

                    continue;
                }

                // 已在主数据里（初始、用户新建或任务上一轮已写入）：跳过
                if (ids.has(tag.id) || names.has(key)) {
                    pending.delete(key);
                    taskAuthored.add(tag.id);

                    continue;
                }

                // 任务之前写过、但当前已不在：用户删掉了它，从内存索引移除且不再写回
                if (taskAuthored.has(tag.id)) {
                    byName.delete(key);
                    pending.delete(key);

                    continue;
                }

                if (insertTagRecord(db, tag)) {
                    ids.add(tag.id);
                    names.add(key);
                    taskAuthored.add(tag.id);
                }

                pending.delete(key);
            }
        },
    };
}

export function isTagging(albumId: string): boolean {
    return activeAlbums.has(albumId);
}

function resolveMode(settings: Settings, requested: AiMode | undefined): AiMode {
    const mode = requested ?? settings.ai.labelMode;

    if (mode === 'external') {
        if (!settings.ai.external.enabled || settings.ai.external.baseUrl.trim() === '' || settings.ai.external.model.trim() === '') {
            throw new ApiError(422, 'ai_external_disabled', 'The external tagging endpoint is not configured.');
        }

        return mode;
    }

    requireLocalModel(settings, mode);

    return mode;
}

function selectAssetIds(
    db: AlbumDatabase,
    input: StartTaggingInput,
): string[] {
    if (input.assetIds && input.assetIds.length > 0) {
        const ids: string[] = [];

        // SQLite 变量数有上限，按块查询；自动打标可能一次传入全部新增资产
        for (let index = 0; index < input.assetIds.length; index += 500) {
            const chunk = input.assetIds.slice(index, index + 500);

            ids.push(...db
                .select({ id: assets.id, filename: assets.filename, meta: assets.meta })
                .from(assets)
                .where(and(
                    inArray(assets.id, chunk),
                    isNull(assets.deletedAt),
                    NOT_PIXIV_ASSET,
                ))
                .all()
                .filter(row => !isPixivAssetRow(row))
                .map(row => row.id));
        }

        return ids;
    }

    const rows = db
        .select({ id: assets.id, filename: assets.filename, meta: assets.meta })
        .from(assets)
        .where(and(isNull(assets.deletedAt), NOT_PIXIV_ASSET))
        .orderBy(desc(assets.addedAt))
        .all()
        .filter(row => !isPixivAssetRow(row))
        .map(row => row.id);

    return input.limit !== undefined ? rows.slice(0, input.limit) : rows;
}

/** 恢复时没有内存队列（例如进程重启），把还没有 ai 标记的资产重新纳入 */
function collectUntagged(db: AlbumDatabase): string[] {
    return db
        .select({ id: assets.id, filename: assets.filename, meta: assets.meta })
        .from(assets)
        .where(and(
            sql`json_extract(${assets.meta}, '$.ai') IS NULL`,
            isNull(assets.deletedAt),
            NOT_PIXIV_ASSET,
        ))
        .orderBy(desc(assets.addedAt))
        .all()
        .filter(row => !isPixivAssetRow(row))
        .map(row => row.id);
}

export async function startTagging(albumId: string, input: StartTaggingInput = {}): Promise<AiJobDto> {
    const settings = getSettings();
    const context = getAlbum(settings, albumId);
    const mode = resolveMode(settings, input.mode);

    if (activeAlbums.has(albumId) || pausedJobs.has(albumId)) {
        throw new ApiError(409, 'ai_already_running', 'An AI tagging job is already running or paused for this album.');
    }

    const db = context.db.album;
    const assetIds = selectAssetIds(db, input);
    const total = assetIds.length;
    const jobId = uuidv7();
    let job = createAiJob(albumId, jobId, mode, total);

    publish(job, albumId);

    if (total === 0) {
        job = updateAiJob(albumId, jobId, {
            status: 'completed',
            finishedAt: nowSeconds(),
        });
        publish(job, albumId);

        return job;
    }

    const control: TagControl = { jobId, stop: false, cancel: false, remaining: [] };

    activeAlbums.set(albumId, control);

    void runTagging(settings, albumId, jobId, mode, assetIds, control, { processed: 0, errors: 0 })
        .catch((error: unknown) => {
            logger.error({ err: error, albumId, jobId }, 'ai tagging failed');
        })
        .finally(() => {
            activeAlbums.delete(albumId);
        });

    return job;
}

export function pauseTagging(albumId: string, jobId: string): AiJobDto {
    assertAlbumRegistered(getSettings(), albumId);

    getAiJob(albumId, jobId);
    const control = activeAlbums.get(albumId);

    if (!control || control.jobId !== jobId) {
        throw new ApiError(409, 'job_not_running', 'The AI job is not running.');
    }

    control.stop = true;

    // 立即落库，UI 不必等 4 路在途推理结束才看到「已暂停」
    const paused = updateAiJob(albumId, jobId, { status: 'paused', finishedAt: null });
    publish(paused, albumId);

    return paused;
}

export function cancelTagging(albumId: string, jobId: string): AiJobDto {
    assertAlbumRegistered(getSettings(), albumId);
    const job = getAiJob(albumId, jobId);
    const control = activeAlbums.get(albumId);

    if (control && control.jobId === jobId) {
        control.cancel = true;
        control.stop = true;
        pausedJobs.delete(albumId);

        const cancelled = updateAiJob(albumId, jobId, {
            status: 'cancelled',
            finishedAt: nowSeconds(),
        });
        publish(cancelled, albumId);

        return cancelled;
    }

    const paused = pausedJobs.get(albumId);

    if (paused?.jobId === jobId) {
        pausedJobs.delete(albumId);
    }

    if (job.status === 'paused' || job.status === 'running') {
        const cancelled = updateAiJob(albumId, jobId, {
            status: 'cancelled',
            finishedAt: nowSeconds(),
        });

        publish(cancelled, albumId);

        return cancelled;
    }

    throw new ApiError(409, 'job_not_running', 'The AI job is not running.');
}

export function resumeTagging(albumId: string, jobId: string): AiJobDto {
    const settings = getSettings();
    const context = getAlbum(settings, albumId);
    const db = context.db.album;
    const job = getAiJob(albumId, jobId);

    if (activeAlbums.has(albumId)) {
        throw new ApiError(409, 'ai_already_running', 'An AI tagging job is already running for this album.');
    }

    if (job.status !== 'paused') {
        throw new ApiError(409, 'job_not_running', 'The AI job is not paused.');
    }

    const plan = pausedJobs.get(albumId);
    const remaining = plan?.jobId === jobId ? plan.remaining : collectUntagged(db);
    const mode = job.mode as AiMode;

    pausedJobs.delete(albumId);

    if (remaining.length === 0) {
        const completed = updateAiJob(albumId, jobId, {
            status: 'completed',
            finishedAt: nowSeconds(),
        });

        publish(completed, albumId);

        return completed;
    }

    const resumed = updateAiJob(albumId, jobId, {
        status: 'running',
        total: job.processed + remaining.length,
        error: null,
        finishedAt: null,
    });
    const control: TagControl = { jobId, stop: false, cancel: false, remaining: [] };

    activeAlbums.set(albumId, control);
    publish(resumed, albumId);

    void runTagging(settings, albumId, jobId, mode, remaining, control, {
        processed: job.processed,
        errors: job.errors,
    })
        .catch((error: unknown) => {
            logger.error({ err: error, albumId, jobId }, 'ai tagging resume failed');
        })
        .finally(() => {
            activeAlbums.delete(albumId);
        });

    return resumed;
}

async function runTagging(
    settings: Settings,
    albumId: string,
    jobId: string,
    mode: AiMode,
    assetIds: string[],
    control: TagControl,
    start: { processed: number, errors: number },
): Promise<void> {
    const context = getAlbum(settings, albumId);
    // 打标可能持续数分钟，持租约避免空闲巡检关闭相册连接
    const lease = leaseAlbumDatabase(context.dir);

    try {
        await runTaggingWithLease(settings, albumId, jobId, mode, assetIds, control, start, context, lease.handle.album);
    }
    finally {
        lease.release();
    }
}

async function runTaggingWithLease(
    settings: Settings,
    albumId: string,
    jobId: string,
    mode: AiMode,
    assetIds: string[],
    control: TagControl,
    start: { processed: number, errors: number },
    context: AlbumContext,
    db: AlbumDatabase,
): Promise<void> {
    const storage = storageForAlbum(context.dir, settings);
    const tagger = createTagger(settings, mode);
    const tagIndex = createTagIndex(context);
    // 零样本优先使用相册已有标签（按使用频率取前 64 个），没有标签时回退内置候选
    const usage = new Map(
        db
            .select({ tagId: assetTags.tagId, uses: count() })
            .from(assetTags)
            .groupBy(assetTags.tagId)
            .all()
            .map(row => [row.tagId, Number(row.uses)]),
    );
    const existingLabels = listTagRecords(context.db.tags)
        .map(tag => ({ name: tag.name, uses: usage.get(tag.id) ?? 0 }))
        .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        .slice(0, MAX_ZERO_SHOT_LABELS)
        .map(tag => tag.name);
    let processed = start.processed;
    let errors = start.errors;
    let firstError = '';
    const failure: { fatal: PipelineLoadError | null } = { fatal: null };
    let lastPersist = Date.now();
    let writeChain: Promise<void> = Promise.resolve();
    let writesSinceFlush = 0;
    let job = updateAiJob(albumId, jobId, { status: 'running' });

    publish(job, albumId);

    const persist = (): void => {
        job = updateAiJob(albumId, jobId, { processed, errors });
        publish(job, albumId);
        lastPersist = Date.now();
    };

    // 推理并发跑，写入按顺序串行；新建标签每 25 张图落库一次
    const enqueueWrite = (row: ReturnType<typeof getAssetRow>, result: TagResult): Promise<void> => {
        writeChain = writeChain
            .then(() => {
                // 取消后不再落库，避免在途推理把已取消任务的标签写进去
                if (control.cancel) {
                    return;
                }

                const tags = tagIndex.resolve(result.labels.map(label => label.name));

                for (const tag of tags) {
                    db.insert(assetTags)
                        .values({ assetId: row.id, tagId: tag.id })
                        .onConflictDoNothing()
                        .run();
                }

                const meta = parseMeta(row.meta);

                meta.ai = {
                    mode: result.mode,
                    modelId: result.modelId,
                    device: result.device,
                    labels: result.labels,
                    caption: result.caption ?? null,
                    taggedAt: new Date().toISOString(),
                };

                db.update(assets).set({ meta: JSON.stringify(meta) }).where(eq(assets.id, row.id)).run();

                writesSinceFlush += 1;

                if (writesSinceFlush >= TAG_FLUSH_EVERY) {
                    tagIndex.flush();
                    writesSinceFlush = 0;
                }
            })
            // 单张写库失败只影响这一张；保持链路 resolved，后续图片继续落库
            .catch((error: unknown) => {
                errors += 1;

                if (firstError === '') {
                    firstError = error instanceof Error ? error.message : String(error);
                }
            });

        return writeChain;
    };

    const handleAsset = async (assetId: string): Promise<void> => {
        try {
            const row = getAssetRow(db, assetId);
            const path = storage.localPath(row.storageKey);

            if (!path) {
                throw new Error(`asset ${assetId} is not on local storage`);
            }

            const result = await tagger.tag({ path, mime: row.mime }, { labels: existingLabels });

            await enqueueWrite(row, result);
        }
        catch (error) {
            if (error instanceof PipelineLoadError) {
                // 模型本身加载不了，后面每张都会失败：直接终止任务
                failure.fatal = error;
            }
            else {
                errors += 1;

                if (firstError === '') {
                    firstError = error instanceof Error ? error.message : String(error);
                }

                logger.warn({ err: error, albumId, assetId }, 'failed to tag asset');
            }
        }
    };

    let nextIndex = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            if (control.stop || failure.fatal) {
                return;
            }

            const index = nextIndex;

            if (index >= assetIds.length) {
                return;
            }

            nextIndex += 1;

            const assetId = assetIds[index];

            if (assetId) {
                await handleAsset(assetId);
            }

            processed += 1;

            if (processed % PERSIST_EVERY === 0 || Date.now() - lastPersist > PERSIST_EVERY_MS) {
                persist();
            }
        }
    };

    try {
        const workers = Math.max(1, Math.min(AI_CONCURRENCY, assetIds.length));

        await Promise.all(Array.from({ length: workers }, () => worker()));
        await writeChain;
        tagIndex.flush();

        if (failure.fatal) {
            job = updateAiJob(albumId, jobId, {
                status: 'failed',
                processed,
                errors,
                error: failure.fatal.message,
                finishedAt: nowSeconds(),
            });
            publish(job, albumId);

            return;
        }

        if (control.stop) {
            control.remaining = assetIds.slice(nextIndex);

            if (control.cancel) {
                pausedJobs.delete(albumId);
                job = updateAiJob(albumId, jobId, {
                    status: 'cancelled',
                    processed,
                    errors,
                    finishedAt: nowSeconds(),
                });
            }
            else {
                pausedJobs.set(albumId, { jobId, remaining: control.remaining });
                job = updateAiJob(albumId, jobId, {
                    status: 'paused',
                    processed,
                    errors,
                    finishedAt: null,
                });
            }

            publish(job, albumId);

            return;
        }

        // 全部失败说明模型或推理链路本身有问题，不能报 completed 掩盖
        job = updateAiJob(albumId, jobId, {
            status: errors > 0 && errors === processed ? 'failed' : 'completed',
            processed,
            errors,
            error: errors > 0 && errors === processed ? firstError : null,
            finishedAt: nowSeconds(),
        });
        publish(job, albumId);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await writeChain.catch(() => undefined);
        tagIndex.flush();

        job = updateAiJob(albumId, jobId, {
            status: 'failed',
            processed,
            errors,
            error: message,
            finishedAt: nowSeconds(),
        });
        publish(job, albumId);
        throw error;
    }
}
