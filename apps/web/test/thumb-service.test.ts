import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { createAlbum, getAlbum, type AlbumContext } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase } from '../server/database/global';
import { closePixivDatabase } from '../server/database/pixiv';
import { assets } from '../server/database/schemas/album';
import { resetThumbnailServiceForTests } from '../server/album/thumb-service';
import { resetThumbnailWarmupForTests } from '../server/album/thumb-warmup';
import { resetThumbMaintenanceForTests } from '../server/album/thumb-maintenance';
import { getSettings, resetSettingsCache, updateSettings } from '../server/settings/setting-store';

let app: Hono<AppEnv>;
let dataDir: string;
let counter = 0;

interface WarmupView {
    status: string
    total: number
    processed: number
    generated: number
    skipped: number
    failed: number
    resumable: boolean
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-thumbs-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(() => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    resetThumbnailServiceForTests();
    resetThumbnailWarmupForTests();
    resetThumbMaintenanceForTests();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

beforeEach(() => {
    resetThumbnailServiceForTests();
    resetThumbnailWarmupForTests();
});

function shaFor(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

async function seedImage(context: AlbumContext, id: string): Promise<void> {
    const dir = join(context.dir, 'storage', '0001');

    mkdirSync(dir, { recursive: true });

    const target = join(dir, `${id}.jpg`);

    await sharp({
        create: {
            width: 96,
            height: 64,
            channels: 3,
            background: { r: 20 + counter, g: 80, b: 140 },
        },
    }).jpeg({ quality: 80 }).toFile(target);
    counter += 1;

    context.db.album.insert(assets).values({
        id,
        storageKey: `storage/0001/${id}.jpg`,
        filename: `${id}.jpg`,
        ext: 'jpg',
        mime: 'image/jpeg',
        kind: 'image',
        size: statSync(target).size,
        width: 96,
        height: 64,
        sha256: shaFor(id),
        takenAt: null,
        addedAt: Math.floor(Date.now() / 1000),
        deletedAt: null,
        meta: '{}',
    }).run();
}

async function thumbnails(albumId: string): Promise<{
    count: number
    warmup: WarmupView
}> {
    const response = await app.request(`/albums/${albumId}/thumbnails`);
    const body = await response.json();

    return body.data;
}

async function waitWarmup(albumId: string, expected: string): Promise<WarmupView> {
    const deadline = Date.now() + 10_000;

    for (;;) {
        const data = await thumbnails(albumId);

        if (data.warmup.status === expected) {
            return data.warmup;
        }
        if (data.warmup.status === 'failed') {
            throw new Error('thumbnail warmup failed');
        }
        if (Date.now() > deadline) {
            throw new Error(`thumbnail warmup did not reach ${expected}`);
        }

        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

describe('thumbnail warmup', () => {
    it('generates the smallest size in the background and reports progress', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Warmup' });
        const context = getAlbum(settings, album.id);

        await seedImage(context, 'warm-a');
        await seedImage(context, 'warm-b');
        await seedImage(context, 'warm-c');

        const started = await app.request(`/albums/${album.id}/thumbnails/warmup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(started.status).toBe(202);

        const warmup = await waitWarmup(album.id, 'completed');
        const stats = await thumbnails(album.id);

        expect(warmup.total).toBe(3);
        expect(warmup.processed).toBe(3);
        expect(warmup.generated).toBe(3);
        expect(warmup.failed).toBe(0);
        expect(warmup.resumable).toBe(false);
        expect(stats.count).toBe(3);
    });

    it('keeps an existing thumbnail cache and skips decoding on restart', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Warmup Restart' });
        const context = getAlbum(settings, album.id);

        await seedImage(context, 'restart-a');

        await app.request(`/albums/${album.id}/thumbnails/warmup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        await waitWarmup(album.id, 'completed');

        const restarted = await app.request(`/albums/${album.id}/thumbnails/warmup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ restart: true }),
        });

        expect(restarted.status).toBe(202);

        const warmup = await waitWarmup(album.id, 'completed');

        expect(warmup.processed).toBe(1);
        expect(warmup.generated).toBe(0);
        expect(warmup.skipped).toBe(1);
    });
});

describe('thumbnail stale-while-revalidate', () => {
    it('returns the smaller cached image immediately and upgrades in the background', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'SWR' });
        const context = getAlbum(settings, album.id);

        await seedImage(context, 'swr-a');

        const small = await app.request(`/albums/${album.id}/assets/swr-a/thumbnail?size=256`);
        const smallEtag = small.headers.get('etag') ?? '';

        expect(small.status).toBe(200);
        expect(smallEtag).toContain('-256-');

        const large = await app.request(`/albums/${album.id}/assets/swr-a/thumbnail?size=512`);
        const largeEtag = large.headers.get('etag') ?? '';

        expect(large.status).toBe(200);
        expect(largeEtag).toContain('-256-');

        // 后台队列随后生成 512，不阻塞首屏
        const deadline = Date.now() + 5_000;
        let resolved = '';

        while (Date.now() < deadline) {
            const probe = await app.request(`/albums/${album.id}/assets/swr-a/thumbnail?size=512`);
            const etag = probe.headers.get('etag') ?? '';

            if (etag.includes('-512-')) {
                resolved = etag;
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 25));
        }

        expect(resolved).toContain('-512-');
    });

    it('generates the upgrade size synchronously for dwell upgrades', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Upgrade' });

        await seedImage(getAlbum(settings, album.id), 'upgrade-a');

        const small = await app.request(`/albums/${album.id}/assets/upgrade-a/thumbnail?size=256`);

        expect(small.status).toBe(200);
        expect(small.headers.get('etag')).toContain('-256-');

        // 停留升级不能拿到首屏同款小图：缺目标档时同步生成后再返回
        const upgraded = await app.request(
            `/albums/${album.id}/assets/upgrade-a/thumbnail?size=512&upgrade=1`,
        );

        expect(upgraded.status).toBe(200);
        expect(upgraded.headers.get('etag')).toContain('-512-');
    });

    it('queues generation in the background in cache-first mode', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Cache First' });

        await seedImage(getAlbum(settings, album.id), 'cache-a');
        updateSettings({ thumbnails: { cacheFirst: true } });

        try {
            const first = await app.request(`/albums/${album.id}/assets/cache-a/thumbnail?size=256`);

            // 浏览请求不等待解码：立即 404，同时把最小配置档塞进后台队列
            expect(first.status).toBe(404);

            const deadline = Date.now() + 5_000;
            let etag = '';

            while (Date.now() < deadline) {
                const probe = await app.request(`/albums/${album.id}/assets/cache-a/thumbnail?size=256`);

                etag = probe.headers.get('etag') ?? '';

                if (etag.includes('-256-')) {
                    break;
                }

                await new Promise(resolve => setTimeout(resolve, 25));
            }

            expect(etag).toContain('-256-');
        }
        finally {
            updateSettings({ thumbnails: { cacheFirst: false } });
        }
    });

    it('does not decode originals for non-generating preloads', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Preload Miss' });

        await seedImage(getAlbum(settings, album.id), 'preload-a');

        const before = await thumbnails(album.id);
        const response = await app.request(`/albums/${album.id}/assets/preload-a/thumbnail?size=512&generate=0`);
        const after = await thumbnails(album.id);

        expect(response.status).toBe(404);
        expect(after.count).toBe(before.count);
    });
});
