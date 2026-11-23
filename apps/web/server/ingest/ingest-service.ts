import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { computeAlbumFacts, pruneOrphanDuplicates } from '../album/album-maintenance';
import { allocateSequence } from '../album/album-meta';
import { startThumbnailWarmup } from '../album/thumb-warmup';
import { getAlbum, updateAlbumStats, type AlbumContext } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import {
    createImportJob,
    findImportJob,
    findResumableImport,
    getImportJob,
    listImportJobs,
    updateImportJob,
    type ImportJobDto,
} from '../album/import-job-store';
import { assets, duplicateFiles } from '../database/schemas/album';
import { ApiError } from '../hono/problem';
import { jobsBus } from '../jobs/event-bus';
import { logger } from '../logger';
import { nowSeconds, toSeconds } from '../utils/time';
import { isPixivAssetRow, NOT_PIXIV_ASSET } from '../pixiv/ai-filter';
import { schedulePixivAutoFetch } from '../pixiv/auto-fetch';
import { schedulePixivDatabaseSync } from '../pixiv/database-sync';
import { schedulePixivLinkBackfill } from '../pixiv/link-backfill';
import type { Settings } from '../settings/setting-schema';
import { getSettings } from '../settings/setting-store';
import { sha256FileAccelerated } from '../utils/hash-pool';
import { storageForAlbum } from '../storage/registry';
import type { StoredObject } from '../storage/types';
import { importConcurrency } from '../utils/concurrency';
import { livePhotoSidecarPath } from './extractors';
import { warmSimilarityIndex } from './similarity-index';
import { storeNewAsset } from './store-asset';

// HEIC/HEIF 与 RAW 由 extractors 解码为 JPEG 预览；sharp 只处理预览/普通图片
const SUPPORTED_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'tif', 'tiff', 'bmp', 'svg',
    'heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'pef', 'srw', 'raw',
    'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
]);

const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const PERSIST_EVERY_FILES = 10;
const PERSIST_EVERY_MS = 1000;
/**
 * 大文件走「边复制边算哈希」，只读一次源文件；小文件仍在页缓存里，
 * 二次读取几乎免费，保留先哈希的路径以便重复文件在写盘前就被跳过。
 */
const SINGLE_PASS_MIN_BYTES = 8 * 1024 * 1024;

interface ImportControl {
    jobId: string
    stop: boolean
    cancel: boolean
}

const activeImports = new Map<string, ImportControl>();

interface ImportFile {
    path: string
    key: string
}

async function collectFiles(root: string): Promise<ImportFile[]> {
    const files: ImportFile[] = [];
    const sidecars = new Set<string>();
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();

        if (!current) {
            continue;
        }

        for (const entry of await readdir(current, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            if (JUNK_FILES.has(entry.name.toLowerCase())) {
                continue;
            }

            const path = join(current, entry.name);

            if (entry.isDirectory()) {
                stack.push(path);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }

            const ext = extname(entry.name).slice(1).toLowerCase();
            // Live Photo 的 MOV 属于图片资产，不能再作为独立视频导入一次；
            // 这里也覆盖 HEIC/HEIF（图片本身不支持导入，但 sidecar 也不该变成视频资产）
            const sidecar = livePhotoSidecarPath(path);

            if (sidecar) {
                sidecars.add(pathKey(sidecar));
            }

            if (!SUPPORTED_EXTENSIONS.has(ext)) {
                continue;
            }

            files.push({
                path,
                key: relative(root, path).split(sep).join('/'),
            });
        }
    }

    // 与续跑游标的 `file.key > resumeCursor` 保持同一比较方式，
    // localeCompare 会折叠大小写，导致游标定位失败并跳过后续文件
    return files
        .filter(file => !sidecars.has(pathKey(file.path)))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function pathKey(path: string): string {
    const absolute = resolve(path);

    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function isImporting(albumId: string): boolean {
    return activeImports.has(albumId);
}

export function requestImportPause(albumId: string, jobId?: string): boolean {
    const control = activeImports.get(albumId);

    if (!control || (jobId !== undefined && control.jobId !== jobId)) {
        return false;
    }

    control.stop = true;

    return true;
}

export function requestImportCancel(albumId: string, jobId?: string): boolean {
    const control = activeImports.get(albumId);

    if (!control || (jobId !== undefined && control.jobId !== jobId)) {
        return false;
    }

    control.cancel = true;
    control.stop = true;

    return true;
}

export async function startImport(
    albumId: string,
    input: { rootPath: string, resume?: boolean, resumeJobId?: string },
): Promise<ImportJobDto> {
    const settings = getSettings();
    const context = getAlbum(settings, albumId);
    const rootPath = resolve(input.rootPath.trim());

    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
        throw new ApiError(404, 'import_root_not_found', 'The import folder does not exist.');
    }

    const insideAlbum = relative(resolve(context.dir), rootPath);
    const albumRoot = resolve(context.dir);

    // 导入相册自身会遍历 storage/ 与两个数据库，产生无意义副本
    if (
        rootPath === albumRoot
        || (insideAlbum !== '' && !insideAlbum.startsWith('..') && !isAbsolute(insideAlbum))
    ) {
        throw new ApiError(
            422,
            'import_root_invalid',
            'The import folder must be outside the album directory.',
        );
    }

    if (activeImports.has(albumId)) {
        throw new ApiError(409, 'import_already_running', 'An import is already running for this album.');
    }

    let job: ImportJobDto | null = null;

    if (input.resume !== false) {
        job = input.resumeJobId
            ? findImportJob(albumId, input.resumeJobId)
            : findResumableImport(albumId, rootPath);

        // 指定 jobId 时必须续跑同一条任务，避免串到同 root 的其它历史任务
        if (input.resumeJobId && (!job || job.status !== 'paused' || job.rootPath !== rootPath)) {
            throw new ApiError(409, 'job_not_running', 'Only paused imports can be resumed.');
        }
    }

    if (!job) {
        // 崩溃残留的 running 任务先标记为 paused，避免并发导入同一相册
        for (const existing of listImportJobs(albumId, 50)) {
            if (existing.status === 'running') {
                updateImportJob(albumId, existing.id, { status: 'paused', error: 'Interrupted by a new import.' });
            }
        }

        job = createImportJob(albumId, uuidv7(), rootPath);
    }
    else {
        job = updateImportJob(albumId, job.id, { status: 'running', error: null, finishedAt: null });
    }

    const control: ImportControl = { jobId: job.id, stop: false, cancel: false };

    activeImports.set(albumId, control);

    void runImport(settings, albumId, job.id, rootPath, control)
        .catch((error: unknown) => {
            logger.error({ err: error, albumId, jobId: job.id }, 'import failed');
        })
        .finally(() => {
            activeImports.delete(albumId);
        });

    return job;
}

/** 本次任务开始后入库的未删除资产，按入库顺序返回 */
function collectAddedSince(db: AlbumDatabase, since: number): string[] {
    return db
        .select({ id: assets.id })
        .from(assets)
        .where(and(isNull(assets.deletedAt), sql`${assets.addedAt} >= ${since}`))
        .orderBy(asc(assets.addedAt), asc(assets.id))
        .all()
        .map(row => row.id);
}

function prewarmImportedAssets(
    context: AlbumContext,
    settings: Settings,
    since: number,
): void {
    const ids = collectAddedSince(context.db.album, since);

    if (ids.length === 0) {
        return;
    }

    // 后台低优先级生成最小尺寸；全量预热正在运行/暂停时不会覆盖它
    startThumbnailWarmup(settings, context, { assetIds: ids });
}

/** 本次任务开始后入库、且还没有 AI 标记的资产 */
function collectUntaggedSince(db: AlbumDatabase, since: number): string[] {
    return db
        .select({ id: assets.id, filename: assets.filename, meta: assets.meta })
        .from(assets)
        .where(and(
            isNull(assets.deletedAt),
            sql`${assets.addedAt} >= ${since}`,
            sql`json_extract(${assets.meta}, '$.ai') IS NULL`,
            NOT_PIXIV_ASSET,
        ))
        .all()
        .filter(row => !isPixivAssetRow(row))
        .map(row => row.id);
}

function publish(job: ImportJobDto, albumId: string): void {
    jobsBus.publish({
        type: 'import',
        albumId,
        jobId: job.id,
        status: job.status,
        total: job.total,
        processed: job.processed,
        added: job.added,
        duplicates: job.duplicates,
        skipped: job.skipped,
        errors: job.errors,
        updatedAt: job.updatedAt,
    });
}

function syncAlbumIndex(settings: Settings, albumId: string, db: AlbumDatabase): void {
    const current = getAlbum(settings, albumId);
    const facts = computeAlbumFacts(db, current.index.coverAssetId);

    updateAlbumStats(settings, albumId, facts);
    pruneOrphanDuplicates(db);
}

async function runImport(
    settings: Settings,
    albumId: string,
    jobId: string,
    rootPath: string,
    control: ImportControl,
): Promise<void> {
    const context = getAlbum(settings, albumId);
    // 长导入期间不会反复调用 albumDatabase()，必须持租约防止空闲巡检关闭连接
    const lease = leaseAlbumDatabase(context.dir);

    try {
        await runImportWithLease(settings, albumId, jobId, rootPath, control, context, lease.handle.album);
    }
    finally {
        lease.release();
    }
}

async function runImportWithLease(
    settings: Settings,
    albumId: string,
    jobId: string,
    rootPath: string,
    control: ImportControl,
    context: AlbumContext,
    db: AlbumDatabase,
): Promise<void> {
    const files = await collectFiles(rootPath);
    const storage = storageForAlbum(context.dir, settings);
    // 现有资产的体积集合：尺寸不冲突时不可能重复，大文件因此可以边复制边哈希
    const knownSizes = new Set<number>(
        db.select({ size: assets.size }).from(assets).all().map(row => row.size),
    );
    const initial = getImportJob(albumId, jobId);
    const resumeCursor = initial.cursor ?? '';
    const startIndex = resumeCursor === '' ? 0 : files.findIndex(file => file.key > resumeCursor);
    let processed = initial.processed;
    let added = initial.added;
    let duplicates = initial.duplicates;
    let skipped = initial.skipped;
    let errors = initial.errors;
    let lastPersist = Date.now();

    // 并发处理时 cursor 只推进到连续完成的最后一个文件，断点续导才不会漏文件
    let nextIndex = startIndex < 0 ? files.length : startIndex;
    let contiguous = nextIndex;
    let cursor = resumeCursor;
    const completed = new Set<number>();

    let job = updateImportJob(albumId, jobId, {
        status: 'running',
        total: files.length,
        processed,
        added,
        duplicates,
        skipped,
        errors,
        cursor: resumeCursor === '' ? null : resumeCursor,
    });

    publish(job, albumId);

    const advanceCursor = (fileIndex: number): void => {
        completed.add(fileIndex);

        while (completed.has(contiguous)) {
            contiguous += 1;
        }

        cursor = contiguous === 0 ? '' : files[contiguous - 1]?.key ?? '';
    };

    const persist = (): void => {
        job = updateImportJob(albumId, jobId, {
            total: files.length,
            processed,
            added,
            duplicates,
            skipped,
            errors,
            cursor: cursor === '' ? null : cursor,
        });
        publish(job, albumId);
        lastPersist = Date.now();
    };

    const recordDuplicate = (assetId: string, file: ImportFile, size: number, sha256: string): boolean => {
        const result = db.insert(duplicateFiles).values({
            id: uuidv7(),
            assetId,
            sourcePath: file.path,
            filename: basename(file.path),
            size,
            sha256,
            foundAt: nowSeconds(),
        }).onConflictDoNothing().run();

        return Number(result.changes ?? 0) > 0;
    };

    const ingestNew = async (
        file: ImportFile,
        size: number,
        sha256: string,
        preStored: StoredObject | null,
    ): Promise<string | null> => {
        const result = await storeNewAsset({
            settings,
            albumDir: context.dir,
            db,
            filePath: file.path,
            sha256,
            size,
            stored: preStored ?? undefined,
        });

        if (result.skipped) {
            skipped += 1;

            return null;
        }

        // 缩略图不在导入热路径生成：网格/封面首次请求时按需解码，避免为不看图片付全部成本
        return result.assetId;
    };

    const discardPreStored = async (stored: StoredObject | null): Promise<void> => {
        if (stored) {
            await storage.delete(stored.key).catch(() => undefined);
        }
    };

    // 并发时同内容文件可能同时通过重复检查：后到的等首个文件入库后再记为重复。
    // owner 失败要让 follower 也感知（计入 errors），否则一次瞬时错误会被当成
    // 合法跳过、游标照常推进、断点续导永不再试 —— 永久丢图。
    type IngestOutcome = { assetId: string | null, failed: boolean };
    const pendingBySha = new Map<string, Promise<IngestOutcome>>();

    // 返回值表示该文件下标是否可视为「已完成、无需重试」：
    // owner/follower 失败时返回 false，游标便停在连续成功边界之前。
    const ingestFile = async (file: ImportFile): Promise<boolean> => {
        let preStored: StoredObject | null = null;

        try {
            const info = statSync(file.path);

            if (info.size === 0) {
                skipped += 1;

                return true;
            }

            let sha256: string;

            // 库内没有同尺寸资产时不可能重复：大文件直接边复制边算哈希，只读一次源文件
            if (
                info.size >= SINGLE_PASS_MIN_BYTES
                && !knownSizes.has(info.size)
                && storage.putWithHash
            ) {
                const copied = await storage.putWithHash({
                    sequence: allocateSequence(db),
                    ext: extname(file.path).slice(1).toLowerCase(),
                    sourcePath: file.path,
                });

                sha256 = copied.sha256;
                preStored = { key: copied.key, size: copied.size };
            }
            else {
                sha256 = await sha256FileAccelerated(file.path);
            }

            knownSizes.add(info.size);

            // 回收站里的内容也算重复：否则同一文件重新导入会再复制一份
            const duplicate = db
                .select({ id: assets.id })
                .from(assets)
                .where(eq(assets.sha256, sha256))
                .get();

            if (duplicate) {
                await discardPreStored(preStored);
                preStored = null;

                if (recordDuplicate(duplicate.id, file, info.size, sha256)) {
                    duplicates += 1;
                }

                return true;
            }

            const pending = pendingBySha.get(sha256);

            if (pending) {
                const outcome = await pending;

                // 同批次已有同内容文件在飞：本份副本没有行引用，直接丢弃
                await discardPreStored(preStored);
                preStored = null;

                if (outcome.failed) {
                    // owner 没成功入库：本文件也当作失败，留待断点续导重试
                    errors += 1;

                    return false;
                }
                if (outcome.assetId) {
                    if (recordDuplicate(outcome.assetId, file, info.size, sha256)) {
                        duplicates += 1;
                    }
                }
                else {
                    skipped += 1;
                }

                return true;
            }

            let settle: (outcome: IngestOutcome) => void = () => undefined;
            const owner = new Promise<IngestOutcome>((resolve) => {
                settle = resolve;
            });

            pendingBySha.set(sha256, owner);

            let outcome: IngestOutcome = { assetId: null, failed: true };

            try {
                // ingestNew 正常返回 null 表示「不支持的类型，合法跳过」，不是失败
                const assetId = await ingestNew(file, info.size, sha256, preStored);

                // 副本所有权已交给 storeNewAsset（失败时由它清理）
                preStored = null;
                outcome = { assetId, failed: false };

                if (assetId) {
                    added += 1;
                }

                return true;
            }
            finally {
                settle(outcome);
                pendingBySha.delete(sha256);
            }
        }
        catch (error) {
            await discardPreStored(preStored);
            errors += 1;
            logger.warn({ err: error, file: file.path, albumId }, 'failed to ingest file');

            return false;
        }
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            if (control.stop) {
                return;
            }

            const fileIndex = nextIndex;

            if (fileIndex >= files.length) {
                return;
            }

            nextIndex += 1;

            const file = files[fileIndex];

            if (file) {
                const resolved = await ingestFile(file);

                // 失败的文件不标记完成，游标只推进到连续成功边界，续导才会重试它
                if (resolved) {
                    advanceCursor(fileIndex);
                }
            }
            else {
                advanceCursor(fileIndex);
            }

            processed += 1;

            if (processed % PERSIST_EVERY_FILES === 0 || Date.now() - lastPersist > PERSIST_EVERY_MS) {
                persist();
            }
        }
    };

    const workers = Math.max(1, Math.min(importConcurrency(), files.length - nextIndex));

    try {
        await Promise.all(Array.from({ length: workers }, () => worker()));

        if (control.stop) {
            // cursor 已只推进到连续成功边界；失败文件留在边界之后，续导会重试
            job = updateImportJob(albumId, jobId, {
                status: control.cancel ? 'cancelled' : 'paused',
                total: files.length,
                processed,
                added,
                duplicates,
                skipped,
                errors,
                cursor: cursor === '' ? null : cursor,
                finishedAt: control.cancel ? nowSeconds() : null,
            });

            syncAlbumIndex(settings, albumId, db);
            publish(job, albumId);
            warmSimilarityIndex(albumId);
            prewarmImportedAssets(context, settings, toSeconds(initial.startedAt) ?? 0);

            return;
        }

        const now = nowSeconds();

        job = updateImportJob(albumId, jobId, {
            status: 'completed',
            total: files.length,
            processed,
            added,
            duplicates,
            skipped,
            errors,
            cursor: null,
            finishedAt: now,
        });

        syncAlbumIndex(settings, albumId, db);
        publish(job, albumId);
        warmSimilarityIndex(albumId);
        prewarmImportedAssets(context, settings, toSeconds(initial.startedAt) ?? 0);

        if (context.index.settings.pixivEnabled) {
            // 文件名映射已在入库时写入；补齐历史资产映射，后台补全详情并汇总全局 pixiv.db
            schedulePixivLinkBackfill(albumId);
            schedulePixivAutoFetch(albumId, { force: true });
            schedulePixivDatabaseSync(0);
        }

        const autoTag = getAlbum(settings, albumId).index.settings.autoTag ?? settings.ai.autoTag;
        // 按任务开始时间推导，暂停/续导也不会漏掉暂停前已入库的资产
        const untagged = autoTag ? collectUntaggedSince(db, toSeconds(initial.startedAt) ?? 0) : [];

        if (untagged.length > 0) {
            void import('../ai/tagging-service')
                .then(module => module.startTagging(albumId, {
                    assetIds: untagged,
                    mode: settings.ai.labelMode,
                }))
                .catch((error: unknown) => {
                    logger.warn({ err: error, albumId }, 'auto tagging failed to start');
                });
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        job = updateImportJob(albumId, jobId, {
            status: 'failed',
            error: message,
            total: files.length,
            processed,
            added,
            duplicates,
            skipped,
            errors,
            finishedAt: nowSeconds(),
        });

        // 中途失败时已入库的资产也必须同步回 index.json，否则资产数/封面长期偏小，
        // 而 reconciledDirs 让同进程不再对账，缺口不会自愈
        try {
            syncAlbumIndex(settings, albumId, db);
        }
        catch (syncError: unknown) {
            logger.warn({ err: syncError, albumId }, 'failed to sync album index after import error');
        }

        prewarmImportedAssets(context, settings, toSeconds(initial.startedAt) ?? 0);

        publish(job, albumId);
        throw error;
    }
}
