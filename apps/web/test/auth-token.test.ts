import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { getAlbum } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { assets } from '../server/database/schemas/album';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import { storageForAlbum } from '../server/storage/registry';

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-auth-'));
    process.env.NUXT_DATA_DIR = dataDir;
    process.env.PX_AUTH_TOKEN = 'test-token';
    resetSettingsCache();

    const module = await import('../server/hono/app');

    app = module.default;
});

afterAll(() => {
    closeAllAlbumDatabases();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;
    delete process.env.PX_AUTH_TOKEN;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('optional access token', () => {
    it('keeps health public and requires a token for other APIs', async () => {
        expect((await app.request('/health')).status).toBe(200);

        const missing = await app.request('/albums');

        expect(missing.status).toBe(401);
        expect((await missing.json()).code).toBe('auth_required');

        const header = await app.request('/albums', {
            headers: { authorization: 'Bearer test-token' },
        });

        expect(header.status).toBe(200);
    });

    it('accepts ?token= and sets an auth cookie', async () => {
        const response = await app.request('/albums?token=test-token');

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toContain('picturex.token=');
    });

    it('keeps Set-Cookie and x-request-id on raw media responses', async () => {
        const created = await app.request('/albums', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer test-token' },
            body: JSON.stringify({ name: 'token-media' }),
        });
        const albumId = (await created.json()).data.id as string;
        const settings = getSettings();
        const context = getAlbum(settings, albumId);
        const storage = storageForAlbum(context.dir, settings);
        const stored = await storage.put({
            sequence: 1,
            ext: 'jpg',
            data: Buffer.from('x'),
        });
        const assetId = '01900000-0000-7000-8000-0000000000aa';

        context.db.album.insert(assets).values({
            id: assetId,
            storageKey: stored.key,
            filename: 'token.jpg',
            ext: 'jpg',
            mime: 'image/jpeg',
            kind: 'image',
            size: stored.size,
            sha256: 'a'.repeat(64),
            phash: null,
            takenAt: null,
            addedAt: Math.floor(Date.now() / 1000),
            meta: '{}',
        }).run();

        const response = await app.request(`/albums/${albumId}/assets/${assetId}/file?token=test-token`);

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toContain('picturex.token=');
        expect(response.headers.get('x-request-id')).toBeTruthy();
    });

    it('rejects a wrong token', async () => {
        const response = await app.request('/albums', {
            headers: { 'x-picturex-token': 'wrong' },
        });

        expect(response.status).toBe(401);
    });
});
