import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { getAlbum, listAlbumSummaries } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase, type AlbumDbHandle } from '../database/album';
import { assets, pixivAssetLinks, pixivFetchMarks } from '../database/schemas/album';
import { ApiError } from '../hono/problem';
import { logger } from '../logger';
import { getSettings, updateSettings } from '../settings/setting-store';
import type { Settings } from '../settings/setting-schema';
import { PixivRateLimitError } from './api';
import { pixivRatePenaltyFactor } from './rate-limit';
import { parsePixivFilename } from './filename';
import {
    listFreshGlobalPixivIllustIds,
    listFreshPixivIllustIds,
    listGlobalInvalidPixivIllustIds,
    markGlobalPixivIllustInvalid,
    readGlobalPixivIllust,
} from './global-cache';
import { listInvalidPixivIllustIds, markPixivIllustInvalid } from '../database/pixiv';
import { getCachedIllust } from './store';
import { cutoffSeconds } from '../utils/time';
import { getAssetPixivContext, PIXIV_CACHE_TTL_MS } from './sync-service';
import type { AssetPixivContextDto } from './types';
import type {
    PixivAutoFetchAlbumStatusDto,
    PixivAutoFetchSpeed,
    PixivAutoFetchStatusDto,
    PixivAutoFetchTriggerResult,
} from '../../shared/pixiv';

/**
 * Pixiv 相册后台补全作品信息：
 * - 单线程串行，每个需要联网的作品之间随机间隔 100–1000ms，避免高频请求被识别为爬取；
 * - 已有 7 天内缓存（相册或全局）直接跳过/回填，不产生网络请求也不占用间隔；
 * - 只拉元数据与同步标签，不自动下载缺失分P；
 * - 相册关闭 Pixiv 或删除时在下一次作品检查处停止。
 */

export const PIXIV_AUTO_FETCH_DELAYS: Record<PixivAutoFetchSpeed, { min: number, max: number }> = {
    slow: { min: 1000, max: 3000 },
    normal: { min: 100, max: 1000 },
    fast: { min: 50, max: 300 },
};
const SCHEDULE_COOLDOWN_MS = 5 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
/** 失败作品 30 分钟内不再重复检查；404/不可见作品记 missing 并永久跳过 */
const FAILED_MARK_RETRY_MS = 30 * 60_000;
/** 断点只用于跳过「刚补全过」的作品：成功的 done 标记超过元数据缓存期后无意义 */
const DONE_MARK_TTL_MS = PIXIV_CACHE_TTL_MS;
const FAILED_MARK_TTL_MS = 24 * 60 * 60_000;
const PROGRESS_EVERY = 25;
/** 限流时至少等 1 分钟、最多 30 分钟；连续失败暂停后 2 分钟自动重试 */
const MIN_RATE_LIMIT_RETRY_MS = 60_000;
const MAX_RATE_LIMIT_RETRY_MS = 30 * 60_000;
const CONSECUTIVE_FAILURE_RETRY_MS = 2 * 60_000;
/** 每发起 N 次真实网络请求后主动休息，避免长时间高频请求触发限流 */
const NETWORK_BATCH_SIZE = 60;
const NETWORK_BATCH_PAUSE_MS = 15_000;

export interface PixivWorkRef {
    illustId: string
    /** 用于拉取元数据的本地分P（优先选择页码最小的分P） */
    assetId: string
    pageIndex: number
    addedAt: number
}

interface PixivWorkCandidate {
    work: PixivWorkRef
    cache: { albumFresh: boolean, globalFresh: boolean }
}

/** 从当前相册的未删除资产中按作品去重；显式 pixiv_asset_links 优先于文件名识别 */
export function collectPixivWorks(db: AlbumDatabase): PixivWorkRef[] {
    const rows = db
        .select({ id: assets.id, filename: assets.filename, addedAt: assets.addedAt })
        .from(assets)
        .where(isNull(assets.deletedAt))
        .orderBy(desc(assets.addedAt))
        .all();
    const links = db
        .select({
            assetId: pixivAssetLinks.assetId,
            illustId: pixivAssetLinks.illustId,
            pageIndex: pixivAssetLinks.pageIndex,
        })
        .from(pixivAssetLinks)
        .all();
    const linked = new Map(links.map(link => [link.assetId, link]));
    const works = new Map<string, PixivWorkRef>();

    for (const row of rows) {
        const explicit = linked.get(row.id);
        const ref = explicit ?? parsePixivFilename(row.filename);

        if (!ref) {
            continue;
        }

        const existing = works.get(ref.illustId);

        if (!existing) {
            works.set(ref.illustId, {
                illustId: ref.illustId,
                assetId: row.id,
                pageIndex: ref.pageIndex,
                addedAt: row.addedAt,
            });
        }
        else if (ref.pageIndex < existing.pageIndex) {
            existing.assetId = row.id;
            existing.pageIndex = ref.pageIndex;
        }
    }

    return [...works.values()].sort((left, right) => (
        right.addedAt - left.addedAt || left.illustId.localeCompare(right.illustId)
    ));
}

export interface PixivAutoFetchDeps {
    settings: () => Settings
    now: () => number
    random: () => number
    sleep: (ms: number) => Promise<void>
    fetchContext: (settings: Settings, albumId: string, assetId: string) => Promise<AssetPixivContextDto>
    scheduleRetry: (albumId: string, delayMs: number) => void
    /** 用户手动“立即补全”时忽略失败/失效作品的冷却断点 */
    ignoreMarkCooldown: boolean
}

const DEFAULT_DEPS: PixivAutoFetchDeps = {
    settings: getSettings,
    now: Date.now,
    random: Math.random,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    fetchContext: getAssetPixivContext,
    scheduleRetry: (albumId, delayMs) => schedulePixivAutoFetchRetry(albumId, delayMs),
    ignoreMarkCooldown: false,
};

/** 按速度档位生成随机间隔（含两端） */
export function nextPixivDelay(
    random: () => number = Math.random,
    speed: PixivAutoFetchSpeed = 'normal',
): number {
    const range = PIXIV_AUTO_FETCH_DELAYS[speed] ?? PIXIV_AUTO_FETCH_DELAYS.normal;
    const value = Math.min(0.999999, Math.max(0, random()));

    return range.min + Math.floor(value * (range.max - range.min + 1));
}

export interface PixivAutoFetchSummary {
    albumId: string
    works: number
    /** 本次实际发起网络请求的作品数 */
    network: number
    /** 使用其它相册/查看器全局缓存回填的作品数 */
    backfilled: number
    /** 命中 7 天缓存直接跳过 */
    fresh: number
    /** 拉取失败的作品数 */
    failed: number
    /** 已被删除/不可用的作品数，不计入连续失败 */
    deleted: number
    /** 未配置 Token 且无缓存而跳过的作品数 */
    noToken: number
    authRequired: boolean
    tokenMissing: boolean
    skipped: boolean
    rateLimited: boolean
    retryAfterMs: number
    stoppedReason: string
    elapsedMs: number
}

function isFresh(fetchedAt: number | null | undefined, now: number): boolean {
    return typeof fetchedAt === 'number'
      && Number.isFinite(fetchedAt)
      && fetchedAt > 0
      && now - fetchedAt * 1000 < PIXIV_CACHE_TTL_MS;
}

function cacheState(handle: AlbumDbHandle, illustId: string, now: number): { albumFresh: boolean, globalFresh: boolean } {
    const album = getCachedIllust(handle.pixiv, illustId);
    let global: ReturnType<typeof readGlobalPixivIllust>;

    try {
        global = readGlobalPixivIllust(illustId);
    }
    catch {
        global = null;
    }

    return {
        albumFresh: isFresh(album?.fetchedAt, now),
        globalFresh: isFresh(global?.fetchedAt, now),
    };
}

function readCacheState(contextDir: string, illustId: string, now: number): { albumFresh: boolean, globalFresh: boolean } {
    const lease = leaseAlbumDatabase(contextDir);

    try {
        return cacheState(lease.handle, illustId, now);
    }
    finally {
        lease.release();
    }
}

type PixivFetchMarkStatus = 'done' | 'missing' | 'failed';

interface PixivFetchMark {
    status: PixivFetchMarkStatus
    attemptedAt: number
}

function loadFetchMarksFrom(db: AlbumDatabase): Map<string, PixivFetchMark> {
    return new Map(db
        .select()
        .from(pixivFetchMarks)
        .all()
        .map(row => [row.illustId, {
            status: row.status as PixivFetchMarkStatus,
            attemptedAt: row.attemptedAt,
        }]));
}

/**
 * 裁剪过期断点：done 只在元数据缓存期内有意义，failed 冷却期过后也会重新尝试。
 * missing 永久保留（已失效作品不该被重新入队）。
 */
function pruneFetchMarks(db: AlbumDatabase, nowMs: number): number {
    const now = Math.floor(nowMs / 1000);
    const staleDone = db.delete(pixivFetchMarks)
        .where(and(
            eq(pixivFetchMarks.status, 'done'),
            lt(pixivFetchMarks.attemptedAt, now - Math.floor(DONE_MARK_TTL_MS / 1000)),
        ))
        .run();
    const staleFailed = db.delete(pixivFetchMarks)
        .where(and(
            eq(pixivFetchMarks.status, 'failed'),
            lt(pixivFetchMarks.attemptedAt, now - Math.floor(FAILED_MARK_TTL_MS / 1000)),
        ))
        .run();

    return Number(staleDone.changes ?? 0) + Number(staleFailed.changes ?? 0);
}

function saveFetchMark(
    contextDir: string,
    illustId: string,
    status: PixivFetchMarkStatus,
    attemptedAtMs: number,
): void {
    const attemptedAt = Math.floor(attemptedAtMs / 1000);
    const lease = leaseAlbumDatabase(contextDir);

    try {
        lease.handle.album
            .insert(pixivFetchMarks)
            .values({ illustId, status, attemptedAt })
            .onConflictDoUpdate({
                target: pixivFetchMarks.illustId,
                set: { status, attemptedAt },
            })
            .run();
    }
    catch (err) {
        logger.warn({ err, illustId }, 'pixiv auto fetch mark could not be saved');
    }
    finally {
        lease.release();
    }
}

function markInvalid(contextDir: string, illustId: string, attemptedAtMs: number): void {
    const invalidAt = Math.floor(attemptedAtMs / 1000);
    const lease = leaseAlbumDatabase(contextDir);

    try {
        markPixivIllustInvalid(lease.handle.pixiv.$client, illustId, invalidAt);
    }
    catch (err) {
        logger.warn({ err, illustId }, 'pixiv invalid mark could not be saved to the album copy');
    }
    finally {
        lease.release();
    }

    markGlobalPixivIllustInvalid(illustId, invalidAt);
}

function markWithin(mark: PixivFetchMark, now: number, ttlMs: number): boolean {
    const attemptedAt = mark.attemptedAt * 1000;

    return Number.isFinite(attemptedAt) && now - attemptedAt < ttlMs;
}

function albumStillEnabled(settings: Settings, albumId: string): boolean {
    try {
        return getAlbum(settings, albumId).index.settings.pixivEnabled;
    }
    catch {
        return false;
    }
}

const progressByAlbum = new Map<string, PixivAutoFetchAlbumStatusDto>();

function updateAlbumProgress(
    albumId: string,
    patch: Partial<PixivAutoFetchAlbumStatusDto>,
): PixivAutoFetchAlbumStatusDto {
    const current = progressByAlbum.get(albumId);
    const next: PixivAutoFetchAlbumStatusDto = {
        albumId,
        albumName: patch.albumName ?? current?.albumName ?? '',
        status: patch.status ?? current?.status ?? 'queued',
        total: patch.total ?? current?.total ?? 0,
        processed: patch.processed ?? current?.processed ?? 0,
        network: patch.network ?? current?.network ?? 0,
        backfilled: patch.backfilled ?? current?.backfilled ?? 0,
        fresh: patch.fresh ?? current?.fresh ?? 0,
        failed: patch.failed ?? current?.failed ?? 0,
        deleted: patch.deleted ?? current?.deleted ?? 0,
        noToken: patch.noToken ?? current?.noToken ?? 0,
        currentIllustId: patch.currentIllustId !== undefined
            ? patch.currentIllustId
            : current?.currentIllustId ?? null,
        startedAt: patch.startedAt !== undefined ? patch.startedAt : current?.startedAt ?? '',
        updatedAt: new Date().toISOString(),
        retryAt: patch.retryAt !== undefined ? patch.retryAt : current?.retryAt ?? '',
        elapsedMs: patch.elapsedMs ?? current?.elapsedMs ?? 0,
        error: patch.error !== undefined ? patch.error : current?.error ?? '',
    };

    progressByAlbum.set(albumId, next);

    return next;
}

function startAlbumProgress(
    albumId: string,
    albumName: string,
    total: number,
): PixivAutoFetchAlbumStatusDto {
    return updateAlbumProgress(albumId, {
        albumName,
        status: 'running',
        total,
        processed: 0,
        network: 0,
        backfilled: 0,
        fresh: 0,
        failed: 0,
        deleted: 0,
        noToken: 0,
        currentIllustId: null,
        startedAt: new Date().toISOString(),
        retryAt: '',
        elapsedMs: 0,
        error: '',
    });
}

/** 限流/连续失败后自动续跑；同一个相册只保留一个定时器 */
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function schedulePixivAutoFetchRetry(albumId: string, delayMs: number): void {
    if (process.env.NODE_ENV === 'test' && process.env.PX_TEST_PIXIV_AUTO_FETCH !== '1') {
        return;
    }

    const existing = retryTimers.get(albumId);

    if (existing) {
        clearTimeout(existing);
    }

    const timer = setTimeout(() => {
        retryTimers.delete(albumId);
        schedulePixivAutoFetch(albumId, { force: true });
    }, Math.max(1000, delayMs));

    timer.unref?.();
    retryTimers.set(albumId, timer);
}

function clearPixivAutoFetchRetry(albumId: string): void {
    const timer = retryTimers.get(albumId);

    if (timer) {
        clearTimeout(timer);
        retryTimers.delete(albumId);
    }
}

/** 后台补全的实时状态：设置页轮询，用于显示进度条与队列 */
export function getPixivAutoFetchStatus(): PixivAutoFetchStatusDto {
    const settings = getSettings();
    let names: Map<string, string> | null = null;

    function nameFor(albumId: string): string {
        if (!names) {
            try {
                names = new Map(listAlbumSummaries(settings).map(album => [album.id, album.name]));
            }
            catch {
                names = new Map();
            }
        }

        return names.get(albumId) ?? albumId;
    }

    return {
        running: running.size > 0
          || [...progressByAlbum.values()].some(item => item.status === 'running'),
        paused: settings.pixiv.autoFetchPaused,
        speed: settings.pixiv.autoFetchSpeed,
        queued: queue.map(albumId => ({ albumId, albumName: nameFor(albumId) })),
        albums: [...progressByAlbum.values()]
            .map(item => ({ ...item, albumName: item.albumName || nameFor(item.albumId) }))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
}

/** 执行一个相册的后台补全；导出供测试注入依赖 */
export async function runPixivAutoFetchAlbum(
    albumId: string,
    overrides: Partial<PixivAutoFetchDeps> = {},
): Promise<PixivAutoFetchSummary> {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    const settings = deps.settings();
    const startedAt = deps.now();
    const summary: PixivAutoFetchSummary = {
        albumId,
        works: 0,
        network: 0,
        backfilled: 0,
        fresh: 0,
        failed: 0,
        deleted: 0,
        noToken: 0,
        authRequired: false,
        tokenMissing: settings.pixiv.refreshToken.trim() === '',
        skipped: false,
        rateLimited: false,
        retryAfterMs: 0,
        stoppedReason: '',
        elapsedMs: 0,
    };

    updateAlbumProgress(albumId, {
        status: 'queued',
        total: 0,
        processed: 0,
        network: 0,
        backfilled: 0,
        fresh: 0,
        failed: 0,
        deleted: 0,
        noToken: 0,
        currentIllustId: null,
        startedAt: '',
        retryAt: '',
        elapsedMs: 0,
        error: '',
    });

    let context: ReturnType<typeof getAlbum>;

    try {
        context = getAlbum(settings, albumId);
    }
    catch {
        summary.skipped = true;
        updateAlbumProgress(albumId, { status: 'skipped', error: 'album_unavailable' });

        return summary;
    }

    if (!context.index.settings.pixivEnabled) {
        summary.skipped = true;
        updateAlbumProgress(albumId, { albumName: context.index.name, status: 'skipped', error: 'pixiv_disabled' });

        return summary;
    }

    // 先筛出真正需要补全的作品：已有相册元数据、断点冷却中的作品不进入计算范围，
    // 也不占进度条；全局缓存命中但仍需回填相册的作品保留。
    const pending: PixivWorkCandidate[] = [];
    const marks = new Map<string, PixivFetchMark>();

    const lease = leaseAlbumDatabase(context.dir);

    try {
        const db = lease.handle.album;
        const pixiv = lease.handle.pixiv;
        const pruned = pruneFetchMarks(db, deps.now());

        if (pruned > 0) {
            logger.debug({ albumId, pruned }, 'pruned stale pixiv fetch marks');
        }

        const works = collectPixivWorks(db);
        const nowAtStart = deps.now();

        for (const [illustId, mark] of loadFetchMarksFrom(db)) {
            marks.set(illustId, mark);
        }

        // 批量读取两类缓存的新鲜 ID，避免每作品两次查询（8 万资产时会明显阻塞请求）
        const cutoff = cutoffSeconds(nowAtStart - PIXIV_CACHE_TTL_MS);
        const albumFresh = listFreshPixivIllustIds(pixiv, cutoff);
        const globalFresh = listFreshGlobalPixivIllustIds(cutoff);
        // 404 记录为永久失效：相册副本或全局库任一命中都不再进入补全队列
        const albumInvalid = listInvalidPixivIllustIds(pixiv.$client);
        const globalInvalid = listGlobalInvalidPixivIllustIds();

        for (const work of works) {
            if (albumInvalid.has(work.illustId) || globalInvalid.has(work.illustId)) {
                continue;
            }
            if (albumFresh.has(work.illustId)) {
                continue;
            }

            const mark = marks.get(work.illustId);

            // 已失效作品不再重试（包括手动“立即补全”）；需要恢复请用资料库的“刷新详情”
            if (mark?.status === 'missing') {
                continue;
            }
            if (!deps.ignoreMarkCooldown && mark?.status === 'failed') {
                if (markWithin(mark, nowAtStart, FAILED_MARK_RETRY_MS)) {
                    continue;
                }
            }

            pending.push({
                work,
                cache: { albumFresh: false, globalFresh: globalFresh.has(work.illustId) },
            });
        }
    }
    finally {
        lease.release();
    }

    summary.works = pending.length;

    startAlbumProgress(albumId, context.index.name, pending.length);

    if (pending.length === 0) {
        summary.elapsedMs = Math.max(0, deps.now() - startedAt);
        updateAlbumProgress(albumId, { status: 'completed', processed: 0, elapsedMs: summary.elapsedMs });
        logger.info({ albumId }, 'pixiv auto fetch has nothing to enrich');

        return summary;
    }

    logger.info({
        albumId,
        works: pending.length,
        tokenMissing: summary.tokenMissing,
    }, 'pixiv auto fetch started');

    let consecutiveFailures = 0;
    /** 上一次真实联网的发起时间：相邻请求按发起时间计间隔，而不是在耗时之后再等满一档 */
    let lastNetworkStartedAt: number | null = null;

    for (const [index, candidate] of pending.entries()) {
        const work = candidate.work;

        if (deps.settings().pixiv.autoFetchPaused) {
            summary.stoppedReason = 'paused';
            break;
        }

        updateAlbumProgress(albumId, { currentIllustId: work.illustId, processed: index });

        try {
            if (!albumStillEnabled(settings, albumId)) {
                summary.skipped = true;
                break;
            }

            // 重启/再次进入时按断点跳过冷却期内的失败；已失效作品由预筛选永久排除
            const mark = marks.get(work.illustId);

            if (mark?.status === 'missing') {
                summary.deleted += 1;

                continue;
            }
            if (!deps.ignoreMarkCooldown && mark?.status === 'failed'
              && markWithin(mark, deps.now(), FAILED_MARK_RETRY_MS)) {
                summary.failed += 1;

                continue;
            }

            let cache = candidate.cache;

            if (cache.albumFresh) {
                saveFetchMark(context.dir, work.illustId, 'done', deps.now());
                marks.set(work.illustId, {
                    status: 'done',
                    attemptedAt: Math.floor(deps.now() / 1000),
                });
                summary.fresh += 1;
                continue;
            }

            if (!cache.globalFresh) {
                if (summary.tokenMissing) {
                    summary.noToken += 1;
                    continue;
                }

                // 只有真正要联网时才等待，命中缓存的作品可以快速跳过；
                // 速度可在设置页实时调整，限流后还会自动乘上惩罚倍数
                const speed = deps.settings().pixiv.autoFetchSpeed;
                const delay = Math.round(nextPixivDelay(deps.random, speed) * pixivRatePenaltyFactor());
                // 扣掉上一次请求已经花掉的时间（保留 50ms 调度抖动），让节奏变成「发起→发起」，
                // 不再固定等待叠加在网络耗时之后；响应慢时也不会额外延长总时长。
                const elapsed = lastNetworkStartedAt === null
                    ? 0
                    : Math.max(0, deps.now() - lastNetworkStartedAt - 50);

                await deps.sleep(Math.max(0, delay - elapsed));

                // 等待期间用户点了暂停：在发起请求前停止
                if (deps.settings().pixiv.autoFetchPaused) {
                    summary.stoppedReason = 'paused';
                    break;
                }

                cache = readCacheState(context.dir, work.illustId, deps.now());

                if (cache.albumFresh) {
                    saveFetchMark(context.dir, work.illustId, 'done', deps.now());
                    marks.set(work.illustId, {
                        status: 'done',
                        attemptedAt: Math.floor(deps.now() / 1000),
                    });
                    summary.fresh += 1;
                    continue;
                }
                if (!albumStillEnabled(settings, albumId)) {
                    summary.skipped = true;
                    break;
                }
            }

            try {
                if (!cache.globalFresh) {
                    lastNetworkStartedAt = deps.now();
                }

                const dto = await deps.fetchContext(settings, albumId, work.assetId);

                if (!dto.pixiv) {
                    // 文件名/映射命中但实际不是 Pixiv 作品：记断点，避免每次重启重复检查
                    saveFetchMark(context.dir, work.illustId, 'done', deps.now());
                    marks.set(work.illustId, {
                        status: 'done',
                        attemptedAt: Math.floor(deps.now() / 1000),
                    });
                    continue;
                }
                if (dto.invalid) {
                    // 预筛选之后才被别处标记为失效：记断点并跳过，不发起下载
                    saveFetchMark(context.dir, work.illustId, 'missing', deps.now());
                    markInvalid(context.dir, work.illustId, deps.now());
                    summary.deleted += 1;
                    continue;
                }
                if (dto.authRequired) {
                    summary.authRequired = true;
                    logger.warn({ albumId, illustId: work.illustId }, 'pixiv auto fetch stopped: auth required');
                    break;
                }

                if (cache.globalFresh) {
                    summary.backfilled += 1;
                }
                else {
                    summary.network += 1;
                }

                // 元数据已成功落库：先记断点，标签同步失败不影响作品补全状态
                saveFetchMark(context.dir, work.illustId, 'done', deps.now());
                marks.set(work.illustId, {
                    status: 'done',
                    attemptedAt: Math.floor(deps.now() / 1000),
                });

                consecutiveFailures = 0;

                if (summary.network > 0 && summary.network % NETWORK_BATCH_SIZE === 0) {
                    const pause = NETWORK_BATCH_PAUSE_MS + Math.floor(deps.random() * 5000);

                    logger.debug({
                        albumId,
                        network: summary.network,
                        pause,
                    }, 'pixiv auto fetch batch pause');
                    await deps.sleep(pause);

                    if (deps.settings().pixiv.autoFetchPaused) {
                        summary.stoppedReason = 'paused';
                        break;
                    }
                }
            }
            catch (error) {
                if (error instanceof PixivRateLimitError) {
                    summary.rateLimited = true;
                    summary.retryAfterMs = Math.max(
                        MIN_RATE_LIMIT_RETRY_MS,
                        Math.min(error.retryAfterMs, MAX_RATE_LIMIT_RETRY_MS),
                    );
                    summary.stoppedReason = 'rate_limited';
                    logger.warn({
                        albumId,
                        illustId: work.illustId,
                        retryAfterMs: summary.retryAfterMs,
                    }, 'pixiv auto fetch paused by rate limit');

                    break;
                }

                if (error instanceof ApiError && error.code === 'pixiv_illust_not_found') {
                    // 作品已删除/不可见是正常情况，不能让连续失败计数把整轮任务停掉；
                    // 持久化失效标记后，后续补全与数据库汇总都不再处理该作品
                    saveFetchMark(context.dir, work.illustId, 'missing', deps.now());
                    markInvalid(context.dir, work.illustId, deps.now());
                    summary.deleted += 1;
                    consecutiveFailures = 0;

                    continue;
                }

                if (error instanceof ApiError && (error.code === 'pixiv_auth_required' || error.code === 'pixiv_auth_failed')) {
                    summary.authRequired = true;
                    summary.stoppedReason = 'auth_required';
                    break;
                }

                summary.failed += 1;
                consecutiveFailures += 1;
                saveFetchMark(
                    context.dir,
                    work.illustId,
                    'failed',
                    deps.now(),
                );
                logger.warn({ err: error, albumId, illustId: work.illustId }, 'pixiv auto fetch item failed');

                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    summary.stoppedReason = 'consecutive_failures';
                    break;
                }
            }
        }
        finally {
            const elapsedMs = Math.max(0, deps.now() - startedAt);
            const processed = index + 1;

            updateAlbumProgress(albumId, {
                processed,
                currentIllustId: null,
                network: summary.network,
                backfilled: summary.backfilled,
                fresh: summary.fresh,
                failed: summary.failed,
                deleted: summary.deleted,
                noToken: summary.noToken,
                elapsedMs,
            });

            if (processed % PROGRESS_EVERY === 0) {
                logger.debug({
                    albumId,
                    processed,
                    total: pending.length,
                    network: summary.network,
                    backfilled: summary.backfilled,
                    failed: summary.failed,
                }, 'pixiv auto fetch progress');
            }
        }
    }

    summary.elapsedMs = Math.max(0, deps.now() - startedAt);
    const allFailed = summary.failed > 0
      && summary.network === 0
      && summary.backfilled === 0
      && summary.fresh === 0
      && summary.deleted === 0
      && summary.noToken === 0;
    const retryable = summary.rateLimited || summary.stoppedReason === 'consecutive_failures';
    const retryDelay = summary.rateLimited
        ? summary.retryAfterMs
        : CONSECUTIVE_FAILURE_RETRY_MS;
    const retryAt = retryable
        ? new Date(deps.now() + retryDelay).toISOString()
        : '';
    const userPaused = summary.stoppedReason === 'paused';
    let status: PixivAutoFetchAlbumStatusDto['status'] = 'completed';
    let error = '';

    if (userPaused) {
        status = 'paused';
        error = 'paused';
    }
    else if (retryable) {
        status = 'paused';
        error = summary.stoppedReason;
    }
    else if (summary.skipped) {
        status = 'skipped';
    }
    else if (summary.authRequired || allFailed) {
        status = 'failed';
        error = summary.authRequired ? 'pixiv_auth_required' : 'all_failed';
    }

    updateAlbumProgress(albumId, {
        status,
        processed: progressByAlbum.get(albumId)?.processed ?? pending.length,
        currentIllustId: null,
        network: summary.network,
        backfilled: summary.backfilled,
        fresh: summary.fresh,
        failed: summary.failed,
        deleted: summary.deleted,
        noToken: summary.noToken,
        retryAt,
        elapsedMs: summary.elapsedMs,
        error,
    });

    if (retryable) {
        logger.info({ albumId, retryAt, retryDelay, reason: summary.stoppedReason }, 'pixiv auto fetch will resume automatically');
        deps.scheduleRetry(albumId, retryDelay);
    }

    logger.info({ ...summary }, 'pixiv auto fetch finished');

    return summary;
}

const queue: string[] = [];
const running = new Set<string>();
const lastScheduledAt = new Map<string, number>();
const forceNextRun = new Set<string>();
let pumping = false;

/**
 * 调度某个相册的后台补全。全局只有一个 worker，多个相册也按队列串行。
 * 测试环境默认关闭，避免路由测试产生异步网络任务；PX_TEST_PIXIV_AUTO_FETCH=1 可显式打开。
 * force=true 用于用户手动“立即补全”，跳过 5 分钟冷却。
 */
export function schedulePixivAutoFetch(albumId: string, options: { force?: boolean } = {}): boolean {
    if (process.env.NODE_ENV === 'test' && process.env.PX_TEST_PIXIV_AUTO_FETCH !== '1') {
        return false;
    }
    // 用户暂停后，启动扫描/路由触发/自动重试都不应重新入队
    if (getSettings().pixiv.autoFetchPaused) {
        return false;
    }
    if (running.has(albumId) || queue.includes(albumId)) {
        return false;
    }

    if (options.force) {
        clearPixivAutoFetchRetry(albumId);
        forceNextRun.add(albumId);
    }

    const now = Date.now();
    const last = lastScheduledAt.get(albumId) ?? 0;

    if (!options.force && now - last < SCHEDULE_COOLDOWN_MS) {
        return false;
    }

    lastScheduledAt.set(albumId, now);
    updateAlbumProgress(albumId, {
        status: 'queued',
        total: 0,
        processed: 0,
        network: 0,
        backfilled: 0,
        fresh: 0,
        failed: 0,
        deleted: 0,
        noToken: 0,
        currentIllustId: null,
        startedAt: '',
        retryAt: '',
        elapsedMs: 0,
        error: '',
    });
    queue.push(albumId);

    if (!pumping) {
        pumping = true;
        // 让当前 HTTP 请求先返回；旧实现会同步跑完 collect/预筛选，拖慢首次打开相册
        setImmediate(() => {
            void pumpQueue();
        });
    }

    return true;
}

/** 手动触发后台补全：指定相册或全部启用 Pixiv 的相册 */
export function triggerPixivAutoFetch(albumId?: string): PixivAutoFetchTriggerResult {
    const settings = getSettings();

    if (settings.pixiv.autoFetchPaused) {
        return { queued: 0, status: getPixivAutoFetchStatus() };
    }

    const candidates = listAlbumSummaries(settings).filter(album => (
        !album.missing && !album.corrupt && album.settings.pixivEnabled
    ));
    const targets = albumId
        ? candidates.filter(album => album.id === albumId)
        : candidates;
    let queued = 0;

    for (const album of targets) {
        if (schedulePixivAutoFetch(album.id, { force: true })) {
            queued += 1;
        }
    }

    return { queued, status: getPixivAutoFetchStatus() };
}

/**
 * 手动暂停：持久化到 setting.json，清空队列与自动重试；
 * 正在运行的作品会跑完，下一件开始前停止，断点已在本轮逐件写入。
 */
export function pausePixivAutoFetch(): PixivAutoFetchStatusDto {
    updateSettings({ pixiv: { autoFetchPaused: true } });
    queue.length = 0;

    for (const timer of retryTimers.values()) {
        clearTimeout(timer);
    }
    retryTimers.clear();

    for (const [albumId, item] of progressByAlbum) {
        if (item.status === 'running' || item.status === 'queued') {
            updateAlbumProgress(albumId, {
                status: 'paused',
                currentIllustId: null,
                retryAt: '',
                error: 'paused',
            });
        }
    }

    return getPixivAutoFetchStatus();
}

/** 继续补全：清除暂停标记并重新排队所有启用 Pixiv 的相册（断点会跳过已完成作品） */
export function resumePixivAutoFetch(): PixivAutoFetchTriggerResult {
    updateSettings({ pixiv: { autoFetchPaused: false } });

    return triggerPixivAutoFetch();
}

async function pumpQueue(): Promise<void> {
    try {
        while (queue.length > 0) {
            const albumId = queue.shift();

            if (!albumId) {
                break;
            }

            running.add(albumId);

            try {
                await runPixivAutoFetchAlbum(albumId, {
                    ignoreMarkCooldown: forceNextRun.delete(albumId),
                });
            }
            catch (error) {
                updateAlbumProgress(albumId, {
                    status: 'failed',
                    currentIllustId: null,
                    error: error instanceof Error ? error.message : String(error),
                });
                logger.warn({ err: error, albumId }, 'pixiv auto fetch run failed');
            }
            finally {
                running.delete(albumId);
            }
        }
    }
    finally {
        pumping = false;
    }
}

/** 测试用：清空调度状态 */
export function resetPixivAutoFetchState(): void {
    queue.length = 0;
    running.clear();
    lastScheduledAt.clear();
    forceNextRun.clear();
    progressByAlbum.clear();

    for (const timer of retryTimers.values()) {
        clearTimeout(timer);
    }

    retryTimers.clear();
}
