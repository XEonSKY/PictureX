import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import type { AlbumContext } from '../server/album/album-store';
import { createAlbum, createTag, getAlbum } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase, createInMemoryGlobalDatabase, globalDatabase } from '../server/database/global';
import { assets, assetTags } from '../server/database/schemas/album';
import { describeDataDirectories } from '../server/utils/data-dir';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { forgetViewerMedia, getViewerMedia, registerViewerMedia, setViewerMediaTags } from '../server/viewer/media-store';

let app: Hono<AppEnv>;
let dataDir: string;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const SHA_F = 'f'.repeat(64);
const SHA_G = '1'.repeat(64);

function removeTagDatabase(dir: string): void {
    for (const suffix of ['tag.db', 'tag.db-wal', 'tag.db-shm']) {
        rmSync(join(dir, 'data', suffix), { force: true, maxRetries: 10, retryDelay: 100 });
    }
}

function media(sha256: string, filename: string, lastPath: string | null = null) {
    return {
        sha256,
        kind: 'image' as const,
        mime: 'image/jpeg',
        filename,
        lastPath,
        size: 1234,
        width: 100,
        height: 200,
    };
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-viewer-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(() => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('data-dir viewer paths', () => {
    it('exposes the databases under <dataDir>/data', () => {
        const directories = describeDataDirectories({ env: { NUXT_DATA_DIR: '/tmp/px-data' }, isProduction: true });

        expect(directories.databaseDir).toBe(join('/tmp/px-data', 'data'));
        expect(directories.pictureDbPath).toBe(join('/tmp/px-data', 'data', 'picture.db'));
        expect(directories.pixivDbPath).toBe(join('/tmp/px-data', 'data', 'pixiv.db'));
        expect(directories.globalTagDbPath).toBe(join('/tmp/px-data', 'data', 'tag.db'));
        expect(directories.taskDbPath).toBe(join('/tmp/px-data', 'data', 'task.db'));
    });
});

describe('viewer media store (in-memory)', () => {
    it('keys records by content hash, not by path', () => {
        const db = createInMemoryGlobalDatabase();

        registerViewerMedia(db, media(SHA_A, 'old-name.jpg', '/nowhere/a.jpg'));
        // 同内容换路径/换名再打开：sha256 相同，复用同一条记录，标签不丢
        setViewerMediaTags(db, SHA_A, []);

        const reRegistered = registerViewerMedia(db, media(SHA_A, 'moved.jpg', '/somewhere/else/a.jpg'));

        expect(reRegistered.sha256).toBe(SHA_A);
        expect(reRegistered.filename).toBe('moved.jpg');
        expect(reRegistered.lastPath).toBe('/somewhere/else/a.jpg');

        const found = getViewerMedia(db, SHA_A);

        expect(found?.media.sha256).toBe(SHA_A);
    });

    it('replaces the whole tag set on patch and rejects unknown tags', () => {
        const db = createInMemoryGlobalDatabase();

        registerViewerMedia(db, media(SHA_B, 'b.jpg'));

        expect(() => setViewerMediaTags(db, SHA_B, ['does-not-exist'])).toThrow();

        forgetViewerMedia(db, SHA_B);
        expect(getViewerMedia(db, SHA_B)).toBeNull();
    });
});

describe('viewer HTTP API', () => {
    it('creates, lists, renames and deletes global tags', async () => {
        const created = await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Cat', color: '#f00' }),
        });

        expect(created.status).toBe(201);
        const tag = (await created.json()).data as { id: string, name: string };

        expect(created.headers.get('location')).toBe(`/api/v1/viewer/tags/${tag.id}`);
        expect(tag.name).toBe('Cat');

        const conflict = await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'cat' }),
        });

        expect(conflict.status).toBe(409);
        expect((await conflict.json()).code).toBe('tag_name_conflict');

        const list = await app.request('/viewer/tags');
        const tags = (await list.json()).data as { id: string }[];

        expect(tags.map(item => item.id)).toContain(tag.id);

        const renamed = await app.request(`/viewer/tags/${tag.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Kitten' }),
        });

        expect(renamed.status).toBe(200);
        expect((await renamed.json()).data.name).toBe('Kitten');

        const removed = await app.request(`/viewer/tags/${tag.id}`, { method: 'DELETE' });

        expect(removed.status).toBe(204);
    });

    it('validates tag input', async () => {
        const empty = await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: '   ' }),
        });

        expect(empty.status).toBe(422);

        const missing = await app.request('/viewer/tags/unknown-id', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Ghost' }),
        });

        expect(missing.status).toBe(404);
    });

    it('registers media, associates tags and reads them back by hash', async () => {
        const tag = (await (await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Sunset' }),
        })).json()).data as { id: string };

        const registered = await app.request('/viewer/media', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(media(SHA_A, 'beach.jpg', '/tmp/beach.jpg')),
        });

        // 规范要求创建资源返回 201 + Location
        expect(registered.status).toBe(201);
        expect(registered.headers.get('location')).toBe(`/api/v1/viewer/media/${SHA_A}`);

        const patched = await app.request(`/viewer/media/${SHA_A}/tags`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tagIds: [tag.id] }),
        });

        expect(patched.status).toBe(200);

        const fetched = await app.request(`/viewer/media/${SHA_A}`);
        const data = (await fetched.json()).data as { tagIds: string[], filename: string };

        expect(data.tagIds).toEqual([tag.id]);
        expect(data.filename).toBe('beach.jpg');

        const unknownTag = await app.request(`/viewer/media/${SHA_A}/tags`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tagIds: ['nope'] }),
        });

        expect(unknownTag.status).toBe(404);

        // 关联清理：删除标签后媒体记录里的关联也要消失
        const removed = await app.request(`/viewer/media/${SHA_A}`, { method: 'DELETE' });

        expect(removed.status).toBe(204);

        const gone = await app.request(`/viewer/media/${SHA_A}`);

        expect((await gone.json()).data).toBeNull();

        await app.request(`/viewer/tags/${tag.id}`, { method: 'DELETE' });
    });

    it('rejects malformed sha256', async () => {
        const bad = await app.request('/viewer/media/zzz', { method: 'GET' });

        expect(bad.status).toBe(422);
    });

    it('serves empty tags but refuses to edit when tag.db is unusable', async () => {
        closeGlobalDatabase();
        removeTagDatabase(dataDir);

        const tagPath = join(dataDir, 'data', 'tag.db');

        mkdirSync(tagPath, { recursive: true });

        const list = await app.request('/viewer/tags');

        // 只读展示降级为空，避免整页不可用
        expect(list.status).toBe(200);
        expect((await list.json()).data).toEqual([]);

        const response = await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'ShouldFail' }),
        });

        expect(response.status).toBe(500);
        expect((await response.json()).code).toBe('tag_file_corrupt');

        closeGlobalDatabase();
        rmSync(tagPath, { recursive: true, force: true });
    });

    it('does not aggregate album assets or tags into the global library', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Global Excluded' });
        const context = getAlbum(settings, album.id);
        const albumTag = createTag(settings, album.id, { name: 'Album Only' });

        seedAsset(context, 'asset-a1', SHA_E, Date.parse('2026-01-01T00:00:00.000Z') / 1000);
        linkTag(context, 'asset-a1', albumTag.id);

        const mediaList = await (await app.request('/viewer/media?limit=500')).json();

        expect(mediaList.data.some((item: { sha256: string }) => item.sha256 === SHA_E)).toBe(false);

        const tags = (await (await app.request('/viewer/tags')).json()).data as { name: string }[];

        expect(tags.some(tag => tag.name === 'Album Only')).toBe(false);

        // 全局散图库不再保留相册聚合字段
        closeGlobalDatabase();

        const reopened = globalDatabase();
        const mediaColumns = (reopened.$client.prepare('PRAGMA table_info(viewer_media)').all() as { name: string }[])
            .map(column => column.name);
        const tagColumns = (reopened.$client.prepare('PRAGMA table_info(viewer_media_tags)').all() as { name: string }[])
            .map(column => column.name);

        expect(mediaColumns).not.toContain('album_id');
        expect(mediaColumns).not.toContain('asset_id');
        expect(tagColumns).not.toContain('source');
        expect(reopened.$client
            .prepare('SELECT count(*) AS n FROM viewer_media WHERE sha256 = ?')
            .get(SHA_E)).toEqual({ n: 0 });
    });

    it('paginates discrete viewer images and filters them by tag', async () => {
        const tag = (await (await app.request('/viewer/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Loose Images' }),
        })).json()).data as { id: string };

        for (const [sha, name] of [[SHA_C, 'loose-a.jpg'], [SHA_D, 'loose-b.jpg']] as const) {
            const registered = await app.request('/viewer/media', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(media(sha, name, `/tmp/${name}`)),
            });

            expect(registered.status).toBe(201);

            const patched = await app.request(`/viewer/media/${sha}/tags`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tagIds: [tag.id] }),
            });

            expect(patched.status).toBe(200);
        }

        const firstPage = await (await app.request(`/viewer/media?limit=1&tagId=${tag.id}`)).json();
        const secondPage = await (await app.request(
            `/viewer/media?limit=1&tagId=${tag.id}&cursor=${encodeURIComponent(firstPage.pagination.nextCursor)}`,
        )).json();

        expect(firstPage.total).toBe(2);
        expect(firstPage.data).toHaveLength(1);
        expect(firstPage.pagination.hasMore).toBe(true);
        expect(secondPage.data).toHaveLength(1);
        expect(secondPage.total).toBe(2);
        expect(secondPage.pagination.hasMore).toBe(false);
        expect(firstPage.data[0].sha256).not.toBe(secondPage.data[0].sha256);
        expect(firstPage.data[0].tagIds).toEqual([tag.id]);

        await app.request(`/viewer/media/${SHA_C}`, { method: 'DELETE' });
        await app.request(`/viewer/media/${SHA_D}`, { method: 'DELETE' });
        await app.request(`/viewer/tags/${tag.id}`, { method: 'DELETE' });
    });

    it('imports, recolors, merges and clears global tags', async () => {
        const json = { 'content-type': 'application/json' };
        const post = (path: string, body: unknown) => app.request(path, {
            method: 'POST',
            headers: json,
            body: JSON.stringify(body),
        });
        const createTag = async (name: string, color?: string) => (await post('/viewer/tags', { name, color })).json()
            .then(body => body.data as { id: string, name: string, color: string });

        const target = await createTag('Merge A', '#112233');
        const source = await createTag('Merge B');

        expect(source.color).toMatch(/^#[0-9a-f]{6}$/iu);

        for (const [sha, tagIds] of [[SHA_F, [target.id, source.id]], [SHA_G, [source.id]]] as const) {
            const registered = await post('/viewer/media', media(sha, `${sha.slice(0, 4)}.jpg`));

            expect(registered.status).toBe(201);

            const patched = await app.request(`/viewer/media/${sha}/tags`, {
                method: 'PATCH',
                headers: json,
                body: JSON.stringify({ tagIds }),
            });

            expect(patched.status).toBe(200);
        }

        const imported = await (await post('/viewer/tags/import', {
            tags: [{ name: 'Imported', color: '#abcdef' }, { name: 'Merge A' }],
        })).json();

        expect(imported.data).toEqual({ added: 1, skipped: 1 });

        const recolored = await (await post('/viewer/tags/colors', { mode: 'random', onlyEmpty: false })).json();

        expect(recolored.data.updated).toBeGreaterThan(0);
        expect(recolored.data.tags.every((tag: { color: string }) => /^#[0-9a-f]{6}$/iu.test(tag.color))).toBe(true);

        const merged = await (await post('/viewer/tags/merge', {
            sourceIds: [source.id],
            targetId: target.id,
        })).json();

        expect(merged.data).toEqual({ removed: 1, moved: 1 });

        const targetTags = await (await app.request(`/viewer/media/${SHA_F}`)).json();
        const sourceTags = await (await app.request(`/viewer/media/${SHA_G}`)).json();
        const tagsAfterMerge = (await (await app.request('/viewer/tags')).json()).data as { id: string }[];

        expect(targetTags.data.tagIds).toEqual([target.id]);
        expect(sourceTags.data.tagIds).toEqual([target.id]);
        expect(tagsAfterMerge.some(tag => tag.id === source.id)).toBe(false);

        const exported = await app.request('/viewer/tags/export');

        expect(exported.status).toBe(200);
        expect(exported.headers.get('content-disposition')).toContain('picturex-global-tags.json');
        expect((await exported.json()).library.scope).toBe('global');

        const cleared = await (await post('/viewer/tags/delete-all', { confirm: true })).json();

        expect(cleared.data.removed).toBeGreaterThan(0);
        expect((await (await app.request('/viewer/tags')).json()).data).toEqual([]);
        expect((await (await app.request(`/viewer/media/${SHA_F}`)).json()).data.tagIds).toEqual([]);
    });

    it('reads from the shared global database', () => {
        expect(globalDatabase()).toBeTruthy();
    });
});

function seedAsset(context: AlbumContext, id: string, sha256: string, addedAt: number): void {
    context.db.album.insert(assets).values({
        id,
        storageKey: `storage/0001/${id}.jpg`,
        filename: `${id}.jpg`,
        ext: 'jpg',
        mime: 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 200,
        sha256,
        takenAt: null,
        addedAt,
        meta: '{}',
    }).run();
}

function linkTag(context: AlbumContext, assetId: string, tagId: string): void {
    context.db.album.insert(assetTags).values({
        assetId,
        tagId,
        createdAt: Math.floor(Date.now() / 1000),
    }).run();
}
