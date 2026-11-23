import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { closeAlbumDatabase, closeAllAlbumDatabases } from '../server/database/album';
import { createThumbStore } from '../server/album/thumb-store';
import { getAlbum } from '../server/album/album-store';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { removeAlbumTree } from './cleanup';

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-security-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(() => {
    closeAllAlbumDatabases();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        removeAlbumTree(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

async function createAlbum(name: string): Promise<{ id: string }> {
    const response = await app.request('/albums', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
    });

    expect(response.status).toBe(201);

    return (await response.json()).data;
}

async function waitForThumbMaintenance(albumId: string): Promise<{ status: string, removed: number }> {
    const deadline = Date.now() + 10_000;

    for (;;) {
        const response = await app.request(`/albums/${albumId}/thumbnails`);
        const data = (await response.json()).data as {
            maintenance: { status: string, removed: number }
        };

        if (data.maintenance.status !== 'running') {
            return data.maintenance;
        }
        if (Date.now() > deadline) {
            throw new Error('thumbnail maintenance timed out');
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function waitForThumbWarmup(albumId: string): Promise<void> {
    const deadline = Date.now() + 10_000;

    for (;;) {
        const response = await app.request(`/albums/${albumId}/thumbnails`);
        const data = (await response.json()).data as {
            warmup: { status: string }
        };

        if (data.warmup.status !== 'running') {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error('thumbnail warmup timed out');
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function importAndWait(albumId: string, rootPath: string): Promise<void> {
    const started = await app.request(`/albums/${albumId}/imports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootPath }),
    });
    const jobId = (await started.json()).data.id;
    const deadline = Date.now() + 20_000;

    for (;;) {
        const job: { status: string } = (await (await app.request(`/albums/${albumId}/imports/${jobId}`)).json()).data;

        if (job.status === 'completed') {
            return;
        }
        if (job.status === 'failed') {
            throw new Error('import failed');
        }
        if (Date.now() > deadline) {
            throw new Error('import did not finish');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function makeImages(root: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await sharp({ create: { width: 48, height: 36, channels: 3, background: { r: index * 20 + 5, g: 40, b: 70 } } })
            .png()
            .toFile(join(root, `photo-${index + 1}.png`));
    }
}

describe('security headers and request origin', () => {
    it('rejects unknown hosts and cross-site origins, and marks API responses nosniff', async () => {
        const badHost = await app.request('/health', { headers: { host: 'evil.example' } });

        expect(badHost.status).toBe(403);
        expect((await badHost.json()).code).toBe('host_not_allowed');

        const crossSite = await app.request('/albums', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'origin': 'http://evil.example',
            },
            body: JSON.stringify({ name: 'Cross Site' }),
        });

        expect(crossSite.status).toBe(403);
        expect((await crossSite.json()).code).toBe('origin_not_allowed');

        const health = await app.request('/health');

        expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('masks the external api key and keeps it when the mask is submitted unchanged', async () => {
        const saved = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ai: { external: { apiKey: 'secret-key' } } }),
        });

        expect(saved.status).toBe(200);

        const read = await app.request('/settings');
        const masked = (await read.json()).data.ai.external.apiKey;

        expect(masked).toBe('********');

        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ai: { external: { apiKey: masked, model: 'gpt-test' } } }),
        });

        expect(getSettings().ai.external.apiKey).toBe('secret-key');
        expect(getSettings().ai.external.model).toBe('gpt-test');

        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ai: { external: { apiKey: '' } } }),
        });
    });
});

describe('import root guard', () => {
    it('rejects an import folder inside the album directory', async () => {
        const album = await createAlbum('Self Import');
        const context = getAlbum(getSettings(), album.id);
        const response = await app.request(`/albums/${album.id}/imports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootPath: context.dir }),
        });

        expect(response.status).toBe(422);
        expect((await response.json()).code).toBe('import_root_invalid');
    });
});

function removeTagDatabase(albumDir: string): void {
    for (const suffix of ['tag.db', 'tag.db-wal', 'tag.db-shm']) {
        removeAlbumTree(join(albumDir, 'data', suffix), { force: true, maxRetries: 10, retryDelay: 100 });
    }
}

describe('corrupt metadata files', () => {
    it('serves empty tags but refuses to edit when tag.db is unusable', async () => {
        const album = await createAlbum('Corrupt Tags');
        const context = getAlbum(getSettings(), album.id);

        closeAlbumDatabase(context.dir);
        removeTagDatabase(context.dir);

        const tagPath = join(context.dir, 'data', 'tag.db');

        mkdirSync(tagPath, { recursive: true });

        const list = await app.request(`/albums/${album.id}/tags`);

        // 只读展示降级为空列表，避免拖垮相册上下文/查看器
        expect(list.status).toBe(200);
        expect((await list.json()).data).toEqual([]);

        const create = await app.request(`/albums/${album.id}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'should-not-write' }),
        });

        expect(create.status).toBe(500);
        expect((await create.json()).code).toBe('tag_file_corrupt');

        closeAlbumDatabase(context.dir);
        removeAlbumTree(tagPath, { recursive: true, force: true });
    });

    it('reports a corrupt index.json instead of pretending the album is missing', async () => {
        const album = await createAlbum('Corrupt Index');
        const context = getAlbum(getSettings(), album.id);

        writeFileSync(join(context.dir, 'index.json'), '{ nope');

        const detail = await app.request(`/albums/${album.id}`);

        expect(detail.status).toBe(500);
        expect((await detail.json()).code).toBe('album_index_corrupt');

        const list: { data: { id: string, corrupt: boolean }[] } = await (await app.request('/albums?page=1&pageSize=100')).json();

        expect(list.data.find(item => item.id === album.id)?.corrupt).toBe(true);
    });
});

describe('batch asset operations, cover and search', () => {
    it('batch links tags, sets a cover, searches with FTS and supports batch trash actions', async () => {
        const album = await createAlbum('Batch Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-batch-'));

        try {
            await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 20, b: 30 } } })
                .png()
                .toFile(join(root, 'sunset-beach.png'));
            await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 40, g: 50, b: 60 } } })
                .png()
                .toFile(join(root, 'sunrise.png'));
            await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 70, g: 80, b: 90 } } })
                .png()
                .toFile(join(root, 'city.png'));

            await importAndWait(album.id, root);

            const all: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const ids = all.data.map(item => item.id);

            expect(ids).toHaveLength(3);

            const longMatch: { data: { filename: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&q=sunse`)).json();

            expect(longMatch.data.map(item => item.filename)).toEqual(['sunset-beach.png']);

            const prefixMatch: { data: { filename: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&q=sunr`)).json();

            expect(prefixMatch.data.map(item => item.filename)).toEqual(['sunrise.png']);

            const shortMatch: { data: { filename: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&q=ci`)).json();

            expect(shortMatch.data.map(item => item.filename)).toEqual(['city.png']);

            const tag = await app.request(`/albums/${album.id}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'travel' }),
            });
            const tagId = (await tag.json()).data.id;

            const linked = await app.request(`/albums/${album.id}/assets/batch-tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: ids.slice(0, 2), addTagIds: [tagId] }),
            });

            expect(linked.status).toBe(200);
            expect((await linked.json()).data.linked).toBe(2);

            const detail: { data: { tags: { id: string }[] } } = await (await app.request(`/albums/${album.id}/assets/${ids[0]}`)).json();

            expect(detail.data.tags.map(item => item.id)).toContain(tagId);

            const cover = await app.request(`/albums/${album.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ coverAssetId: ids[0] }),
            });

            expect(cover.status).toBe(200);
            expect((await cover.json()).data.coverAssetId).toBe(ids[0]);

            const autoCover = await app.request(`/albums/${album.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ coverAssetId: null }),
            });
            const autoCoverBody: { data: { coverAssetId: string | null } } = await autoCover.json();

            // 「恢复自动封面」立刻落回相册内的一张有效图片，而不是留空等下次对账
            expect(autoCover.status).toBe(200);
            expect(ids).toContain(autoCoverBody.data.coverAssetId);

            const deleted = await app.request(`/albums/${album.id}/assets/batch-delete`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: ids.slice(0, 2), confirm: true }),
            });

            expect(deleted.status).toBe(200);
            expect((await deleted.json()).data.removed).toBe(2);

            const active: { data: unknown[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(active.data).toHaveLength(1);

            const nav: { data: { total: number, index: number } } = await (await app.request(`/albums/${album.id}/assets/${ids[2]}/neighbors`)).json();

            expect(nav.data.total).toBe(1);
            expect(nav.data.index).toBe(0);

            const restored = await app.request(`/albums/${album.id}/assets/batch-restore`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: ids.slice(0, 2) }),
            });

            expect(restored.status).toBe(200);
            expect((await restored.json()).data.restored).toBe(2);

            await app.request(`/albums/${album.id}/assets/batch-delete`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: ids.slice(0, 2), confirm: true }),
            });

            const purged = await app.request(`/albums/${album.id}/trash/batch-purge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: ids.slice(0, 2), confirm: true }),
            });

            expect(purged.status).toBe(200);
            expect((await purged.json()).data.removed).toBe(2);

            const trash: { data: unknown[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&trash=true`)).json();

            expect(trash.data).toEqual([]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('favorites', () => {
    it('toggles a favorite and filters the asset list', async () => {
        const album = await createAlbum('Favorites');
        const root = mkdtempSync(join(tmpdir(), 'picturex-fav-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';
            const patched = await app.request(`/albums/${album.id}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ favorite: true }),
            });

            expect(patched.status).toBe(200);
            expect((await patched.json()).data.favorite).toBe(true);

            const favorites: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&favorite=true`)).json();

            expect(favorites.data.map(item => item.id)).toEqual([assetId]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('live photo and svg delivery', () => {
    it('imports a live photo sidecar once, streams it and cleans it up on purge', async () => {
        const album = await createAlbum('Live Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-live-'));

        try {
            await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } })
                .jpeg()
                .toFile(join(root, 'live.jpg'));
            writeFileSync(join(root, 'live.mov'), 'fake-mov-bytes');

            await importAndWait(album.id, root);

            const list: { data: { id: string, kind: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(list.data).toHaveLength(1);
            expect(list.data[0]?.kind).toBe('dynamic');

            const detail: { data: { live: { mime: string, size: number } | null } } = await (await app.request(`/albums/${album.id}/assets/${list.data[0]?.id}`)).json();

            expect(detail.data.live?.mime).toBe('video/quicktime');
            expect(detail.data.live?.size).toBe('fake-mov-bytes'.length);

            const live = await app.request(`/albums/${album.id}/assets/${list.data[0]?.id}/live`);

            expect(live.status).toBe(200);
            expect(await live.text()).toBe('fake-mov-bytes');

            await app.request(`/albums/${album.id}/assets/${list.data[0]?.id}`, { method: 'DELETE' });
            await app.request(`/albums/${album.id}/trash/${list.data[0]?.id}`, { method: 'DELETE' });

            const gone = await app.request(`/albums/${album.id}/assets/${list.data[0]?.id}/live`);

            expect(gone.status).toBe(404);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('serves svg originals as attachments with a sandbox csp', async () => {
        const album = await createAlbum('Svg Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-svg-'));

        try {
            writeFileSync(
                join(root, 'mark.svg'),
                '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#123456"/></svg>',
            );

            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const file = await app.request(`/albums/${album.id}/assets/${list.data[0]?.id}/file`);

            expect(file.status).toBe(200);
            expect(file.headers.get('content-disposition')).toContain('attachment');
            expect(file.headers.get('content-security-policy')).toContain('sandbox');
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('reports thumbnail storage stats and compacts it on demand', async () => {
        const album = await createAlbum('Thumb Stats');
        const root = mkdtempSync(join(tmpdir(), 'picturex-thumbstats-'));

        try {
            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';
            const thumbnail = await app.request(`/albums/${album.id}/assets/${assetId}/thumbnail?size=256`);

            expect(thumbnail.status).toBe(200);

            const statsResponse = await app.request(`/albums/${album.id}/thumbnails`);

            expect(statsResponse.status).toBe(200);

            const stats = (await statsResponse.json()).data;

            // 导入不预生成缩略图，首次请求只写请求的尺寸
            expect(stats.count).toBe(1);
            expect(stats.totalBytes).toBeGreaterThan(0);
            expect(stats.autoOptimize).toBe(true);

            const optimized = await app.request(`/albums/${album.id}/thumbnails/optimize`, { method: 'POST' });

            expect(optimized.status).toBe(202);
            expect((await optimized.json()).data.status).toBe('running');
            expect((await waitForThumbMaintenance(album.id)).status).toBe('completed');

            const after = (await (await app.request(`/albums/${album.id}/thumbnails`)).json()).data;

            // 小库执行 PRAGMA optimize 可能新增 stat 页；只要求不出现异常膨胀
            expect(after.fileBytes).toBeLessThan(stats.fileBytes + 128 * 1024);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('only permanently deletes assets that are already in the trash', async () => {
        const album = await createAlbum('Trash Guard');
        const root = mkdtempSync(join(tmpdir(), 'picturex-trashguard-'));

        try {
            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';

            const directPurge = await app.request(`/albums/${album.id}/trash/${assetId}`, { method: 'DELETE' });

            expect(directPurge.status).toBe(409);
            expect((await directPurge.json()).code).toBe('asset_not_in_trash');

            const trashed = await app.request(`/albums/${album.id}/assets/${assetId}`, { method: 'DELETE' });

            expect(trashed.status).toBe(204);

            const purge = await app.request(`/albums/${album.id}/trash/${assetId}`, { method: 'DELETE' });

            expect(purge.status).toBe(204);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('serves a larger configured thumbnail instead of a smaller cached one', async () => {
        const album = await createAlbum('Thumb Gap');
        const root = mkdtempSync(join(tmpdir(), 'picturex-thumbgap-'));

        try {
            const patched = await app.request('/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ thumbnails: { sizes: [256, 1024] } }),
            });

            expect(patched.status).toBe(200);

            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';
            const context = getAlbum(getSettings(), album.id);

            await waitForThumbWarmup(album.id);
            await app.request(`/albums/${album.id}/thumbnails`, { method: 'DELETE' });
            await waitForThumbMaintenance(album.id);

            const response = await app.request(`/albums/${album.id}/assets/${assetId}/thumbnail?size=512`);

            expect(response.status).toBe(200);

            const sizes = createThumbStore(context.db.thumbnails, 1024, album.id).assetSizes(assetId);

            // 配置里没有 512 时生成 1024，并直接返回 1024，而不是回退到 256
            expect(sizes).toEqual([1024]);
        }
        finally {
            await app.request('/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ thumbnails: { sizes: [256, 512] } }),
            });
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('lazily generates, clears and regenerates thumbnails on demand', async () => {
        const album = await createAlbum('Preview Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-preview-'));

        try {
            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';
            const context = getAlbum(getSettings(), album.id);

            const thumbStore = () => createThumbStore(context.db.thumbnails, 1024, album.id);

            await waitForThumbWarmup(album.id);
            await app.request(`/albums/${album.id}/thumbnails`, { method: 'DELETE' });
            await waitForThumbMaintenance(album.id);

            expect(thumbStore().count()).toBe(0);

            const generated = await app.request(`/albums/${album.id}/assets/${assetId}/thumbnail?size=256`);

            expect(generated.status).toBe(200);

            const sizes = thumbStore().assetSizes(assetId).sort((a, b) => a - b);

            expect(sizes).toEqual([256]);

            const cleared = await app.request(`/albums/${album.id}/thumbnails`, { method: 'DELETE' });

            expect(cleared.status).toBe(202);
            expect((await waitForThumbMaintenance(album.id)).status).toBe('completed');
            expect(thumbStore().count()).toBe(0);

            const regenerated = await app.request(`/albums/${album.id}/assets/${assetId}/thumbnail?size=256`);

            expect(regenerated.status).toBe(200);

            expect(thumbStore().assetSizes(assetId)).toEqual([256]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});
