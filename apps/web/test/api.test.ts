import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeTaskDatabase } from '../server/database/task';
import { createAiJob, updateAiJob } from '../server/album/ai-job-store';
import { createImportJob, updateImportJob } from '../server/album/import-job-store';
import { getAlbum } from '../server/album/album-store';
import { modelRegistry } from '../server/model/model-registry';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { removeAlbumTree } from './cleanup';

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-api-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(() => {
    closeAllAlbumDatabases();
    closeTaskDatabase();
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

    const body = await response.json();

    return body.data;
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

describe('health and settings', () => {
    it('serves health and patched theme', async () => {
        const health = await app.request('/health');

        expect(health.status).toBe(200);

        const patched = await app.request('/settings/theme', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: 'dark' }),
        });

        expect(patched.status).toBe(200);

        const body = await patched.json();

        expect(body.data.preset).toBe('dark');

        const settings = await app.request('/settings');

        expect((await settings.json()).data.theme.preset).toBe('dark');
    });

    it('returns 422 problem details for invalid settings', async () => {
        const response = await app.request('/settings/theme', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: 'neon' }),
        });

        expect(response.status).toBe(422);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect((await response.json()).code).toBe('validation_failed');
    });
});

describe('request body size limit', () => {
    it('rejects an oversized declared body with 413 before touching it', async () => {
        const response = await app.request('/albums', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(3 * 1024 * 1024),
            },
            body: '{}',
        });

        expect(response.status).toBe(413);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect((await response.json()).code).toBe('payload_too_large');
    });

    it('lets a normal body through to validation', async () => {
        const response = await app.request('/albums', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(JSON.stringify({ name: 'Small Body' }).length),
            },
            body: JSON.stringify({ name: 'Small Body' }),
        });

        expect(response.status).toBe(201);

        await app.request(`/albums/${(await response.clone().json()).data.id}`, { method: 'DELETE' });
    });
});

describe('settings credential protection', () => {
    it('masks proxy credentials on read and preserves them on a masked write-back', async () => {
        const saved = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixiv: { proxyUrl: 'socks5://user:secret@127.0.0.1:10808' } }),
        });

        expect(saved.status).toBe(200);
        expect((await saved.json()).data.pixiv.proxyUrl).toBe('socks5://***:***@127.0.0.1:10808');

        const fetched = await app.request('/settings');
        const read = (await fetched.json()).data;

        expect(read.pixiv.proxyUrl).toBe('socks5://***:***@127.0.0.1:10808');
        expect(JSON.stringify(read)).not.toContain('secret');

        // 用户没动代理地址，表单原样回传掩码：服务端必须回填真实凭据而不是写回 ***
        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixiv: { proxyUrl: 'socks5://***:***@127.0.0.1:10808' } }),
        });

        expect(getSettings().pixiv.proxyUrl).toBe('socks5://user:secret@127.0.0.1:10808');
    });

    it('preserves percent-encoded proxy credentials on a masked port change', async () => {
        const original = 'socks5://us%40er:p%25ss%3Aword@127.0.0.1:10808';

        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixiv: { proxyUrl: original } }),
        });

        expect(getSettings().pixiv.proxyUrl).toBe(original);

        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixiv: { proxyUrl: 'socks5://***:***@127.0.0.1:10809' } }),
        });

        // 回填必须只解码一次，不能把 %40 变成 %2540
        expect(getSettings().pixiv.proxyUrl).toBe('socks5://us%40er:p%25ss%3Aword@127.0.0.1:10809');
    });

    it('keeps a proxy without credentials untouched', async () => {
        const response = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pixiv: { proxyUrl: 'socks5://127.0.0.1:10808' } }),
        });

        expect((await response.json()).data.pixiv.proxyUrl).toBe('socks5://127.0.0.1:10808');
    });

    it('requires https (or loopback http) for the external AI base url', async () => {
        const insecure = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ai: { external: { baseUrl: 'http://10.0.0.5:11434' } } }),
        });

        expect(insecure.status).toBe(422);
        expect((await insecure.json()).code).toBe('validation_failed');

        for (const url of ['https://api.openai.com/v1', 'http://localhost:11434', 'http://127.0.0.1:11434', '']) {
            const ok = await app.request('/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ai: { external: { baseUrl: url } } }),
            });

            expect(ok.status, url).toBe(200);
        }
    });
});

describe('albums', () => {
    it('creates, lists, reads, patches and deletes', async () => {
        const created = await createAlbum('Roadtrip');
        const response = await app.request('/albums');

        expect(response.status).toBe(200);

        const list = await response.json();

        expect(list.data.some((album: { id: string }) => album.id === created.id)).toBe(true);
        expect(list.pagination.total).toBeGreaterThan(0);

        const read = await app.request(`/albums/${created.id}`);

        expect((await read.json()).data.name).toBe('Roadtrip');

        const patched = await app.request(`/albums/${created.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ description: 'Updated' }),
        });

        expect((await patched.json()).data.description).toBe('Updated');

        const removed = await app.request(`/albums/${created.id}`, { method: 'DELETE' });

        expect(removed.status).toBe(204);
    });

    it('enforces validation, conflicts and not-found semantics', async () => {
        const invalid = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: '' }),
        });

        expect(invalid.status).toBe(422);

        const created = await createAlbum('Duplicate');
        const conflict = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Duplicate' }),
        });

        expect(conflict.status).toBe(409);
        expect((await conflict.json()).code).toBe('album_name_conflict');

        const missing = await app.request(`/albums/${created.id}/assets`);

        expect(missing.status).toBe(200);

        const unknown = await app.request('/albums/01a167eb-b046-7742-b060-4dabd084a850');

        expect(unknown.status).toBe(404);
        expect((await unknown.json()).code).toBe('album_not_found');
    });

    it('rejects a missing import root with 404', async () => {
        const album = await createAlbum('Import target');
        const response = await app.request(`/albums/${album.id}/imports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootPath: join(dataDir, 'does-not-exist') }),
        });

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe('import_root_not_found');
    });
});

describe('tags', () => {
    it('creates, lists, patches, links and deletes', async () => {
        const album = await createAlbum('Tags');
        const createdTag = await app.request(`/albums/${album.id}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Travel', color: '#0A59F7' }),
        });

        expect(createdTag.status).toBe(201);

        const tag = (await createdTag.json()).data;
        const list = await app.request(`/albums/${album.id}/tags`);

        expect((await list.json()).data[0].count).toBe(0);

        const patched = await app.request(`/albums/${album.id}/tags/${tag.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Trips' }),
        });

        expect((await patched.json()).data.name).toBe('Trips');

        const duplicate = await app.request(`/albums/${album.id}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Trips' }),
        });

        expect(duplicate.status).toBe(409);

        const removed = await app.request(`/albums/${album.id}/tags/${tag.id}`, { method: 'DELETE' });

        expect(removed.status).toBe(204);
    });

    it('returns 404 for unknown tags', async () => {
        const album = await createAlbum('Tags 404');
        const response = await app.request(`/albums/${album.id}/tags/unknown`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'X' }),
        });

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe('tag_not_found');
    });
});

describe('ai tagging', () => {
    it('rejects local tagging when the model is not installed', async () => {
        const album = await createAlbum('AI local');
        const response = await app.request(`/albums/${album.id}/ai/tag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'zero-shot' }),
        });

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe('ai_model_missing');
    });

    it('rejects external tagging when it is not configured', async () => {
        const album = await createAlbum('AI external');
        const response = await app.request(`/albums/${album.id}/ai/tag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'external' }),
        });

        expect(response.status).toBe(422);
        expect((await response.json()).code).toBe('ai_external_disabled');
    });
});

describe('models, jobs and unknown routes', () => {
    it('lists catalog models and 404s unknown models', async () => {
        const list = await app.request('/models');

        expect(list.status).toBe(200);
        expect((await list.json()).data.length).toBeGreaterThanOrEqual(2);

        const unknown = await app.request('/models/nope');

        expect(unknown.status).toBe(404);
        expect((await unknown.json()).code).toBe('model_not_found');
    });

    it('cleans up installed models that are no longer selected', async () => {
        const registry = modelRegistry(getSettings());

        registry.markInstalled('clip-vit-base-patch32', [{ path: 'model.onnx', size: 0, sha256: '' }]);

        try {
            const switched = await app.request('/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ai: { localModelId: 'custom-local', captioningModelId: 'custom-caption' } }),
            });

            expect(switched.status).toBe(200);

            const cleaned = await app.request('/models/cleanup', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: true, mode: 'unused' }),
            });

            expect(cleaned.status).toBe(200);

            const body = await cleaned.json();

            expect(body.data.removed).toContain('clip-vit-base-patch32');

            const list: { data: { id: string, status: string }[] } = await (await app.request('/models')).json();

            expect(list.data.find(model => model.id === 'clip-vit-base-patch32')?.status).toBe('available');
        }
        finally {
            await app.request('/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ai: {
                        localModelId: 'clip-vit-base-patch32',
                        captioningModelId: 'vit-gpt2-image-captioning',
                    },
                }),
            });
        }
    });

    it('lists aggregated jobs', async () => {
        const response = await app.request('/jobs');

        expect(response.status).toBe(200);
        expect(Array.isArray((await response.json()).data)).toBe(true);
    });

    it('clears finished jobs for a tab and album scope', async () => {
        const album = await createAlbum('Clear Jobs');
        const root = mkdtempSync(join(tmpdir(), 'picturex-clear-jobs-'));

        try {
            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const before: { data: unknown[] } = await (await app.request(`/jobs?albumId=${album.id}&type=import`)).json();

            expect(before.data.length).toBeGreaterThan(0);

            const cleared = await app.request('/jobs/clear', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ type: 'import', albumId: album.id, confirm: true }),
            });
            const result = (await cleared.json()).data;

            expect(cleared.status).toBe(200);
            expect(result.removed).toBeGreaterThanOrEqual(1);

            const after: { data: unknown[] } = await (await app.request(`/jobs?albumId=${album.id}&type=import`)).json();

            expect(after.data).toEqual([]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('returns RFC 9457 for unknown routes', async () => {
        const response = await app.request('/missing-route');

        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect((await response.json()).code).toBe('route_not_found');
    });
});

describe('one asset with several tags', () => {
    async function ingestOneImage(albumId: string): Promise<string> {
        const root = mkdtempSync(join(tmpdir(), 'picturex-tag-media-'));

        await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 80, b: 160 } } })
            .jpeg({ quality: 80 })
            .toFile(join(root, 'one.jpg'));

        const importResponse = await app.request(`/albums/${albumId}/imports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rootPath: root }),
        });

        expect(importResponse.status).toBe(202);

        const started = Date.now();

        for (;;) {
            const list = await app.request(`/albums/${albumId}/assets?limit=10`);
            const body: { data: { id: string }[] } = await list.json();

            if (body.data.length > 0) {
                removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

                return body.data[0].id;
            }

            if (Date.now() - started > 20_000) {
                throw new Error('import did not ingest the image');
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    async function createTag(albumId: string, name: string): Promise<string> {
        const response = await app.request(`/albums/${albumId}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        expect(response.status).toBe(201);

        const body = await response.json();

        return body.data.id;
    }

    it('links two tags to the same asset, lists both and unlinks one', async () => {
        const album = await createAlbum('Several Tags');
        const assetId = await ingestOneImage(album.id);
        const first = await createTag(album.id, 'Travel');
        const second = await createTag(album.id, 'Night');

        for (const tagId of [first, second]) {
            const link = await app.request(`/albums/${album.id}/assets/${assetId}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tagId }),
            });

            expect(link.status).toBe(201);
        }

        const detail = await app.request(`/albums/${album.id}/assets/${assetId}`);
        const body: { data: { tags: { id: string }[] } } = await detail.json();

        expect(body.data.tags.map(tag => tag.id).sort()).toEqual([first, second].sort());

        const counts: { data: { id: string, count: number }[] } = await (await app.request(`/albums/${album.id}/tags`)).json();

        expect(counts.data.every(tag => tag.count === 1)).toBe(true);

        const unlink = await app.request(`/albums/${album.id}/assets/${assetId}/tags/${first}`, { method: 'DELETE' });

        expect(unlink.status).toBe(204);

        const after: { data: { tags: { id: string }[] } } = await (await app.request(`/albums/${album.id}/assets/${assetId}`)).json();

        expect(after.data.tags.map(tag => tag.id)).toEqual([second]);
    }, 30_000);
});

describe('albums on custom paths', () => {
    it('creates outside the data dir and reports the album missing once the directory is gone', async () => {
        const root = mkdtempSync(join(tmpdir(), 'picturex-ext-album-'));
        const dir = join(root, 'External Album');
        const created = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'External', dir }),
        });

        expect(created.status).toBe(201);

        const album = (await created.json()).data;

        expect(album.dir).toBe(normalize(dir));
        expect(album.missing).toBe(false);

        removeAlbumTree(dir, { recursive: true, force: true });

        const list: { data: { id: string, name: string, dir: string, missing: boolean }[] }
            = await (await app.request('/albums?pageSize=100')).json();
        const entry = list.data.find(item => item.id === album.id);

        expect(entry?.missing).toBe(true);
        expect(entry?.name).toBe('External');

        const detail = await app.request(`/albums/${album.id}`);

        expect(detail.status).toBe(404);
        expect((await detail.json()).code).toBe('album_missing');

        const removed = await app.request(`/albums/${album.id}`, { method: 'DELETE' });

        expect(removed.status).toBe(204);

        const after: { data: { id: string }[] } = await (await app.request('/albums?pageSize=100')).json();

        expect(after.data.some(item => item.id === album.id)).toBe(false);
        removeAlbumTree(root, { recursive: true, force: true });
    }, 30_000);

    it('rejects relative paths and non-album directories', async () => {
        const relative = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Relative', dir: 'relative/album' }),
        });

        expect(relative.status).toBe(422);
        expect((await relative.json()).code).toBe('album_path_invalid');

        const root = mkdtempSync(join(tmpdir(), 'picturex-ext-dir-'));
        const busy = join(root, 'busy');

        mkdirSync(busy, { recursive: true });
        writeFileSync(join(busy, 'note.txt'), 'not an album');

        const conflict = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Busy', dir: busy }),
        });

        expect(conflict.status).toBe(409);
        expect((await conflict.json()).code).toBe('album_path_not_empty');

        removeAlbumTree(root, { recursive: true, force: true });
    });
});

describe('directory picker and linking existing albums', () => {
    it('lists directories, marks album folders and rejects non-directories', async () => {
        const root = mkdtempSync(join(tmpdir(), 'picturex-fs-'));

        mkdirSync(join(root, 'photos'), { recursive: true });
        mkdirSync(join(root, 'album'), { recursive: true });
        writeFileSync(
            join(root, 'album', 'index.json'),
            JSON.stringify({ schemaVersion: 1, id: '01a17bbb-0000-7000-8000-000000000001', name: 'Picked' }),
        );
        writeFileSync(join(root, 'note.txt'), 'x');

        const listing = await app.request(`/fs/list?path=${encodeURIComponent(root)}`);
        const body: { data: { path: string, entries: { name: string, isAlbum: boolean }[] } } = await listing.json();
        const names = body.data.entries.map(entry => entry.name);

        expect(listing.status).toBe(200);
        expect(names).toEqual(['album', 'photos']);
        expect(body.data.entries.find(entry => entry.name === 'album')?.isAlbum).toBe(true);
        expect(body.data.entries.find(entry => entry.name === 'photos')?.isAlbum).toBe(false);

        const roots = await app.request('/fs/roots');

        expect(roots.status).toBe(200);
        expect(((await roots.json()).data as unknown[]).length).toBeGreaterThan(0);

        const missing = await app.request(`/fs/list?path=${encodeURIComponent(join(root, 'missing'))}`);

        expect(missing.status).toBe(404);
        expect((await missing.json()).code).toBe('fs_not_found');

        const file = await app.request(`/fs/list?path=${encodeURIComponent(join(root, 'note.txt'))}`);

        expect(file.status).toBe(422);
        expect((await file.json()).code).toBe('fs_not_directory');

        removeAlbumTree(root, { recursive: true, force: true });
    });

    it('links an existing album directory once', async () => {
        const root = mkdtempSync(join(tmpdir(), 'picturex-link-'));

        writeFileSync(
            join(root, 'index.json'),
            JSON.stringify({ schemaVersion: 1, id: '01a17bbb-0000-7000-8000-000000000002', name: 'Linked Album' }),
        );
        writeFileSync(join(root, 'tag.json'), JSON.stringify({ schemaVersion: 1, tags: [] }));

        const linked = await app.request('/albums/link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: root }),
        });

        expect(linked.status).toBe(201);
        expect((await linked.json()).data.name).toBe('Linked Album');

        const again = await app.request('/albums/link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: root }),
        });

        expect(again.status).toBe(409);
        expect((await again.json()).code).toBe('album_path_conflict');

        const empty = mkdtempSync(join(tmpdir(), 'picturex-link-empty-'));
        const notAlbum = await app.request('/albums/link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: empty }),
        });

        expect(notAlbum.status).toBe(404);
        expect((await notAlbum.json()).code).toBe('album_import_not_found');

        removeAlbumTree(root, { recursive: true, force: true });
        removeAlbumTree(empty, { recursive: true, force: true });
    });
});

describe('unlinking albums', () => {
    it('keeps files on disk by default and deletes them only when asked', async () => {
        const root = mkdtempSync(join(tmpdir(), 'picturex-unlink-'));

        const firstResponse = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Unlink A', dir: join(root, 'a') }),
        });
        const albumA = (await firstResponse.json()).data;
        const unlinked = await app.request(`/albums/${albumA.id}`, { method: 'DELETE' });

        expect(unlinked.status).toBe(204);
        expect(existsSync(join(albumA.dir, 'index.json'))).toBe(true);

        const list: { data: { id: string }[] } = await (await app.request('/albums?pageSize=100')).json();

        expect(list.data.some(item => item.id === albumA.id)).toBe(false);

        const relink = await app.request('/albums/link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: albumA.dir }),
        });

        expect(relink.status).toBe(201);

        const secondResponse = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Unlink B', dir: join(root, 'b') }),
        });
        const albumB = (await secondResponse.json()).data;
        // 访问一次相册，确保中心缩略图库已创建
        getAlbum(getSettings(), albumB.id);

        const thumbDb = join(dataDir, 'data', 'thumbnails.db');

        expect(existsSync(thumbDb)).toBe(true);

        const purged = await app.request(`/albums/${albumB.id}?deleteFiles=true`, { method: 'DELETE' });

        expect(purged.status).toBe(204);
        expect(existsSync(albumB.dir)).toBe(false);
        // 统一缩略图库由其它相册共享，只清理该相册的行
        expect(existsSync(thumbDb)).toBe(true);

        removeAlbumTree(root, { recursive: true, force: true });
    });
});

describe('cancelling imports', () => {
    async function importStatus(albumId: string, jobId: string): Promise<{ status: string, processed: number, total: number, finishedAt: string | null }> {
        const response = await app.request(`/albums/${albumId}/imports/${jobId}`);

        expect(response.status).toBe(200);

        return (await response.json()).data;
    }

    it('stops a running import and leaves it cancelled', async () => {
        const album = await createAlbum('Cancel Import');
        const root = mkdtempSync(join(tmpdir(), 'picturex-cancel-'));

        try {
            for (let index = 0; index < 120; index += 1) {
                await sharp({
                    create: {
                        width: 160,
                        height: 120,
                        channels: 3,
                        background: { r: index % 256, g: (index * 7) % 256, b: (index * 13) % 256 },
                    },
                }).jpeg({ quality: 80 }).toFile(join(root, `frame-${String(index).padStart(3, '0')}.jpg`));
            }

            const started = await app.request(`/albums/${album.id}/imports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ rootPath: root }),
            });

            expect(started.status).toBe(202);

            const jobId = (await started.json()).data.id;
            const cancelled = await app.request(`/albums/${album.id}/imports/${jobId}/cancel`, { method: 'POST' });

            expect(cancelled.status).toBe(202);

            const deadline = Date.now() + 15_000;
            let job = await importStatus(album.id, jobId);

            while (job.status === 'running' && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
                job = await importStatus(album.id, jobId);
            }

            expect(job.status).toBe('cancelled');
            expect(job.finishedAt).not.toBeNull();
            expect(job.processed).toBeLessThan(job.total);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('rejects cancelling a finished import with 409', async () => {
        const album = await createAlbum('Cancel Finished');
        const root = mkdtempSync(join(tmpdir(), 'picturex-cancel-done-'));

        try {
            await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 60, b: 90 } } })
                .jpeg()
                .toFile(join(root, 'one.jpg'));

            const started = await app.request(`/albums/${album.id}/imports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ rootPath: root }),
            });
            const jobId = (await started.json()).data.id;
            const deadline = Date.now() + 15_000;
            let job = await importStatus(album.id, jobId);

            while (job.status === 'running' && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
                job = await importStatus(album.id, jobId);
            }

            expect(job.status).toBe('completed');

            const cancelled = await app.request(`/albums/${album.id}/imports/${jobId}/cancel`, { method: 'POST' });

            expect(cancelled.status).toBe(409);
            expect((await cancelled.json()).code).toBe('job_not_running');
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('AI device capabilities', () => {
    it('reports available execution backends and the accelerator model id', async () => {
        const response = await app.request('/settings/ai/devices');

        expect(response.status).toBe(200);

        const body = await response.json();

        expect(body.data.preference).toBe('auto');
        expect(typeof body.data.platform).toBe('string');
        expect(body.data.available.some((device: { id: string }) => device.id === 'cpu')).toBe(true);
        expect(body.data.acceleratorModelId).toBe('clip-vit-base-patch32-fp16');
        expect(typeof body.data.acceleratorInstalled).toBe('boolean');
    });
});

describe('similarity index', () => {
    it('persists groups in the background and serves them without recomputing', async () => {
        const album = await createAlbum('Similar Index');
        const root = mkdtempSync(join(tmpdir(), 'picturex-similar-'));

        try {
            await sharp({ create: { width: 96, height: 72, channels: 3, background: { r: 120, g: 80, b: 40 } } })
                .jpeg()
                .toFile(join(root, 'a.jpg'));
            await sharp({ create: { width: 96, height: 72, channels: 3, background: { r: 121, g: 81, b: 41 } } })
                .jpeg()
                .toFile(join(root, 'b.jpg'));

            const started = await app.request(`/albums/${album.id}/imports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ rootPath: root }),
            });
            const jobId = (await started.json()).data.id;
            const importDeadline = Date.now() + 15_000;

            for (;;) {
                const status: { status: string } = (await (await app.request(`/albums/${album.id}/imports/${jobId}`)).json()).data;

                if (status.status === 'completed' || status.status === 'failed') {
                    expect(status.status).toBe('completed');
                    break;
                }
                if (Date.now() > importDeadline) {
                    throw new Error('import did not finish');
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            const deadline = Date.now() + 15_000;
            let body: { data: { assets: { distance: number }[] }[], meta: { rebuilding: boolean, indexedThreshold: number | null } } = {
                data: [],
                meta: { rebuilding: true, indexedThreshold: null },
            };

            for (;;) {
                const response = await app.request(`/albums/${album.id}/groups/similar?threshold=8&limit=10`);

                expect(response.status).toBe(200);
                body = await response.json();

                if (!body.meta.rebuilding) {
                    break;
                }
                if (Date.now() > deadline) {
                    throw new Error('similarity index did not finish');
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            expect(body.meta.indexedThreshold).toBe(8);
            expect(body.data.length).toBeGreaterThan(0);
            expect(body.data[0]?.assets.length).toBeGreaterThanOrEqual(2);
            expect(typeof body.data[0]?.assets[0]?.distance).toBe('number');
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('tag export and AI job control', () => {
    it('exports every tag with counts as a downloadable json attachment', async () => {
        const album = await createAlbum('Export Tags');

        for (const name of ['Trip', 'Family']) {
            const created = await app.request(`/albums/${album.id}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, color: '#0a59f7' }),
            });

            expect(created.status).toBe(201);
        }

        const response = await app.request(`/albums/${album.id}/tags/export`);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-disposition')).toContain('attachment');

        const body = await response.json();

        expect(body.album.id).toBe(album.id);
        expect(body.tags.map((tag: { name: string }) => tag.name).sort()).toEqual(['Family', 'Trip']);
        expect(body.tags[0]).toMatchObject({ count: 0, color: '#0a59f7' });
    });

    it('answers 404 for AI job controls on a missing job', async () => {
        const album = await createAlbum('AI Controls');

        for (const action of ['pause', 'resume', 'cancel']) {
            const response = await app.request(`/albums/${album.id}/ai/jobs/missing/${action}`, { method: 'POST' });

            expect(response.status).toBe(404);
            expect((await response.json()).code).toBe('job_not_found');
        }
    });
});

describe('tag import and batch management', () => {
    async function createTag(albumId: string, name: string): Promise<string> {
        const response = await app.request(`/albums/${albumId}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        expect(response.status).toBe(201);

        return (await response.json()).data.id;
    }

    it('imports tags, merges them and batch deletes', async () => {
        const album = await createAlbum('Tag Batch');
        const root = mkdtempSync(join(tmpdir(), 'picturex-tags-batch-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&sort=addedAt&order=asc`)).json();
            const [firstAsset, secondAsset] = list.data;

            expect(firstAsset).toBeDefined();
            expect(secondAsset).toBeDefined();

            const alpha = await createTag(album.id, 'Alpha');
            const beta = await createTag(album.id, 'Beta');

            const imported = await app.request(`/albums/${album.id}/tags/import`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    tags: [
                        { name: 'Alpha' },
                        { name: 'Gamma', color: '#112233' },
                    ],
                }),
            });

            expect(imported.status).toBe(200);
            expect((await imported.json()).data).toEqual({ added: 1, skipped: 1 });

            const link = (assetId: string, tagId: string) => app.request(`/albums/${album.id}/assets/${assetId}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tagId }),
            });

            await link(firstAsset!.id, alpha);
            await link(secondAsset!.id, beta);

            const merged = await app.request(`/albums/${album.id}/tags/merge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sourceIds: [beta], targetId: alpha }),
            });

            expect(merged.status).toBe(200);
            expect((await merged.json()).data).toEqual({ removed: 1, moved: 1 });

            const secondDetail: { data: { tags: { name: string }[] } } = await (await app.request(`/albums/${album.id}/assets/${secondAsset!.id}`)).json();

            expect(secondDetail.data.tags.map(tag => tag.name)).toEqual(['Alpha']);

            const remaining: { data: { id: string, name: string }[] } = await (await app.request(`/albums/${album.id}/tags`)).json();
            const names = remaining.data.map(tag => tag.name);

            expect(names).toEqual(expect.arrayContaining(['Alpha', 'Gamma']));
            expect(names).not.toContain('Beta');

            const ids = remaining.data.filter(tag => tag.name === 'Alpha' || tag.name === 'Gamma').map(tag => tag.id);
            const deleted = await app.request(`/albums/${album.id}/tags/batch-delete`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids }),
            });

            expect(deleted.status).toBe(200);
            expect((await deleted.json()).data.removed).toBe(2);

            const afterDelete: { data: { tags: unknown[] } } = await (await app.request(`/albums/${album.id}/assets/${firstAsset!.id}`)).json();

            expect(afterDelete.data.tags).toEqual([]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('duplicate cleanup', () => {
    interface DuplicateRow {
        id: string
        sourcePath: string
        filename: string
    }

    it('clears every duplicate record without touching files on disk', async () => {
        const album = await createAlbum('Cleanup Dups');
        const root = mkdtempSync(join(tmpdir(), 'picturex-cleanup-'));

        try {
            const buffer = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 90, g: 130, b: 170 } } })
                .jpeg()
                .toBuffer();
            // 三个内容完全相同的文件：并发扫描下谁先入库成资产不确定，
            // 剩下两条进入 duplicate_files；断言只按返回的行做，不依赖时序。
            const paths = ['copy-a.jpg', 'copy-b.jpg', 'copy-c.jpg'];

            for (const name of paths) {
                const path = join(root, name);

                writeFileSync(path, buffer);
            }

            const day = 24 * 60 * 60 * 1000;
            const base = Date.now();

            utimesSync(join(root, 'copy-a.jpg'), new Date(base), new Date(base - 30 * day));
            utimesSync(join(root, 'copy-b.jpg'), new Date(base), new Date(base - 20 * day));
            utimesSync(join(root, 'copy-c.jpg'), new Date(base), new Date(base - day));

            const started = await app.request(`/albums/${album.id}/imports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ rootPath: root }),
            });
            const jobId = (await started.json()).data.id;
            const deadline = Date.now() + 20_000;

            for (;;) {
                const job: { status: string } = (await (await app.request(`/albums/${album.id}/imports/${jobId}`)).json()).data;

                if (job.status === 'completed' || job.status === 'failed') {
                    expect(job.status).toBe('completed');
                    break;
                }
                if (Date.now() > deadline) {
                    throw new Error('import did not finish');
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            const before: { data: { duplicates: DuplicateRow[] }[] } = await (await app.request(`/albums/${album.id}/groups/duplicates`)).json();

            expect(before.data[0]?.duplicates).toHaveLength(2);

            const cleanup = await app.request(`/albums/${album.id}/duplicates/cleanup`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });

            expect(cleanup.status).toBe(200);

            const result = (await cleanup.json()).data;

            expect(result).toMatchObject({ groups: 1, cleared: 2 });

            // 记录全清掉，分组也就消失；相册外的源文件必须一个都不动
            const after: { data: { duplicates: DuplicateRow[] }[] } = await (await app.request(`/albums/${album.id}/groups/duplicates`)).json();

            expect(after.data).toHaveLength(0);
            expect(paths.filter(name => existsSync(join(root, name)))).toHaveLength(3);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('job deletion', () => {
    const finishedAt = Math.floor(Date.now() / 1000);

    it('deletes finished import jobs and refuses resumable ones', async () => {
        const album = await createAlbum('Job Cleanup');

        createImportJob(album.id, 'import-paused', 'D:/photos');
        updateImportJob(album.id, 'import-paused', { status: 'paused', total: 10, processed: 10 });
        createImportJob(album.id, 'import-done', 'D:/photos');
        updateImportJob(album.id, 'import-done', { status: 'completed', total: 10, processed: 10, finishedAt });

        const refused = await app.request(`/albums/${album.id}/imports/import-paused`, { method: 'DELETE' });

        expect(refused.status).toBe(409);
        expect((await refused.json()).code).toBe('job_not_finished');

        const removed = await app.request(`/albums/${album.id}/imports/import-done`, { method: 'DELETE' });

        expect(removed.status).toBe(204);

        const missing = await app.request(`/albums/${album.id}/imports/import-done`);

        expect(missing.status).toBe(404);
    });

    it('deletes finished AI jobs', async () => {
        const album = await createAlbum('AI Job Cleanup');

        createAiJob(album.id, 'ai-done', 'zero-shot', 3);
        updateAiJob(album.id, 'ai-done', { status: 'completed', processed: 3, finishedAt });

        const removed = await app.request(`/albums/${album.id}/ai/jobs/ai-done`, { method: 'DELETE' });

        expect(removed.status).toBe(204);
        expect((await app.request(`/albums/${album.id}/ai/jobs/ai-done`)).status).toBe(404);
    });
});

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

        if (job.status === 'completed' || job.status === 'failed') {
            expect(job.status).toBe('completed');

            return;
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

describe('trash', () => {
    it('soft deletes, restores and permanently deletes a single asset', async () => {
        const album = await createAlbum('Trash Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-trash-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(list.data).toHaveLength(2);

            const target = list.data[0]?.id ?? '';

            const deleted = await app.request(`/albums/${album.id}/assets/${target}`, { method: 'DELETE' });

            expect(deleted.status).toBe(204);

            const active: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(active.data.map(item => item.id)).not.toContain(target);

            const trash: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&trash=true`)).json();

            expect(trash.data.map(item => item.id)).toEqual([target]);

            const restored = await app.request(`/albums/${album.id}/assets/${target}/restore`, { method: 'POST' });

            expect(restored.status).toBe(200);

            const afterRestore: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(afterRestore.data.map(item => item.id)).toContain(target);

            await app.request(`/albums/${album.id}/assets/${target}`, { method: 'DELETE' });

            const purged = await app.request(`/albums/${album.id}/trash/${target}`, { method: 'DELETE' });

            expect(purged.status).toBe(204);

            const missing = await app.request(`/albums/${album.id}/assets/${target}`);

            expect(missing.status).toBe(404);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true });
        }
    });

    it('updates the album count and empties the whole trash', async () => {
        const album = await createAlbum('Trash Purge Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-trash-all-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            for (const item of list.data) {
                await app.request(`/albums/${album.id}/assets/${item.id}`, { method: 'DELETE' });
            }

            const summary: { data: { assetCount: number } } = await (await app.request(`/albums/${album.id}`)).json();

            expect(summary.data.assetCount).toBe(0);

            const purge = await app.request(`/albums/${album.id}/trash/purge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });

            expect(purge.status).toBe(200);
            expect((await purge.json()).data.removed).toBe(2);

            const trash: { data: unknown[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&trash=true`)).json();

            expect(trash.data).toEqual([]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true });
        }
    });
});

describe('asset rename and neighbors', () => {
    it('renames in bulk and resolves previous/next across the album', async () => {
        const album = await createAlbum('Rename Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-rename-'));

        try {
            await makeImages(root, 3);
            await importAndWait(album.id, root);

            const list: { data: { id: string, filename: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10&sort=addedAt&order=asc`)).json();
            const ids = list.data.map(item => item.id);

            expect(ids).toHaveLength(3);

            const renamed = await app.request(`/albums/${album.id}/assets`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids, prefix: 'IMG_', start: 1, padding: 3 }),
            });

            expect(renamed.status).toBe(200);
            expect(((await renamed.json()).data as { filename: string }[]).map(item => item.filename))
                .toEqual(['IMG_001.png', 'IMG_002.png', 'IMG_003.png']);

            const single = await app.request(`/albums/${album.id}/assets/${ids[1]}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'cover' }),
            });

            expect(single.status).toBe(200);
            expect((await single.json()).data.filename).toBe('cover.png');

            // 导入并发时 addedAt 可能落在同一毫秒；给这里固定成严格递增的 Unix 秒，索引才有确定语义
            const albumDb = getAlbum(getSettings(), album.id).db.album;
            const updateTime = albumDb.$client.prepare('UPDATE assets SET added_at = ? WHERE id = ?');
            const baseTime = Math.floor(Date.now() / 1000) - ids.length;

            ids.forEach((id, index) => updateTime.run(baseTime + index, id));

            const nav: {
                data: {
                    previous: { id: string }
                    next: { id: string }
                    previousItems: { id: string }[]
                    nextItems: { id: string }[]
                    index: number
                    total: number
                }
            } = await (await app.request(`/albums/${album.id}/assets/${ids[1]}/neighbors?span=5`)).json();

            expect(nav.data.total).toBe(3);
            expect(nav.data.index).toBe(1);
            expect(nav.data.previous.id).toBe(ids[2]);
            expect(nav.data.next.id).toBe(ids[0]);
            expect(nav.data.previousItems.map(item => item.id)).toEqual([ids[2]]);
            expect(nav.data.nextItems.map(item => item.id)).toEqual([ids[0]]);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('counts only active assets in the neighbors total (trashed excluded)', async () => {
        const album = await createAlbum('Neighbors Trash');
        const root = mkdtempSync(join(tmpdir(), 'picturex-neighbors-trash-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();

            expect(list.data).toHaveLength(2);

            const [first, second] = list.data;

            await app.request(`/albums/${album.id}/assets/${first!.id}`, { method: 'DELETE' });

            const nav: { data: { index: number, total: number } } = await (
                await app.request(`/albums/${album.id}/assets/${second!.id}/neighbors?span=5`)
            ).json();

            // 永久删除前的全表 sum(case) 会把回收站资产也扫进来；改为只数活跃行后 total=1、index=0
            expect(nav.data.total).toBe(1);
            expect(nav.data.index).toBe(0);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('rejects filenames with path separators', async () => {
        const album = await createAlbum('Rename Guard');
        const root = mkdtempSync(join(tmpdir(), 'picturex-rename-guard-'));

        try {
            await makeImages(root, 1);
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const response = await app.request(`/albums/${album.id}/assets/${list.data[0].id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ filename: '../evil.png' }),
            });

            expect(response.status).toBe(422);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('album settings and export', () => {
    it('stores album-level features and applies the album threshold', async () => {
        const album = await createAlbum('Album Features');

        const patched = await app.request(`/albums/${album.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: { similarityThreshold: 3, autoTag: true } }),
        });

        expect(patched.status).toBe(200);
        expect((await patched.json()).data.settings).toMatchObject({ similarityThreshold: 3, autoTag: true });

        const similar: { meta: { threshold: number } } = await (await app.request(`/albums/${album.id}/groups/similar`)).json();

        expect(similar.meta.threshold).toBe(3);
    });

    it('runs thumbnail optimize and clear as background jobs', async () => {
        const album = await createAlbum('Thumb Jobs');

        getAlbum(getSettings(), album.id);

        const optimize = await app.request(`/albums/${album.id}/thumbnails/optimize`, { method: 'POST' });

        expect(optimize.status).toBe(202);
        expect((await optimize.json()).data.status).toBe('running');

        const optimized = await waitForThumbMaintenance(album.id);

        expect(optimized.status).toBe('completed');
        expect(optimized.removed).toBe(0);

        const clear = await app.request(`/albums/${album.id}/thumbnails`, { method: 'DELETE' });

        expect(clear.status).toBe(202);
        expect((await waitForThumbMaintenance(album.id)).status).toBe('completed');
    });

    it('streams export progress and writes files plus a manifest', async () => {
        const album = await createAlbum('Export Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-export-src-'));
        const target = mkdtempSync(join(tmpdir(), 'picturex-export-out-'));

        try {
            await makeImages(root, 2);
            await importAndWait(album.id, root);

            const response = await app.request(`/albums/${album.id}/exports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ targetPath: target, naming: 'sequence' }),
            });

            expect(response.status).toBe(200);

            const events = (await response.text())
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as { type: string, total?: number, exported?: number, missing?: number, manifest?: string });

            expect(events[0]).toMatchObject({ type: 'start', total: 2 });
            expect(events.at(-1)).toMatchObject({ type: 'done', exported: 2, missing: 0, manifest: 'picturex-export.json' });

            const manifest = JSON.parse(readFileSync(join(target, 'picturex-export.json'), 'utf8')) as {
                items: { uuid: string, filename: string, sequence: number, exportedAs: string, modifiedAt: string | null }[]
            };

            expect(manifest.items).toHaveLength(2);
            expect(manifest.items[0]).toMatchObject({ sequence: 1 });
            expect(manifest.items[0].uuid.length).toBeGreaterThan(0);
            expect(manifest.items[0].modifiedAt).not.toBeNull();
            expect(existsSync(join(target, manifest.items[0].exportedAs))).toBe(true);

            // 二次导出不能覆盖清单或图片
            const second = await app.request(`/albums/${album.id}/exports`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ targetPath: target, naming: 'sequence' }),
            });
            const secondEvents = (await second.text())
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as { type: string, manifest?: string });

            expect(secondEvents.at(-1)).toMatchObject({ type: 'done', manifest: 'picturex-export-2.json' });
            expect(existsSync(join(target, 'picturex-export-2.json'))).toBe(true);
            expect((JSON.parse(readFileSync(join(target, 'picturex-export.json'), 'utf8')) as { items: unknown[] }).items).toHaveLength(2);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
            removeAlbumTree(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('refuses export targets inside the album or missing folders', async () => {
        const album = await createAlbum('Export Guard');
        const context = getAlbum(getSettings(), album.id);

        const inside = await app.request(`/albums/${album.id}/exports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetPath: context.dir }),
        });

        expect(inside.status).toBe(422);
        expect((await inside.json()).code).toBe('export_target_invalid',
        );

        const missing = await app.request(`/albums/${album.id}/exports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetPath: join(dataDir, 'does-not-exist') }),
        });

        expect(missing.status).toBe(422);
        expect((await missing.json()).code).toBe('export_target_missing');
    });
});
