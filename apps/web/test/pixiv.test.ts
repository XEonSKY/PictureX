import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { getAlbum } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase } from '../server/database/global';
import { closePixivDatabase, pixivDatabase } from '../server/database/pixiv';
import { illusts } from '../server/database/schemas/pixiv';
import { readGlobalPixivIllust } from '../server/pixiv/global-cache';
import {
    getPixivAccessToken,
    logoutPixiv,
    resetPixivSessionForTests,
} from '../server/pixiv/auth';
import { parsePixivFilename } from '../server/pixiv/filename';
import { resetPixivRateLimitForTests } from '../server/pixiv/rate-limit';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { isPixivAiGenerated, pickPixivTagName } from '../shared/pixiv';
import { colorFromTagName } from '../shared/tag-color';
import { extractZip } from '../app/utils/ugoira-zip';
import { removeAlbumTree } from './cleanup';

let app: Hono<AppEnv>;
let dataDir: string;
let imageDir: string;
let server: Server;
let baseUrl: string;
let detailRequests = 0;
let detailStatus = 200;
let zipRequests = 0;
let tokenRequests = 0;
let tokenDelayMs = 0;
let jpeg: Buffer;
let jpeg2: Buffer;

function makeZip(files: { name: string, data: Buffer }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const local = Buffer.alloc(30);

        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(file.data.byteLength, 18);
        local.writeUInt32LE(file.data.byteLength, 22);
        local.writeUInt16LE(name.byteLength, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, file.data);

        const central = Buffer.alloc(46);

        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(0, 16);
        central.writeUInt32LE(file.data.byteLength, 20);
        central.writeUInt32LE(file.data.byteLength, 24);
        central.writeUInt16LE(name.byteLength, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.byteLength + name.byteLength + file.data.byteLength;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
    const eocd = Buffer.alloc(22);

    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, ...centrals, eocd]);
}

function illustPage(id: string, index: number): Record<string, unknown> {
    const url = `${baseUrl}/img/${id}_p${index}.jpg`;

    return {
        image_urls: {
            square_medium: url,
            medium: url,
            large: url,
            original: url,
        },
    };
}

function detailPayload(illustId: string): Record<string, unknown> {
    const ugoira = illustId === '777777';
    const pageCount = ugoira ? 1 : illustId === '123456' ? 2 : 1;

    return {
        illust: {
            id: Number(illustId),
            title: `Work ${illustId}`,
            type: ugoira ? 'ugoira' : 'illust',
            caption: 'line one<br>line two',
            user: { id: 42, name: 'Pixiv Tester', account: 'tester' },
            tags: [
                { name: 'tag-one', translated_name: 'Tag One' },
                { name: 'tag-two', translated_name: null },
            ],
            create_date: '2026-01-02T03:04:05+09:00',
            page_count: pageCount,
            width: 1000,
            height: 1400,
            x_restrict: illustId === '123456' ? 1 : 0,
            sanity_level: 2,
            illust_ai_type: illustId === '123456' ? 1 : 0,
            image_urls: {
                square_medium: `${baseUrl}/img/${illustId}_p0.jpg`,
                medium: `${baseUrl}/img/${illustId}_p0.jpg`,
                large: `${baseUrl}/img/${illustId}_p0.jpg`,
            },
            meta_single_page: pageCount === 1
                ? { original_image_url: `${baseUrl}/img/${illustId}_p0.jpg` }
                : {},
            meta_pages: Array.from({ length: pageCount }, (_, index) => illustPage(illustId, index)),
            total_view: 1200,
            total_bookmarks: 34,
        },
    };
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-pixiv-'));
    imageDir = mkdtempSync(join(tmpdir(), 'picturex-pixiv-img-'));

    jpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 200, g: 40, b: 60 } } })
        .jpeg()
        .toBuffer();
    jpeg2 = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 20, g: 140, b: 70 } } })
        .jpeg()
        .toBuffer();

    server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');

        if (url.pathname === '/auth/token') {
            tokenRequests += 1;
            await readBody(request);

            if (tokenDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, tokenDelayMs));
            }

            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                response: {
                    access_token: 'access-token',
                    refresh_token: 'refresh-token',
                    expires_in: 3600,
                    user: {
                        id: 42,
                        name: 'Pixiv Tester',
                        account: 'tester',
                        is_premium: true,
                    },
                },
            }));

            return;
        }

        if (url.pathname === '/v1/chat/completions') {
            await readBody(request);
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ choices: [{ message: { content: '["ai-tag"]' } }] }));

            return;
        }

        if (url.pathname === '/v1/illust/detail') {
            detailRequests += 1;

            if (detailStatus !== 200) {
                response.statusCode = detailStatus;

                if (detailStatus === 429) {
                    response.setHeader('retry-after', '60');
                }

                response.end('rate limited');

                return;
            }

            if (!request.headers.authorization?.startsWith('Bearer ')) {
                response.statusCode = 401;
                response.end(JSON.stringify({ errors: { system: { message: 'OAuth token required' } } }));

                return;
            }

            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(detailPayload(url.searchParams.get('illust_id') ?? '123456')));

            return;
        }

        if (url.pathname === '/v1/ugoira/metadata') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                ugoira_metadata: {
                    zip_urls: { medium: `${baseUrl}/zip/ugoira.zip` },
                    frames: [
                        { file: '000001.jpg', delay: 80 },
                        { file: '000002.jpg', delay: 120 },
                    ],
                },
            }));

            return;
        }

        if (url.pathname === '/zip/ugoira.zip') {
            zipRequests += 1;
            response.setHeader('content-type', 'application/zip');
            response.end(makeZip([
                { name: '000001.jpg', data: jpeg },
                { name: '000002.jpg', data: jpeg2 },
            ]));

            return;
        }

        if (url.pathname.startsWith('/img/')) {
            response.setHeader('content-type', 'image/jpeg');
            response.end(url.pathname.endsWith('_p1.jpg') ? jpeg2 : jpeg);

            return;
        }

        response.statusCode = 404;
        response.end('not found');
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.NUXT_DATA_DIR = dataDir;
    process.env.PX_PIXIV_API_BASE = baseUrl;
    process.env.PX_PIXIV_OAUTH_BASE = baseUrl;
    process.env.PX_PIXIV_IMAGE_HOSTS = '127.0.0.1';
    resetSettingsCache();
    resetPixivSessionForTests();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(async () => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    resetSettingsCache();
    resetPixivSessionForTests();
    delete process.env.NUXT_DATA_DIR;
    delete process.env.PX_PIXIV_API_BASE;
    delete process.env.PX_PIXIV_OAUTH_BASE;
    delete process.env.PX_PIXIV_IMAGE_HOSTS;

    await new Promise<void>(resolve => server.close(() => resolve()));

    try {
        removeAlbumTree(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        removeAlbumTree(imageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

async function importNamedImage(albumId: string, name: string, color: { r: number, g: number, b: number }): Promise<string> {
    const root = mkdtempSync(join(imageDir, 'album-'));

    await sharp({ create: { width: 96, height: 128, channels: 3, background: color } })
        .jpeg()
        .toFile(join(root, name));

    const response = await app.request(`/albums/${albumId}/imports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootPath: root }),
    });

    expect(response.status).toBe(202);

    const deadline = Date.now() + 20_000;

    for (;;) {
        const list = await app.request(`/albums/${albumId}/assets?limit=20`);
        const body: { data: { id: string, filename: string }[] } = await list.json();
        const hit = body.data.find(asset => asset.filename === name);

        if (hit) {
            removeAlbumTree(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

            return hit.id;
        }
        if (Date.now() > deadline) {
            throw new Error(`import did not ingest ${name}`);
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function enablePixiv(albumId: string): Promise<void> {
    const response = await app.request(`/albums/${albumId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { pixivEnabled: true } }),
    });

    expect(response.status).toBe(200);
}

async function login(): Promise<void> {
    const response = await app.request('/pixiv/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'refresh-token' }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data.configured).toBe(true);
}

describe('pixiv ai type', () => {
    it('only treats illust_ai_type 2 as AI-generated', () => {
        expect(isPixivAiGenerated(0)).toBe(false);
        expect(isPixivAiGenerated(1)).toBe(false);
        expect(isPixivAiGenerated(2)).toBe(true);
        expect(isPixivAiGenerated(null)).toBe(false);
    });
});

describe('tag colors', () => {
    it('derives a stable hex color from the tag name', () => {
        const first = colorFromTagName('碧蓝档案');
        const second = colorFromTagName('碧蓝档案');

        expect(first).toBe(second);
        expect(first).toMatch(/^#[0-9a-f]{6}$/iu);
        expect(colorFromTagName('manga')).not.toBe('');
    });
});

describe('pixiv tag name priority', () => {
    it('prefers English, then Chinese, then Japanese', () => {
        expect(pickPixivTagName({ name: '漫画', translatedName: 'manga' })).toBe('manga');
        expect(pickPixivTagName({ name: 'ブルーアーカイブ', translatedName: '碧蓝档案' })).toBe('碧蓝档案');
        expect(pickPixivTagName({ name: 'BlueArchive', translatedName: null })).toBe('BlueArchive');
        expect(pickPixivTagName({ name: 'ブルアカ', translatedName: null })).toBe('ブルアカ');
        expect(pickPixivTagName({ name: '初音ミク', translatedName: 'Hatsune Miku' })).toBe('Hatsune Miku');
    });
});

describe('pixiv filename parsing', () => {
    it('recognizes page suffixes and rejects ordinary names', () => {
        expect(parsePixivFilename('127978234_p0.jpg')).toEqual({ illustId: '127978234', pageIndex: 0 });
        expect(parsePixivFilename('123456_p12_master1200.png')).toEqual({ illustId: '123456', pageIndex: 12 });
        expect(parsePixivFilename('IMG_123456.jpg')).toBeNull();
        expect(parsePixivFilename('12345_p0.jpg')).toBeNull();
    });
});

describe('pixiv ugoira zip parsing', () => {
    it('extracts stored frames in the browser-compatible parser', async () => {
        const archive = makeZip([
            { name: '000001.jpg', data: jpeg },
            { name: '000002.jpg', data: jpeg2 },
        ]);
        const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
        const frames = await extractZip(buffer);

        expect(frames.size).toBe(2);
        expect(Buffer.from(frames.get('000001.jpg') ?? new Uint8Array()).equals(jpeg)).toBe(true);
        expect(Buffer.from(frames.get('000002.jpg') ?? new Uint8Array()).equals(jpeg2)).toBe(true);
    });
});

describe('pixiv settings and authentication', () => {
    it('logs in with a refresh token and masks it', async () => {
        const completed = await app.request('/pixiv/auth/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: 'refresh-token' }),
        });

        expect(completed.status).toBe(200);
        expect((await completed.json()).data.configured).toBe(true);
        expect(tokenRequests).toBeGreaterThan(0);

        const settings = await app.request('/settings');

        expect((await settings.json()).data.pixiv.refreshToken).toBe('********');

        const patched = await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                pixiv: {
                    networkMode: 'proxy',
                    proxyUrl: 'socks5://127.0.0.1:10808',
                    imageQuality: 'large',
                },
            }),
        });
        const patchedBody = await patched.json();

        expect(patchedBody.data.pixiv.networkMode).toBe('proxy');
        expect(patchedBody.data.pixiv.proxyUrl).toBe('socks5://127.0.0.1:10808');
        expect(patchedBody.data.pixiv.refreshToken).toBe('********');
    });

    it('pauses and resumes background enrichment', async () => {
        try {
            const paused = await app.request('/pixiv/auto-fetch/pause', { method: 'POST' });

            expect(paused.status).toBe(200);
            expect((await paused.json()).data.paused).toBe(true);

            const status = await (await app.request('/pixiv/auto-fetch')).json();

            expect(status.data.paused).toBe(true);

            const resumed = await app.request('/pixiv/auto-fetch/resume', { method: 'POST' });
            const resumedBody = await resumed.json();

            expect(resumed.status).toBe(200);
            expect(resumedBody.data.status.paused).toBe(false);
            expect(getSettings().pixiv.autoFetchPaused).toBe(false);
        }
        finally {
            // 失败时也不要让后续测试继承暂停状态
            await app.request('/pixiv/auto-fetch/resume', { method: 'POST' });
        }
    });

    it('does not resurrect the refresh token when logging out mid-refresh', async () => {
        await login();
        // 丢掉内存会话但保留已存令牌，强制下一次访问触发刷新
        resetPixivSessionForTests();

        tokenDelayMs = 150;

        try {
            const pending = getPixivAccessToken();

            await new Promise(resolve => setTimeout(resolve, 20));
            logoutPixiv();

            await expect(pending).rejects.toMatchObject({ code: 'pixiv_auth_required' });
        }
        finally {
            tokenDelayMs = 0;
        }

        expect(getSettings().pixiv.refreshToken).toBe('');
    });
});

describe('pixiv asset context', () => {
    it('caches metadata, links local pages and downloads missing pages on request', async () => {
        const album = await createAlbum('Pixiv Pages');

        await enablePixiv(album.id);
        await login();

        const assetId = await importNamedImage(album.id, '123456_p0.jpg', { r: 90, g: 120, b: 200 });
        const before = detailRequests;
        const context = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);

        expect(context.status).toBe(200);

        const data = (await context.json()).data;

        expect(data.pixiv).toBe(true);
        expect(data.illust.title).toBe('Work 123456');
        expect(data.illust.xRestrict).toBe(1);
        expect(data.illust.tags[0]).toMatchObject({ name: 'tag-one', translatedName: 'Tag One' });
        expect(data.localPages).toEqual([{ index: 0, assetId, filename: '123456_p0.jpg' }]);
        expect(data.missingPages).toEqual([1]);
        expect(data.authRequired).toBe(false);
        expect(detailRequests).toBe(before + 1);

        const summaryList: { data: { id: string, displayName: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=10`)).json();
        const listed = summaryList.data.find(item => item.id === assetId);

        expect(listed?.displayName).toBe('Work 123456 · p1');

        const globalRow = pixivDatabase()
            .select()
            .from(illusts)
            .where(eq(illusts.illustId, '123456'))
            .get();

        expect(globalRow?.title).toBe('Work 123456');
        expect(readGlobalPixivIllust('123456')?.illust.tags).toHaveLength(2);

        // 命中 7 天缓存，不再打 API
        await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
        expect(detailRequests).toBe(before + 1);

        const sync = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv/sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ download: true }),
        });
        const synced = (await sync.json()).data;

        expect(sync.status).toBe(200);
        expect(synced.downloadedPages).toEqual([1]);
        expect(synced.missingPages).toEqual([]);
        expect(synced.localPages.map((page: { index: number }) => page.index)).toEqual([0, 1]);

        const list: { data: { filename: string }[] } = await (await app.request(`/albums/${album.id}/assets?limit=20`)).json();

        expect(list.data.map(item => item.filename).sort()).toEqual(['123456_p0.jpg', '123456_p1.jpg']);
    });

    it('propagates 429 even when a stale cache exists', async () => {
        const album = await createAlbum('Pixiv Rate Limit');

        await enablePixiv(album.id);
        await login();

        const assetId = await importNamedImage(album.id, '123457_p0.jpg', { r: 10, g: 20, b: 30 });

        // 先拉一次详情并写入相册/全局缓存，再把两处 fetched_at 改成过期
        await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);

        const context = getAlbum(getSettings(), album.id);
        const staleAt = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;

        context.db.pixiv.$client.prepare('UPDATE illusts SET fetched_at = ? WHERE illust_id = ?').run(staleAt, '123457');
        pixivDatabase().$client.prepare('UPDATE illusts SET fetched_at = ? WHERE illust_id = ?').run(staleAt, '123457');

        detailStatus = 429;

        try {
            const response = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
            const body = await response.json() as { code?: string };

            expect(response.status).toBe(429);
            expect(body.code).toBe('pixiv_rate_limited');
        }
        finally {
            detailStatus = 200;
            resetPixivRateLimitForTests();
        }
    });

    it('reuses the global cache across albums without another API call', async () => {
        const album = await createAlbum('Pixiv Global Cache');

        await enablePixiv(album.id);
        await login();

        const assetId = await importNamedImage(album.id, '123456_p0.jpg', { r: 140, g: 70, b: 30 });
        const before = detailRequests;
        const response = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
        const data = (await response.json()).data;

        expect(response.status).toBe(200);
        expect(data.illust.title).toBe('Work 123456');
        expect(data.illust.tags).toHaveLength(2);
        expect(detailRequests).toBe(before);

        const detail = (await (await app.request(`/albums/${album.id}/assets/${assetId}`)).json()).data;

        expect(detail.displayName).toBe('Work 123456 · p1');
    });

    it('reports authRequired without a token and keeps local pages visible', async () => {
        const album = await createAlbum('Pixiv Logged Out');

        await enablePixiv(album.id);
        await app.request('/pixiv/auth', { method: 'DELETE' });

        const assetId = await importNamedImage(album.id, '654321_p0.jpg', { r: 20, g: 90, b: 40 });
        const response = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
        const data = (await response.json()).data;

        expect(response.status).toBe(200);
        expect(data.pixiv).toBe(true);
        expect(data.authRequired).toBe(true);
        expect(data.illust).toBeNull();
        expect(data.localPages).toHaveLength(1);
        expect(data.localPages[0].index).toBe(0);
    });

    it('keeps auto-download off by default', async () => {
        const album = await createAlbum('Pixiv Default Off');
        const response = await app.request(`/albums/${album.id}`);

        expect((await response.json()).data.settings.pixivAutoDownload).toBe(false);
    });
});

describe('pixiv tag separation', () => {
    it('keeps Pixiv tags out of tag.db and no longer exposes a tag sync endpoint', async () => {
        const album = await createAlbum('Pixiv Tag Separation');

        await enablePixiv(album.id);
        await login();

        const existing = await app.request(`/albums/${album.id}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'TAG ONE' }),
        });

        expect(existing.status).toBe(201);

        const assetId = await importNamedImage(album.id, '123456_p0.jpg', { r: 30, g: 60, b: 90 });
        const context = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
        const data = (await context.json()).data;

        expect(data.illust.tags.map((tag: { name: string }) => tag.name).sort())
            .toEqual(['tag-one', 'tag-two']);

        // 标签同步接口已移除：Pixiv 标签只存在于作品详情，不再写入 tag.db
        const sync = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv/tags`, { method: 'POST' });

        expect(sync.status).toBe(404);

        const tags = await app.request(`/albums/${album.id}/tags`);
        const tagList = (await tags.json()).data;

        expect(tagList.map((tag: { name: string }) => tag.name)).toEqual(['TAG ONE']);

        const detail = await app.request(`/albums/${album.id}/assets/${assetId}`);
        const detailTags = (await detail.json()).data.tags;

        expect(detailTags).toHaveLength(0);
    });
});

describe('tag colors and cleanup', () => {
    it('auto-colors, randomizes and deletes all tags', async () => {
        const album = await createAlbum('Tag Colors');

        for (const name of ['one', 'two']) {
            const created = await app.request(`/albums/${album.id}/tags`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name }),
            });

            expect(created.status).toBe(201);
        }

        const listBefore = (await (await app.request(`/albums/${album.id}/tags`)).json()).data as { id: string, color: string }[];
        const first = listBefore[0];

        expect(first).toBeDefined();

        await app.request(`/albums/${album.id}/tags/${first?.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ color: '' }),
        });

        const auto = await app.request(`/albums/${album.id}/tags/colors`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'auto', onlyEmpty: true }),
        });

        expect((await auto.json()).data.updated).toBe(1);

        // 固定为调色板之外的颜色，避免随机模式恰好抽到原色导致断言偶发失败
        for (const tag of listBefore) {
            await app.request(`/albums/${album.id}/tags/${tag.id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ color: '#000001' }),
            });
        }

        const random = await app.request(`/albums/${album.id}/tags/colors`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'random', onlyEmpty: false }),
        });

        expect((await random.json()).data.updated).toBe(listBefore.length);

        const cleared = await app.request(`/albums/${album.id}/tags/delete-all`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true }),
        });

        expect((await cleared.json()).data.removed).toBe(2);
        expect((await (await app.request(`/albums/${album.id}/tags`)).json()).data).toEqual([]);
    });
});

describe('pixiv assets and ai tagging', () => {
    it('excludes Pixiv works from AI tagging', async () => {
        await app.request('/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                ai: {
                    external: {
                        enabled: true,
                        baseUrl: `${baseUrl}/v1`,
                        apiKey: 'test-key',
                        model: 'test-model',
                    },
                },
            }),
        });

        const album = await createAlbum('Pixiv AI Exclude');
        const pixivAssetId = await importNamedImage(album.id, '123456_p0.jpg', { r: 10, g: 80, b: 120 });
        const normalAssetId = await importNamedImage(album.id, 'ordinary-photo.jpg', { r: 200, g: 160, b: 40 });
        const started = await app.request(`/albums/${album.id}/ai/tag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                mode: 'external',
                assetIds: [pixivAssetId, normalAssetId],
            }),
        });

        expect(started.status).toBe(202);

        const jobId = (await started.json()).data.id as string;
        const deadline = Date.now() + 20_000;
        let job: { status: string, total: number, processed: number } | null = null;

        while (Date.now() < deadline) {
            job = (await (await app.request(`/albums/${album.id}/ai/jobs/${jobId}`)).json()).data;

            if (job?.status === 'completed' || job?.status === 'failed') {
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        expect(job?.status).toBe('completed');
        expect(job?.total).toBe(1);
        expect(job?.processed).toBe(1);

        const pixivDetail = (await (await app.request(`/albums/${album.id}/assets/${pixivAssetId}`)).json()).data;
        const normalDetail = (await (await app.request(`/albums/${album.id}/assets/${normalAssetId}`)).json()).data;

        expect(pixivDetail.meta.pixiv).toMatchObject({ illustId: '123456', pageIndex: 0 });
        expect(pixivDetail.meta.ai).toBeUndefined();
        expect(normalDetail.meta.ai).toBeDefined();
    });
});

describe('pixiv ugoira', () => {
    it('caches the archive and serves it once', async () => {
        const album = await createAlbum('Pixiv Ugoira');

        await enablePixiv(album.id);
        await login();

        const assetId = await importNamedImage(album.id, '777777_p0.jpg', { r: 150, g: 90, b: 30 });
        const context = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv`);
        const data = (await context.json()).data;

        expect(data.illust.type).toBe('ugoira');
        expect(data.illust.ugoira.frames).toHaveLength(2);

        const before = zipRequests;
        const archive = await app.request(`/albums/${album.id}/assets/${assetId}/pixiv/ugoira`);

        expect(archive.status).toBe(200);
        expect(archive.headers.get('content-type')).toBe('application/zip');

        const bytes = Buffer.from(await archive.arrayBuffer());

        expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
        expect(zipRequests).toBe(before + 1);

        await app.request(`/albums/${album.id}/assets/${assetId}/pixiv/ugoira`);
        expect(zipRequests).toBe(before + 1);
    });
});
