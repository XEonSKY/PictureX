import { availableParallelism } from 'node:os';
import { leaseAlbumDatabase } from '../database/album';
import { getAssetRow, previewMeta } from '../domain/asset-query';
import { generateThumbnails } from '../ingest/thumb';
import type { AssetKind } from '../ingest/types';
import { logger } from '../logger';
import type { Settings } from '../settings/setting-schema';
import { storageForAlbum } from '../storage/registry';
import { createThumbStore } from './thumb-store';

/**
 * 缩略图生成服务：
 * - 交互请求与后台预热分队列，交互永远优先；
 * - 并发按实际生成耗时自适应，HDD/网络盘自动降到 1 路，避免磁头来回寻道；
 * - 同一资产同一尺寸的并发请求只解码一次。
 */

export type ThumbnailPriority = 'interactive' | 'background';

export interface ThumbnailServiceStats {
    requests: number
    hits: number
    generated: number
    failures: number
    ewmaMs: number
    samples: number
    interactiveConcurrency: number
    interactiveActive: number
    interactivePending: number
    backgroundActive: number
    backgroundPending: number
}

const BASE_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism() - 2));

/** 带动态并发的 FIFO 闸门（p-limit 不提供运行时调整） */
class DynamicLimiter {
    private active = 0;
    private waiters: Array<() => void> = [];
    private limit: number;

    constructor(limit: number) {
        this.limit = Math.max(1, limit);
    }

    get activeCount(): number {
        return this.active;
    }

    get pendingCount(): number {
        return this.waiters.length;
    }

    get concurrency(): number {
        return this.limit;
    }

    setConcurrency(limit: number): void {
        const next = Math.max(1, Math.min(BASE_CONCURRENCY, limit));

        if (next === this.limit) {
            return;
        }

        this.limit = next;
        this.drain();
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const start = (): void => {
                this.active += 1;
                void Promise.resolve()
                    .then(task)
                    .then(resolve, reject)
                    .finally(() => {
                        this.active -= 1;
                        this.drain();
                    });
            };

            if (this.active < this.limit && this.waiters.length === 0) {
                start();

                return;
            }

            this.waiters.push(start);
        });
    }

    private drain(): void {
        while (this.active < this.limit && this.waiters.length > 0) {
            this.waiters.shift()?.();
        }
    }
}

const interactiveLimiter = new DynamicLimiter(BASE_CONCURRENCY);
const backgroundLimiter = new DynamicLimiter(1);
const pending = new Map<string, Promise<boolean>>();

let requests = 0;
let hits = 0;
let generated = 0;
let failures = 0;
let ewmaMs = 0;
let samples = 0;

function recordGeneration(durationMs: number, ok: boolean): void {
    samples += 1;
    ewmaMs = samples === 1 ? durationMs : ewmaMs * 0.75 + durationMs * 0.25;

    if (ok) {
        generated += 1;
    }
    else {
        failures += 1;
    }

    if (samples < 3) {
        return;
    }

    // 慢盘（HDD/网络盘）单张解码通常 >100ms；串行反而比多路寻道更快
    const target = ewmaMs > 120
        ? 1
        : ewmaMs > 60
            ? 2
            : ewmaMs > 30
                ? 3
                : BASE_CONCURRENCY;

    interactiveLimiter.setConcurrency(target);

    if (durationMs >= 150) {
        logger.debug({ durationMs, ewmaMs: Math.round(ewmaMs), concurrency: target }, 'slow thumbnail generation');
    }
}

export function noteThumbnailLookup(hit: boolean): void {
    requests += 1;

    if (hit) {
        hits += 1;
    }
}

export function thumbnailServiceStats(): ThumbnailServiceStats {
    return {
        requests,
        hits,
        generated,
        failures,
        ewmaMs: Math.round(ewmaMs),
        samples,
        interactiveConcurrency: interactiveLimiter.concurrency,
        interactiveActive: interactiveLimiter.activeCount,
        interactivePending: interactiveLimiter.pendingCount,
        backgroundActive: backgroundLimiter.activeCount,
        backgroundPending: backgroundLimiter.pendingCount,
    };
}

/** 请求尺寸不在配置里时取不小于它的最小配置尺寸；都比它大时取最大配置尺寸 */
export function resolveThumbnailSize(settings: Settings, requested: number): number {
    const sizes = [...new Set(settings.thumbnails.sizes)].sort((a, b) => a - b);

    if (sizes.length === 0) {
        return requested;
    }

    return sizes.find(size => size >= requested) ?? sizes[sizes.length - 1] ?? requested;
}

export function thumbnailFingerprint(settings: Settings, size: number): string {
    return `${size}:${settings.thumbnails.quality}`;
}

function isAssetKind(value: string): value is AssetKind {
    return value === 'image' || value === 'gif' || value === 'dynamic' || value === 'svg' || value === 'video';
}

function thumbnailKey(albumDir: string, assetId: string, size: number): string {
    return `${albumDir}:${assetId}:${size}`;
}

/**
 * 确保指定尺寸的缩略图存在。background 队列固定 1 路，避免预热任务与首屏抢盘。
 * 失败写负缓存；已存在或失败冷却中直接返回。
 */
export function ensureThumbnail(
    albumId: string,
    albumDir: string,
    settings: Settings,
    assetId: string,
    size: number,
    priority: ThumbnailPriority = 'interactive',
): Promise<boolean> {
    const key = thumbnailKey(albumId, assetId, size);
    const current = pending.get(key);

    if (current) {
        return current;
    }

    const limiter = priority === 'background' ? backgroundLimiter : interactiveLimiter;
    const job = limiter.run(async () => {
        // 只统计真正解码的耗时：把排队等待算进去会让 EWMA 虚高，高负载时自我强化地降到 1 路
        const started = Date.now();
        const result = await generateMissingThumbnail(albumId, albumDir, settings, assetId, size);

        recordGeneration(Date.now() - started, result);

        return result;
    }).finally(() => pending.delete(key));

    pending.set(key, job);

    return job;
}

async function generateMissingThumbnail(
    albumId: string,
    albumDir: string,
    settings: Settings,
    assetId: string,
    size: number,
): Promise<boolean> {
    const lease = leaseAlbumDatabase(albumDir);

    try {
        const store = createThumbStore(lease.handle.thumbnails, settings.thumbnails.dbMaxSizeMb, albumId);
        const fingerprint = thumbnailFingerprint(settings, size);

        if (store.has(assetId, size)) {
            return true;
        }
        // 负缓存命中不是成功：返回 false，预热才能把它计入 failed
        if (store.hasFailure(assetId, fingerprint)) {
            return false;
        }

        let row: ReturnType<typeof getAssetRow>;

        try {
            row = getAssetRow(lease.handle.album, assetId);
        }
        catch {
            // 资产已不存在：不写负缓存，避免误伤后来复用同一 id 的数据
            return false;
        }

        if (!isAssetKind(row.kind)) {
            return false;
        }

        const storage = storageForAlbum(albumDir, settings);
        const preview = previewMeta(row);
        const path = (preview ? storage.localPath(preview.storageKey) : null) ?? storage.localPath(row.storageKey);

        if (!path) {
            // 远端存储暂不支持生成缩略图
            return false;
        }

        const generated = await generateThumbnails(path, row.kind, settings, [size]);

        if (generated.length === 0) {
            store.markFailure(assetId, fingerprint);

            return false;
        }

        for (const thumbnail of generated) {
            store.put({
                assetId,
                size: thumbnail.size,
                mime: thumbnail.mime,
                blob: thumbnail.blob,
                width: thumbnail.width,
                height: thumbnail.height,
            });
        }

        store.clearFailure(assetId);

        return true;
    }
    finally {
        lease.release();
    }
}

/** 相册封面走 512 档；首页/相册卡片请求前先低优先级预热一次 */
export function prewarmAlbumCover(
    albumId: string,
    albumDir: string,
    settings: Settings,
    coverAssetId: string | null,
): void {
    if (!coverAssetId) {
        return;
    }

    const size = resolveThumbnailSize(settings, 512);

    void ensureThumbnail(albumId, albumDir, settings, coverAssetId, size, 'background').catch(() => undefined);
}

/** 仅供测试：清理队列与统计 */
export function resetThumbnailServiceForTests(): void {
    pending.clear();
    requests = 0;
    hits = 0;
    generated = 0;
    failures = 0;
    ewmaMs = 0;
    samples = 0;
    interactiveLimiter.setConcurrency(BASE_CONCURRENCY);
}
