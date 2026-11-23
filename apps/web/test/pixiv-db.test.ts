import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAlbum, getAlbum, updateAlbum, type AlbumContext } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase } from '../server/database/global';
import { closePixivDatabase, markPixivIllustInvalid, pixivDatabase } from '../server/database/pixiv';
import {
    assets,
    pixivAssetLinks as albumPixivAssetLinks,
} from '../server/database/schemas/album';
import { illusts, illustTags, pixivTags, pixivUsers } from '../server/database/schemas/pixiv';
import { syncPixivDatabase, resetPixivDatabaseSyncForTests } from '../server/pixiv/database-sync';
import { backfillAlbumPixivLinks } from '../server/pixiv/link-backfill';
import { linkPixivAsset, upsertIllust } from '../server/pixiv/store';
import { storeNewAsset } from '../server/ingest/store-asset';
import type { PixivIllust } from '../server/pixiv/types';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import type { Settings } from '../server/settings/setting-schema';

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-pixiv-db-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();
});

afterEach(() => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    resetPixivDatabaseSyncForTests();
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

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function seedPixivAsset(context: AlbumContext, assetId: string, illustId: string): void {
    context.db.album.insert(assets).values({
        id: assetId,
        storageKey: `storage/0001/${assetId}.jpg`,
        filename: `${illustId}_p0.jpg`,
        ext: 'jpg',
        mime: 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 100,
        sha256: shaFor(assetId),
        takenAt: null,
        addedAt: nowSeconds(),
        deletedAt: null,
        meta: JSON.stringify({ pixiv: { illustId, pageIndex: 0 } }),
    }).run();
    upsertIllust(context.db.pixiv, fakeIllust(illustId));
    linkPixivAsset(context.db.album, illustId, 0, assetId);
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
        tags: [{ name: `tag-${illustId}`, translatedName: null }],
        pages: [],
        ugoira: null,
    };
}

describe('global pixiv database', () => {
    it('aggregates only albums with Pixiv enabled', () => {
        const settings: Settings = getSettings();
        const enabled = createAlbum(settings, { name: 'Enabled' });
        const disabled = createAlbum(settings, { name: 'Disabled' });

        updateAlbum(settings, enabled.id, { settings: { pixivEnabled: true } });

        const enabledContext = getAlbum(settings, enabled.id);
        const disabledContext = getAlbum(settings, disabled.id);

        seedPixivAsset(enabledContext, 'asset-enabled', '111111');
        seedPixivAsset(disabledContext, 'asset-disabled', '222222');

        const result = syncPixivDatabase();

        expect(result.albums).toBe(1);
        expect(result.illusts).toBe(1);
        expect(result.users).toBe(1);
        expect(result.tags).toBe(1);

        const db = pixivDatabase();
        const rows = db.select().from(illusts).all();

        expect(rows.map(row => row.illustId)).toEqual(['111111']);
        // 全局库不再保存 asset ↔ illust 映射；映射只留在相册
        expect(db.$client.prepare("SELECT name FROM sqlite_master WHERE name = 'pixiv_asset_links'").get())
            .toBeUndefined();
        expect(enabledContext.db.album.select().from(albumPixivAssetLinks).all()).toHaveLength(1);

        // 幂等：再次同步不会重复
        const again = syncPixivDatabase();

        expect(again.illusts).toBe(1);
        expect(again.tags).toBe(1);

        // 相册里有更新的作品详情时，全局库按 fetched_at 覆盖旧值
        enabledContext.db.pixiv
            .update(illusts)
            .set({
                title: 'Updated title',
                fetchedAt: nowSeconds() + 60,
            })
            .where(eq(illusts.illustId, '111111'))
            .run();

        syncPixivDatabase();

        expect(db.select().from(illusts).all().find(row => row.illustId === '111111')?.title)
            .toBe('Updated title');

        // 更旧的相册快照不能回退全局详情，也不能改写标签关系
        enabledContext.db.pixiv
            .update(illusts)
            .set({
                title: 'Older title',
                fetchedAt: nowSeconds() - 3600,
            })
            .where(eq(illusts.illustId, '111111'))
            .run();

        syncPixivDatabase();

        expect(db.select().from(illusts).all().find(row => row.illustId === '111111')?.title)
            .toBe('Updated title');
        expect(db.select().from(pixivTags).all().map(tag => tag.name)).toEqual(['tag-111111']);
    });

    it('propagates unavailable marks but keeps cached details', () => {
        const settings: Settings = getSettings();
        const album = createAlbum(settings, { name: 'Unavailable' });

        updateAlbum(settings, album.id, { settings: { pixivEnabled: true } });

        const context = getAlbum(settings, album.id);

        seedPixivAsset(context, 'asset-unavailable', '111111');

        markPixivIllustInvalid(context.db.pixiv.$client, '111111', nowSeconds() + 60);
        syncPixivDatabase();

        const global = pixivDatabase();
        const row = global.select().from(illusts).all().find(item => item.illustId === '111111');

        expect(row?.invalidAt).toBeGreaterThan(0);
        expect(row?.title).toBe('Title 111111');

        // 相册重新拉取到更新的有效详情后，汇总会清除全局失效标记
        context.db.pixiv
            .update(illusts)
            .set({ invalidAt: 0, fetchedAt: nowSeconds() + 120 })
            .where(eq(illusts.illustId, '111111'))
            .run();

        syncPixivDatabase();

        expect(pixivDatabase().select().from(illusts).all()
            .find(item => item.illustId === '111111')?.invalidAt).toBe(0);
    });

    it('creates a placeholder on import and replaces it with synced details', async () => {
        const settings: Settings = getSettings();
        const album = createAlbum(settings, { name: 'Filename Import' });

        updateAlbum(settings, album.id, { settings: { pixivEnabled: true } });

        const context = getAlbum(settings, album.id);
        const file = join(dataDir, '123456_p0.jpg');

        await sharp({
            create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } },
        }).jpeg().toFile(file);

        const bytes = readFileSync(file);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const stored = await storeNewAsset({
            settings,
            albumDir: context.dir,
            db: context.db.album,
            filePath: file,
            sha256,
            size: statSync(file).size,
        });

        expect(stored.assetId).not.toBeNull();

        const localLink = context.db.album
            .select()
            .from(albumPixivAssetLinks)
            .all()
            .find(row => row.assetId === stored.assetId);

        expect(localLink).toMatchObject({ illustId: '123456', pageIndex: 0 });

        // 导入时全局库只有占位行，不含详情
        const placeholder = pixivDatabase()
            .select()
            .from(illusts)
            .all()
            .find(row => row.illustId === '123456');

        expect(placeholder).toMatchObject({ illustId: '123456', fetchedAt: 0 });

        // 后台补全成功后，汇总写入的详情才是最终数据
        upsertIllust(context.db.pixiv, fakeIllust('123456'));
        syncPixivDatabase();

        const detail = pixivDatabase()
            .select()
            .from(illusts)
            .all()
            .find(row => row.illustId === '123456');
        const user = pixivDatabase().select().from(pixivUsers).all()[0];
        const tags = pixivDatabase().select().from(pixivTags).all();

        expect(detail?.title).toBe('Title 123456');
        expect(detail?.fetchedAt).toBeGreaterThan(0);
        expect(user).toMatchObject({ userId: '1', name: 'user', account: 'user' });
        expect(tags.map(tag => tag.name)).toEqual(['tag-123456']);
        expect(pixivDatabase().select().from(illustTags).all()).toHaveLength(1);
    });

    it('backfills filename mappings and creates placeholders for every work', async () => {
        const settings: Settings = getSettings();
        const album = createAlbum(settings, { name: 'Backfill' });
        const context = getAlbum(settings, album.id);

        updateAlbum(settings, album.id, { settings: { pixivEnabled: true } });

        for (const [id, illustId, page] of [
            ['asset-a', '123456', 0],
            ['asset-b', '123456', 1],
            ['asset-c', '654321', 0],
        ] as const) {
            context.db.album.insert(assets).values({
                id,
                storageKey: `storage/0001/${id}.jpg`,
                filename: `${illustId}_p${page}.jpg`,
                ext: 'jpg',
                mime: 'image/jpeg',
                kind: 'image',
                size: 100,
                width: 100,
                height: 100,
                sha256: shaFor(id),
                takenAt: null,
                addedAt: nowSeconds(),
                deletedAt: null,
                meta: '{}',
            }).run();
        }

        expect(context.db.album.select().from(albumPixivAssetLinks).all()).toHaveLength(0);

        const first = await backfillAlbumPixivLinks(album.id);

        expect(first.added).toBe(3);
        expect(context.db.album.select().from(albumPixivAssetLinks).all()).toHaveLength(3);

        // 文件名回填的映射也要写回 meta.pixiv，保证 Pixiv ID 排序与搜索可用
        const backfilled = context.db.album.select().from(assets).all();

        expect(backfilled.map(row => JSON.parse(row.meta).pixiv?.illustId).sort())
            .toEqual(['123456', '123456', '654321']);
        expect(backfilled.map(row => row.pixivIllustNum).sort()).toEqual([123456, 123456, 654321]);

        // 已完成标记：再次调用直接跳过，不重复扫描/写入
        expect(await backfillAlbumPixivLinks(album.id)).toMatchObject({ added: 0, skipped: true });

        syncPixivDatabase();

        const rows = pixivDatabase().select().from(illusts).all();

        expect(rows.map(row => row.illustId).sort()).toEqual(['123456', '654321']);
        expect(rows.every(row => row.fetchedAt === 0)).toBe(true);
    });
});
