import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSafeOverrideValue, normalizeThemeState } from '#shared/theme';
import type { AppEnv } from '../server/hono/env';
import { closeAllAlbumDatabases } from '../server/database/album';
import { pixivImageStream } from '../server/pixiv/http';
import { resetSettingsCache } from '../server/settings/setting-store';
import { removeAlbumTree } from './cleanup';

/**
 * 批次 5 防线：搜索 LIKE 通配符转义、Windows 保留名/结尾点号拒绝、主题覆盖值类型校验。
 */

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-hard-'));
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

async function makeImage(root: string, name: string, seed = 90): Promise<void> {
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 60, b: seed } } })
        .png()
        .toFile(join(root, name));
}

describe('search LIKE escaping', () => {
    it('treats _ in a short query as a literal, not a wildcard', async () => {
        const album = await createAlbum('Like Escaping');
        const root = mkdtempSync(join(tmpdir(), 'picturex-hard-import-'));

        try {
            // 两张内容不同的图，都会作为独立资产入库
            await makeImage(root, 'a_b.png', 90);
            await makeImage(root, 'axb.png', 120);
            await importAndWait(album.id, root);

            // q=a_b 只有转义后才把 _ 当字面量；未转义时 _ 匹配任意单字符，会把 axb.png 也带出来
            const search: { data: { filename: string }[] } = await (
                await app.request(`/albums/${album.id}/assets?limit=10&q=a_b`)
            ).json();

            expect(search.data.map(item => item.filename)).toEqual(['a_b.png']);
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('rename rejects unsafe Windows filenames', () => {
    it('refuses reserved device names and trailing dots but accepts normal names', async () => {
        const album = await createAlbum('Rename Guard');
        const root = mkdtempSync(join(tmpdir(), 'picturex-hard-rename-'));

        try {
            await makeImage(root, 'photo.png');
            await importAndWait(album.id, root);

            const list: { data: { id: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
            const assetId = list.data[0]?.id ?? '';

            const reserved = await app.request(`/albums/${album.id}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'CON.png' }),
            });

            expect(reserved.status).toBe(422);

            const trailingDot = await app.request(`/albums/${album.id}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'name.' }),
            });

            expect(trailingDot.status).toBe(422);

            const valid = await app.request(`/albums/${album.id}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ filename: 'holiday.png' }),
            });

            expect(valid.status).toBe(200);
            expect((await valid.json()).data.filename).toBe('holiday.png');
        }
        finally {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});

describe('pixiv image host guard', () => {
    it('rejects non-pximg and plain-http image URLs before any network request', async () => {
        await expect(pixivImageStream('https://evil.example/a.jpg'))
            .rejects
            .toMatchObject({ code: 'pixiv_api_error' });
        await expect(pixivImageStream('http://i.pximg.net/a.jpg'))
            .rejects
            .toMatchObject({ code: 'pixiv_api_error' });
    });
});

describe('theme override value validation', () => {
    it('accepts only type-appropriate, injection-free values', () => {
        expect(isSafeOverrideValue('color-brand', '#123456')).toBe(true);
        expect(isSafeOverrideValue('color-brand', 'rgba(0, 0, 0, 0.5)')).toBe(true);
        // 注入：用 ; 追加声明、用 url()/<> 逃逸
        expect(isSafeOverrideValue('color-brand', 'red; background: url(http://evil)')).toBe(false);
        expect(isSafeOverrideValue('color-brand', '</style><script>')).toBe(false);
        // 长度类 Token 不收颜色
        expect(isSafeOverrideValue('radius-sm', '#123456')).toBe(false);
        expect(isSafeOverrideValue('radius-sm', '10px')).toBe(true);

        const state = normalizeThemeState({
            preset: 'light',
            overrides: {
                'color-brand': '#0A59F7',
                'radius-sm': '8px',
                'color-danger': 'red; color: green',
            },
        });

        expect(state.overrides).toEqual({ 'color-brand': '#0A59F7', 'radius-sm': '8px' });
    });
});
