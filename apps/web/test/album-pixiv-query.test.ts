import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAlbum, getAlbum, updateAlbum, type AlbumContext } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeCloudDatabase } from '../server/database/cloud';
import { closeGlobalDatabase } from '../server/database/global';
import { closePixivDatabase } from '../server/database/pixiv';
import { assets, pixivAssetLinks } from '../server/database/schemas/album';
import { linkPixivAsset, upsertIllust } from '../server/pixiv/store';
import { syncPixivDatabase } from '../server/pixiv/database-sync';
import type { PixivIllust } from '../server/pixiv/types';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import type { AppEnv } from '../server/hono/env';

let app: Hono<AppEnv>;
let dataDir: string;
let context: AlbumContext;

function shaFor(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

function seedAsset(
    target: AlbumContext,
    id: string,
    filename: string,
    addedAt: number,
    illustId: string,
    pageIndex: number,
): void {
    target.db.album.insert(assets).values({
        id,
        storageKey: `storage/0001/${id}.jpg`,
        filename,
        ext: 'jpg',
        mime: 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 100,
        sha256: shaFor(id),
        takenAt: null,
        addedAt,
        deletedAt: null,
        meta: JSON.stringify({ pixiv: { illustId, pageIndex } }),
    }).run();
    linkPixivAsset(target.db.album, illustId, pageIndex, id);
}

function fakeIllust(
    illustId: string,
    title: string,
    userName: string,
    tags: string[],
    pageCount = 1,
): PixivIllust {
    return {
        illustId,
        title,
        type: 'illust',
        caption: '',
        userId: `user-${userName}`,
        userName,
        userAccount: userName.toLowerCase(),
        pageCount,
        width: 100,
        height: 100,
        xRestrict: 0,
        sanityLevel: 0,
        illustAiType: 1,
        createDate: '2026-01-01T00:00:00.000Z',
        totalView: 0,
        totalBookmarks: 0,
        tags: tags.map(name => ({ name, translatedName: null })),
        pages: [],
        ugoira: null,
    };
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-album-pixiv-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;

    const settings = getSettings();
    const album = createAlbum(settings, { name: 'Pixiv Album' });

    updateAlbum(settings, album.id, { settings: { pixivEnabled: true } });

    context = getAlbum(settings, album.id);

    seedAsset(context, 'a0', '200000_p0.jpg', 1_800_000_000, '200000', 0);
    seedAsset(context, 'a1', '200000_p1.jpg', 1_800_000_001, '200000', 1);
    seedAsset(context, 'b0', '300000_p0.jpg', 1_800_000_002, '300000', 0);
    context.db.album.insert(assets).values({
        id: 'c0',
        storageKey: 'storage/0001/c0.jpg',
        filename: 'holiday.jpg',
        ext: 'jpg',
        mime: 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 100,
        sha256: shaFor('c0'),
        takenAt: null,
        addedAt: 1_800_000_003,
        deletedAt: null,
        meta: '{}',
    }).run();

    upsertIllust(context.db.pixiv, fakeIllust('200000', 'Sunset Work', 'Artist A', ['landscape', 'sunset'], 2));
    upsertIllust(context.db.pixiv, fakeIllust('300000', 'City Night', 'Artist B', ['city']));
});

afterAll(() => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    closeCloudDatabase();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

async function list(query: string): Promise<{ data: { id: string }[], pagination?: { nextCursor: string | null } }> {
    const response = await app.request(`/albums/${context.index.id}/assets?${query}`);

    expect(response.status).toBe(200);

    return response.json();
}

describe('album pixiv filters', () => {
    it('lists Pixiv tags with local asset counts', async () => {
        const response = await app.request(`/albums/${context.index.id}/pixiv/tags`);
        const body = await response.json() as {
            data: { tagId: string, name: string, count: number }[]
        };

        expect(response.status).toBe(200);
        expect(body.data.map(tag => [tag.name, tag.count])).toEqual([
            ['landscape', 2],
            ['city', 1],
            ['sunset', 2],
        ].sort((left, right) => Number(right[1]) - Number(left[1]) || String(left[0]).localeCompare(String(right[0]))));
    });

    it('searches Pixiv titles, artists and work tags', async () => {
        expect((await list('q=Sunset')).data.map(item => item.id).sort()).toEqual(['a0', 'a1']);
        expect((await list('q=Artist+B')).data.map(item => item.id)).toEqual(['b0']);
        expect((await list('q=city')).data.map(item => item.id)).toEqual(['b0']);
        expect((await list('q=holiday')).data.map(item => item.id)).toEqual(['c0']);
    });

    it('filters by a Pixiv tag id', async () => {
        const response = await app.request(`/albums/${context.index.id}/pixiv/tags`);
        const body = await response.json() as { data: { tagId: string, name: string }[] };
        const tag = body.data.find(item => item.name === 'sunset');

        expect(tag).toBeTruthy();
        expect((await list(`pixivTag=${tag?.tagId}`)).data.map(item => item.id).sort()).toEqual(['a0', 'a1']);
    });

    it('sorts by numeric Pixiv id with non-Pixiv assets last', async () => {
        const result = await list('sort=pixivId&order=desc&limit=10');

        expect(result.data.map(item => item.id)).toEqual(['b0', 'a1', 'a0', 'c0']);

        const firstResponse = await app.request(`/albums/${context.index.id}/assets?sort=pixivId&order=desc&limit=2`);
        const firstPage = await firstResponse.json() as {
            data: { id: string }[]
            pagination: { nextCursor: string | null }
        };
        const secondResponse = await app.request(
            `/albums/${context.index.id}/assets?sort=pixivId&order=desc&limit=2&cursor=${encodeURIComponent(firstPage.pagination.nextCursor ?? '')}`,
        );
        const secondPage = await secondResponse.json() as { data: { id: string }[] };

        expect([...firstPage.data, ...secondPage.data].map(item => item.id))
            .toEqual(['b0', 'a1', 'a0', 'c0']);
    });
});

describe('library images', () => {
    it('serves the local album copy before touching the cloud cache', async () => {
        syncPixivDatabase();

        const original = await app.request('/pixiv/library/image?illustId=200000&page=0&variant=original');

        expect(original.status).toBe(302);
        expect(original.headers.get('location')).toBe(
            `/api/v1/albums/${context.index.id}/assets/a0/file`,
        );

        const medium = await app.request('/pixiv/library/image?illustId=200000&page=0&variant=medium');

        expect(medium.status).toBe(302);
        expect(medium.headers.get('location')).toBe(
            `/api/v1/albums/${context.index.id}/assets/a0/thumbnail?size=512`,
        );
    });
});

describe('viewer neighbors', () => {
    async function neighbors(assetId: string, query: string) {
        const response = await app.request(
            `/albums/${context.index.id}/assets/${assetId}/neighbors?${query}`,
        );

        expect(response.status).toBe(200);

        return response.json() as Promise<{
            data: { previous: { id: string } | null, next: { id: string } | null, previousItems: { id: string }[], nextItems: { id: string }[] }
        }>;
    }

    it('keeps local pages of the same work consecutive regardless of sort', async () => {
        const p0 = (await neighbors('a0', 'sort=filename&order=asc&span=10')).data;

        expect(p0.next?.id).toBe('a1');

        const p1 = (await neighbors('a1', 'sort=filename&order=asc&span=10')).data;

        expect(p1.previous?.id).toBe('a0');
    });

    it('keeps descending list order outside a page group', async () => {
        const fromB0 = (await neighbors('b0', 'sort=addedAt&order=desc&span=10')).data;

        expect(fromB0.next?.id).toBe('a1');
        expect(fromB0.previous?.id).toBe('c0');

        const fromA0 = (await neighbors('a0', 'sort=addedAt&order=desc&span=10')).data;

        expect(fromA0.next?.id).toBe('a1');
        expect(fromA0.previous?.id).toBe('b0');
    });

    it('keeps order and page grouping while a search filter is active', async () => {
        const p0 = (await neighbors('a0', 'sort=filename&order=asc&q=Sunset&span=10')).data;

        expect(p0.next?.id).toBe('a1');
        expect(p0.previous).toBeNull();

        const p1 = (await neighbors('a1', 'sort=filename&order=asc&q=Sunset&span=10')).data;

        expect(p1.previous?.id).toBe('a0');
        expect(p1.next).toBeNull();
    });

    it('follows the active list filters', async () => {
        const filtered = (await neighbors('b0', 'sort=pixivId&order=desc&q=City&span=10')).data;

        expect(filtered.previous).toBeNull();
        expect(filtered.next).toBeNull();
        expect(filtered.previousItems).toEqual([]);
        expect(filtered.nextItems).toEqual([]);
    });
});

describe('pixiv page mapping', () => {
    it('keeps the existing page when duplicate bytes resolve to one asset', () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Duplicate Bytes' });
        const ctx = getAlbum(settings, album.id);

        ctx.db.album.insert(assets).values({
            id: 'dup0',
            storageKey: 'storage/0001/dup0.jpg',
            filename: '400000_p0.jpg',
            ext: 'jpg',
            mime: 'image/jpeg',
            kind: 'image',
            size: 100,
            width: 100,
            height: 100,
            sha256: shaFor('dup0'),
            takenAt: null,
            addedAt: 1_800_000_100,
            deletedAt: null,
            meta: '{}',
        }).run();

        expect(linkPixivAsset(ctx.db.album, '400000', 0, 'dup0')).toBe(true);
        // 第 1 页下载得到相同字节，会解析到同一个 asset：不能把第 0 页的映射顶掉，
        // 同时要返回 false，让同步把该页计入失败而不是报成功
        expect(linkPixivAsset(ctx.db.album, '400000', 1, 'dup0')).toBe(false);

        expect(ctx.db.album.select().from(pixivAssetLinks).all()).toEqual([
            { assetId: 'dup0', illustId: '400000', pageIndex: 0 },
        ]);
    });
});
