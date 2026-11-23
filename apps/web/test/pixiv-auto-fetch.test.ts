import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAlbum, getAlbum, updateAlbum, type AlbumContext } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase } from '../server/database/global';
import { closePixivDatabase, listInvalidPixivIllustIds, pixivDatabase } from '../server/database/pixiv';
import { assets, pixivFetchMarks } from '../server/database/schemas/album';
import { ApiError } from '../server/hono/problem';
import { PixivRateLimitError } from '../server/pixiv/api';
import {
    collectPixivWorks,
    getPixivAutoFetchStatus,
    nextPixivDelay,
    resetPixivAutoFetchState,
    runPixivAutoFetchAlbum,
} from '../server/pixiv/auto-fetch';
import { linkPixivAsset, upsertIllust } from '../server/pixiv/store';
import type { AssetPixivContextDto, PixivIllust } from '../server/pixiv/types';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import type { Settings } from '../server/settings/setting-schema';

let dataDir: string;

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-pixiv-auto-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();
});

afterEach(() => {
    resetPixivAutoFetchState();

    // 失效标记是全局的：用例之间清空全局作品，避免 111111 之类的固定 ID 互相污染
    try {
        pixivDatabase().$client.exec('DELETE FROM illusts');
    }
    catch {
        // 全局库尚未打开时无需清理
    }
});

afterAll(() => {
    resetPixivAutoFetchState();
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

function shaFor(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

function createPixivAlbum(name: string): { settings: Settings, context: AlbumContext } {
    const settings = getSettings();
    const album = createAlbum(settings, { name });

    updateAlbum(settings, album.id, { settings: { pixivEnabled: true } });

    return { settings, context: getAlbum(settings, album.id) };
}

function seedAsset(
    context: AlbumContext,
    id: string,
    filename: string,
    addedAt: number,
    deleted = false,
): void {
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'jpg';

    context.db.album.insert(assets).values({
        id,
        storageKey: `storage/0001/${id}.${ext}`,
        filename,
        ext,
        mime: ext === 'png' ? 'image/png' : 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 100,
        sha256: shaFor(id),
        takenAt: null,
        addedAt,
        deletedAt: deleted ? Math.floor(Date.now() / 1000) : null,
        meta: '{}',
    }).run();
}

function fakeIllust(illustId: string): PixivIllust {
    return {
        illustId,
        title: `Title ${illustId}`,
        type: 'illust',
        caption: '',
        userId: '1',
        userName: 'user',
        userAccount: 'user',
        pageCount: 1,
        width: 100,
        height: 100,
        xRestrict: 0,
        sanityLevel: 0,
        illustAiType: 1,
        createDate: '2026-01-01T00:00:00.000Z',
        totalView: 0,
        totalBookmarks: 0,
        tags: [],
        pages: [],
        ugoira: null,
    };
}

function fakeContext(illustId: string, assetId: string): AssetPixivContextDto {
    return {
        pixiv: true,
        illustId,
        pageIndex: 0,
        illust: fakeIllust(illustId),
        localPages: [{ index: 0, assetId, filename: `${illustId}_p0.jpg` }],
        missingPages: [],
        authRequired: false,
        invalid: false,
        stale: false,
        downloadedPages: [],
        downloadErrors: [],
    };
}

describe('pixiv auto fetch', () => {
    it('groups assets by illust and prefers explicit links / lowest page', () => {
        const { context } = createPixivAlbum('Works');
        const db = context.db.album;

        seedAsset(context, 'a0', '127978234_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);
        seedAsset(context, 'a1', '127978234_p1.jpg', Date.parse('2026-01-01T00:01:00.000Z') / 1000);
        seedAsset(context, 'd0', '127978234_p2.jpg', Date.parse('2026-01-03T00:00:00.000Z') / 1000, true);
        seedAsset(context, 'b0', 'renamed.jpg', Date.parse('2026-01-02T00:00:00.000Z') / 1000);
        seedAsset(context, 'n0', 'holiday.jpg', Date.parse('2026-01-04T00:00:00.000Z') / 1000);
        linkPixivAsset(db, '555555', 0, 'b0');

        const works = collectPixivWorks(db);

        expect(works.map(work => work.illustId)).toEqual(['555555', '127978234']);
        expect(works[1]?.assetId).toBe('a0');
    });

    it('fetches sequentially with a 100–1000ms delay', async () => {
        const { settings, context } = createPixivAlbum('Sequential');

        seedAsset(context, 'w1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);
        seedAsset(context, 'w2', '222222_p0.jpg', Date.parse('2026-01-02T00:00:00.000Z') / 1000);
        seedAsset(context, 'w3', '333333_p0.jpg', Date.parse('2026-01-03T00:00:00.000Z') / 1000);

        const tokenSettings: Settings = {
            ...settings,
            pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
        };
        const sleeps: number[] = [];
        const fetched: string[] = [];
        let active = 0;
        let maxActive = 0;
        let runningStatus: ReturnType<typeof getPixivAutoFetchStatus> | null = null;

        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => tokenSettings,
            random: () => 0.5,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            fetchContext: async (_settings, _albumId, assetId) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                runningStatus ??= getPixivAutoFetchStatus();
                await new Promise(resolve => setTimeout(resolve, 0));
                fetched.push(assetId);
                active -= 1;

                return fakeContext('111111', assetId);
            },
        });

        expect(summary.works).toBe(3);
        expect(summary.network).toBe(3);
        expect(summary.failed).toBe(0);
        expect(sleeps).toEqual([550, 550, 550]);
        expect(fetched).toEqual(['w3', 'w2', 'w1']);
        expect(maxActive).toBe(1);

        // 运行中状态是可查询的：进度条用 processed / total 与当前作品
        expect(runningStatus?.running).toBe(true);
        expect(runningStatus?.albums[0]).toMatchObject({
            albumId: context.index.id,
            status: 'running',
            total: 3,
            network: 0,
        });
        expect(runningStatus?.albums[0]?.currentIllustId).toBe('333333');

        const finished = getPixivAutoFetchStatus();
        expect(finished.albums[0]).toMatchObject({
            albumId: context.index.id,
            status: 'completed',
            total: 3,
            processed: 3,
            network: 3,
            failed: 0,
        });
    });

    it('excludes works with a fresh album cache from the total and never checks them', async () => {
        const { settings, context } = createPixivAlbum('Cached');

        seedAsset(context, 'c1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);
        seedAsset(context, 'c2', '222222_p0.jpg', Date.parse('2026-01-02T00:00:00.000Z') / 1000);
        upsertIllust(context.db.pixiv, fakeIllust('111111'));

        const tokenSettings: Settings = {
            ...settings,
            pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
        };
        const fetched: string[] = [];
        const sleeps: number[] = [];

        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => tokenSettings,
            random: () => 0,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            fetchContext: async (_settings, _albumId, assetId) => {
                fetched.push(assetId);

                return fakeContext('222222', assetId);
            },
        });

        // 已有相册元数据的作品不在 total/processed 里，也不会触发缓存检查之外的任何处理
        expect(summary.works).toBe(1);
        expect(summary.fresh).toBe(0);
        expect(summary.network).toBe(1);
        expect(fetched).toEqual(['c2']);
        expect(sleeps).toHaveLength(1);

        const status = getPixivAutoFetchStatus().albums.find(item => item.albumId === context.index.id);

        expect(status).toMatchObject({ total: 1, processed: 1, network: 1 });

        const marks = context.db.album.select().from(pixivFetchMarks).all();

        expect(marks.find(mark => mark.illustId === '111111')).toBeUndefined();
        expect(marks.find(mark => mark.illustId === '222222')?.status).toBe('done');
    });

    it('persists failed works and skips them during the cooldown', async () => {
        const { settings, context } = createPixivAlbum('Failed marks');

        seedAsset(context, 'f1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);

        const tokenSettings: Settings = {
            ...settings,
            pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
        };
        let fetches = 0;
        const deps = {
            settings: () => tokenSettings,
            random: () => 0,
            sleep: async () => undefined,
            fetchContext: async () => {
                fetches += 1;

                throw new Error('network down');
            },
            scheduleRetry: () => undefined,
        };

        const first = await runPixivAutoFetchAlbum(context.index.id, deps);

        expect(first.failed).toBe(1);
        expect(fetches).toBe(1);
        expect(context.db.album.select().from(pixivFetchMarks).all()).toMatchObject([
            { illustId: '111111', status: 'failed' },
        ]);

        // 进程重启后：冷却期内的失败作品不进入计算范围，也不发起请求
        const second = await runPixivAutoFetchAlbum(context.index.id, deps);

        expect(second.works).toBe(0);
        expect(second.failed).toBe(0);
        expect(fetches).toBe(1);
        expect(getPixivAutoFetchStatus().albums.find(item => item.albumId === context.index.id)).toMatchObject({
            status: 'completed',
            total: 0,
            processed: 0,
        });

        // 用户手动“立即补全”忽略断点冷却
        const forced = await runPixivAutoFetchAlbum(context.index.id, {
            ...deps,
            ignoreMarkCooldown: true,
        });

        expect(forced.works).toBe(1);
        expect(forced.failed).toBe(1);
        expect(fetches).toBe(2);
    });

    it('stops before the next work when the user pauses', async () => {
        const { settings, context } = createPixivAlbum('Paused run');

        seedAsset(context, 'p1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);

        const pausedSettings: Settings = {
            ...settings,
            pixiv: {
                ...settings.pixiv,
                refreshToken: 'test-token',
                autoFetchPaused: true,
            },
        };
        let fetches = 0;
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => pausedSettings,
            sleep: async () => undefined,
            fetchContext: async () => {
                fetches += 1;

                return fakeContext('111111', 'p1');
            },
            scheduleRetry: () => {
                throw new Error('paused runs must not schedule retries');
            },
        });

        expect(fetches).toBe(0);
        expect(summary.stoppedReason).toBe('paused');
        expect(summary.rateLimited).toBe(false);
        expect(getPixivAutoFetchStatus().albums.find(item => item.albumId === context.index.id)).toMatchObject({
            status: 'paused',
            error: 'paused',
            retryAt: '',
        });
    });

    it('does not hit the network when no token is configured', async () => {
        const { settings, context } = createPixivAlbum('No token');

        seedAsset(context, 'n1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);

        let fetched = 0;
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => settings,
            sleep: async () => undefined,
            fetchContext: async () => {
                fetched += 1;

                return fakeContext('111111', 'n1');
            },
        });

        expect(summary.tokenMissing).toBe(true);
        expect(summary.noToken).toBe(1);
        expect(summary.network).toBe(0);
        expect(fetched).toBe(0);
    });

    it('stops the run when the API requires authentication', async () => {
        const { settings, context } = createPixivAlbum('Auth required');

        seedAsset(context, 'r1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);
        seedAsset(context, 'r2', '222222_p0.jpg', Date.parse('2026-01-02T00:00:00.000Z') / 1000);

        let fetched = 0;
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => ({
                ...settings,
                pixiv: { ...settings.pixiv, refreshToken: 'expired' },
            }),
            sleep: async () => undefined,
            fetchContext: async () => {
                fetched += 1;

                return {
                    ...fakeContext('111111', 'r2'),
                    illust: null,
                    authRequired: true,
                };
            },
        });

        expect(summary.authRequired).toBe(true);
        expect(fetched).toBe(1);
    });

    it('keeps the jitter inside 100–1000ms by default and maps the speed presets', () => {
        expect(nextPixivDelay(() => 0)).toBe(100);
        expect(nextPixivDelay(() => 0.999999)).toBe(1000);
        expect(nextPixivDelay(() => 0, 'slow')).toBe(1000);
        expect(nextPixivDelay(() => 0.999999, 'slow')).toBe(3000);
        expect(nextPixivDelay(() => 0, 'fast')).toBe(50);
        expect(nextPixivDelay(() => 0.999999, 'fast')).toBe(300);
    });

    it('skips unavailable works without treating them as consecutive failures', async () => {
        const { settings, context } = createPixivAlbum('Deleted works');

        for (let index = 0; index < 6; index += 1) {
            seedAsset(context, `d${index}`, `11111${index}_p0.jpg`, Date.parse(`2026-01-0${index + 1}T00:00:00.000Z`) / 1000);
        }

        let fetched = 0;
        const deletedAssets = new Set<string>();
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => ({
                ...settings,
                pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
            }),
            random: () => 0,
            sleep: async () => undefined,
            fetchContext: async (_settings, _albumId, assetId) => {
                fetched += 1;

                if (fetched <= 5) {
                    deletedAssets.add(assetId);
                    throw new ApiError(404, 'pixiv_illust_not_found', 'The illustration was deleted.');
                }

                return fakeContext('111115', assetId);
            },
            scheduleRetry: () => undefined,
        });

        expect(summary.deleted).toBe(5);
        expect(summary.failed).toBe(0);
        expect(summary.network).toBe(1);
        expect(getPixivAutoFetchStatus().albums.find(item => item.albumId === context.index.id)).toMatchObject({
            status: 'completed',
            deleted: 5,
            failed: 0,
            retryAt: '',
        });

        // 失效作品写入相册副本与全局库，断点永久标记为 missing
        const albumInvalid = [...listInvalidPixivIllustIds(context.db.pixiv.$client)];
        const globalInvalid = [...listInvalidPixivIllustIds(pixivDatabase().$client)];

        expect(albumInvalid).toHaveLength(5);
        expect(new Set(globalInvalid)).toEqual(new Set(albumInvalid));
        expect(context.db.album.select().from(pixivFetchMarks).all()
            .filter(mark => albumInvalid.includes(mark.illustId))
            .every(mark => mark.status === 'missing')).toBe(true);

        // 手动“立即补全”也不会再请求已失效作品，只重试尚未补全的正常作品
        const forcedFetched: string[] = [];

        await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => ({
                ...settings,
                pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
            }),
            random: () => 0,
            sleep: async () => undefined,
            ignoreMarkCooldown: true,
            fetchContext: async (_settings, _albumId, assetId) => {
                forcedFetched.push(assetId);

                return fakeContext('111115', assetId);
            },
            scheduleRetry: () => undefined,
        });

        expect(forcedFetched.some(assetId => deletedAssets.has(assetId))).toBe(false);
    });

    it('pauses on rate limits and schedules an automatic retry', async () => {
        const { settings, context } = createPixivAlbum('Rate limited');

        seedAsset(context, 'l1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);

        const retries: { albumId: string, delayMs: number }[] = [];
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => ({
                ...settings,
                pixiv: { ...settings.pixiv, refreshToken: 'test-token' },
            }),
            random: () => 0,
            sleep: async () => undefined,
            fetchContext: async () => {
                throw new PixivRateLimitError('rate limited', 120_000);
            },
            scheduleRetry: (albumId, delayMs) => {
                retries.push({ albumId, delayMs });
            },
        });

        expect(summary.rateLimited).toBe(true);
        expect(summary.retryAfterMs).toBe(120_000);
        expect(retries).toEqual([{ albumId: context.index.id, delayMs: 120_000 }]);

        const status = getPixivAutoFetchStatus().albums.find(item => item.albumId === context.index.id);

        expect(status).toMatchObject({
            status: 'paused',
            error: 'rate_limited',
        });
        expect(Date.parse(status?.retryAt ?? '')).toBeGreaterThan(Date.now());
    });

    it('uses the configured speed for the next request delay', async () => {
        const { settings, context } = createPixivAlbum('Fast speed');

        seedAsset(context, 'f1', '111111_p0.jpg', Date.parse('2026-01-01T00:00:00.000Z') / 1000);

        const sleeps: number[] = [];
        const summary = await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => ({
                ...settings,
                pixiv: {
                    ...settings.pixiv,
                    refreshToken: 'test-token',
                    autoFetchSpeed: 'fast',
                },
            }),
            random: () => 0,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            fetchContext: async (_settings, _albumId, assetId) => fakeContext('111111', assetId),
        });

        expect(summary.network).toBe(1);
        expect(sleeps).toEqual([50]);
    });

    it('prunes expired fetch marks but keeps fresh and missing ones', async () => {
        const { settings, context } = createPixivAlbum('Marks');
        const db = context.db.album;
        const now = Date.parse('2026-06-01T00:00:00.000Z');
        const at = (msAgo: number): number => Math.floor((now - msAgo) / 1000);
        const DAY = 24 * 60 * 60 * 1000;

        db.insert(pixivFetchMarks).values([
            { illustId: '111111', status: 'done', attemptedAt: at(30 * DAY) },
            { illustId: '222222', status: 'done', attemptedAt: at(DAY) },
            { illustId: '333333', status: 'failed', attemptedAt: at(2 * DAY) },
            { illustId: '444444', status: 'failed', attemptedAt: at(60 * 60 * 1000) },
            { illustId: '555555', status: 'missing', attemptedAt: at(365 * DAY) },
        ]).run();

        await runPixivAutoFetchAlbum(context.index.id, {
            settings: () => settings,
            now: () => now,
            sleep: async () => undefined,
        });

        const remaining = db
            .select({ id: pixivFetchMarks.illustId })
            .from(pixivFetchMarks)
            .all()
            .map(row => row.id)
            .sort();

        // done 超过 7 天、failed 超过 24 小时的断点被裁掉；missing 永久保留
        expect(remaining).toEqual(['222222', '444444', '555555']);
    });
});
