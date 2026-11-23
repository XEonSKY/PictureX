import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { count } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { closeAllAlbumDatabases } from '../server/database/album';
import { assetTags } from '../server/database/schemas/album';
import { deleteAlbum, getAlbum, reconcileAlbum } from '../server/album/album-store';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { removeAlbumTree } from './cleanup';

/**
 * 批次 1 回归：唯一的数据丢失项（标签主数据缺失被当成空标签清空全部关联）、
 * RCE 链的 ffmpeg 路径白名单、以及 deleteAlbum 递归删除的目录边界。
 */

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-audit1-'));
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

async function createAlbum(name: string, dir?: string): Promise<{ id: string }> {
    const response = await app.request('/albums', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, dir }),
    });

    expect(response.status).toBe(201);

    return (await response.json()).data;
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

async function makeImage(root: string, name: string): Promise<void> {
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 40, b: 60 } } })
        .png()
        .toFile(join(root, name));
}

function tagLinkCount(albumId: string): number {
    const context = getAlbum(getSettings(), albumId);

    return Number(context.db.album.select({ value: count() }).from(assetTags).get()?.value ?? 0);
}

describe('reconcileAlbum keeps tag links when the tag master is missing', () => {
    it('does not wipe asset_tags when the tag database is unusable', async () => {
        const album = await createAlbum('Missing Tags');
        const root = mkdtempSync(join(tmpdir(), 'picturex-audit1-import-'));

        try {
            await makeImage(root, 'a.png');
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';

            const tag = await app.request(`/albums/${album.id}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'keepme' }),
            });
            const tagId = (await tag.json()).data.id;

            await app.request(`/albums/${album.id}/assets/batch-tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: [assetId], addTagIds: [tagId] }),
            });

            expect(tagLinkCount(album.id)).toBe(1);

            const context = getAlbum(getSettings(), album.id);

            // 模拟标签库损坏回退内存库（搬移漏拷 / 被杀毒隔离 / 网盘部分回传）
            context.db.tags.$client.transaction(() => {
                context.db.tags.$client.prepare('DELETE FROM tags').run();
                context.db.tags.$client
                    .prepare("INSERT INTO tag_meta (key, value) VALUES ('corrupt', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
                    .run();
            })();

            const result = reconcileAlbum(getSettings(), context);

            expect(result.tagMasterMissing).toBe(true);
            // 关联必须原样保留，而不是被当成空标签库清空
            expect(tagLinkCount(album.id)).toBe(1);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('prunes orphan links when the tag database is initialized but holds no tags', async () => {
        const album = await createAlbum('Empty Tags');
        const root = mkdtempSync(join(tmpdir(), 'picturex-audit1-empty-'));

        try {
            await makeImage(root, 'b.png');
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';

            const tag = await app.request(`/albums/${album.id}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'temp' }),
            });
            const tagId = (await tag.json()).data.id;

            await app.request(`/albums/${album.id}/assets/batch-tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: [assetId], addTagIds: [tagId] }),
            });

            expect(tagLinkCount(album.id)).toBe(1);

            const context = getAlbum(getSettings(), album.id);

            // 用户清空全部标签后标签库已初始化：空库是合法状态，孤儿关联应当被清掉
            await app.request(`/albums/${album.id}/tags/delete-all`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });
            context.db.album.insert(assetTags)
                .values({ assetId, tagId: 'orphan-tag', createdAt: new Date().toISOString() })
                .run();

            const result = reconcileAlbum(getSettings(), context);

            expect(result.tagMasterMissing).toBe(false);
            expect(tagLinkCount(album.id)).toBe(0);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('deleteAlbum refuses to rm -rf outside the album identity', () => {
    it('deletes a normal in-root album directory', async () => {
        const album = await createAlbum('Normal Delete');
        const context = getAlbum(getSettings(), album.id);

        expect(existsSync(context.dir)).toBe(true);

        deleteAlbum(getSettings(), album.id, { deleteFiles: true });

        expect(existsSync(context.dir)).toBe(false);
    });

    it('keeps files when index.json id does not match the registered album id', async () => {
        const album = await createAlbum('Tampered Index');
        const context = getAlbum(getSettings(), album.id);

        // 目录被用户改作他用 / 复制串了 index：id 对不上就绝不递归删除
        writeFileSync(
            join(context.dir, 'index.json'),
            JSON.stringify({ schemaVersion: 1, id: '00000000-0000-4000-8000-000000000000', name: 'someone else', createdAt: '', updatedAt: '' }),
            'utf8',
        );

        deleteAlbum(getSettings(), album.id, { deleteFiles: true });

        expect(existsSync(context.dir)).toBe(true);

        removeAlbumTree(context.dir, { recursive: true, force: true });
    });

    it('keeps files when index.json is missing so a repurposed directory survives', async () => {
        const external = mkdtempSync(join(tmpdir(), 'picturex-audit1-external-'));
        const album = await createAlbum('External Album', external);
        const context = getAlbum(getSettings(), album.id);

        expect(existsSync(context.dir)).toBe(true);

        // 相册允许放在任意路径；但若目录被清空 index（改作他用），deleteFiles 不得递归删除
        unlinkSync(join(context.dir, 'index.json'));

        deleteAlbum(getSettings(), album.id, { deleteFiles: true });

        // 身份校验失败：只解除关联，保留磁盘内容
        expect(existsSync(context.dir)).toBe(true);

        removeAlbumTree(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('deletes a custom-directory album when its index.json identifies it', async () => {
        const external = mkdtempSync(join(tmpdir(), 'picturex-audit1-custom-'));
        const album = await createAlbum('Custom Dir', external);
        const context = getAlbum(getSettings(), album.id);

        expect(existsSync(context.dir)).toBe(true);

        deleteAlbum(getSettings(), album.id, { deleteFiles: true });

        // 身份相符：即便不在 albumsRoot 内，用户明确要求删除文件就删除
        expect(existsSync(context.dir)).toBe(false);

        removeAlbumTree(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
});

describe('ffmpeg.path whitelist blocks arbitrary executables', () => {
    it('rejects a non-ffmpeg absolute path and accepts auto / ffmpeg-shaped paths', async () => {
        const bad = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ffmpeg: { path: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh' } }),
        });

        expect(bad.status).toBe(422);

        const relativePath = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ffmpeg: { path: './tools/my-ffmpeg' } }),
        });

        expect(relativePath.status).toBe(422);

        const good = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ffmpeg: { path: 'auto' } }),
        });

        expect(good.status).toBe(200);

        const shaped = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ffmpeg: { path: process.platform === 'win32' ? 'D:\\tools\\ffmpeg.exe' : '/usr/local/bin/ffmpeg' } }),
        });

        expect(shaped.status).toBe(200);
    });
});
