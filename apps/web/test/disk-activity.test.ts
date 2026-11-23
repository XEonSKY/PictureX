import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { createAlbum, getAlbum } from '../server/album/album-store';
import { createImportJob, updateImportJob } from '../server/album/import-job-store';
import { invalidateJobViewCache } from '../server/jobs/job-query';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeTaskDatabase } from '../server/database/task';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import type { DiskActivityDto } from '../server/jobs/disk-activity';

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-disk-'));
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
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

async function diskActivity(): Promise<DiskActivityDto> {
    const response = await app.request('/jobs/disk');

    expect(response.status).toBe(200);

    return (await response.json()).data as DiskActivityDto;
}

describe('GET /jobs/disk', () => {
    it('returns an idle snapshot with the thumbnail queue shape', async () => {
        const data = await diskActivity();

        expect(data.items).toEqual([]);
        expect(data.thumbnails).toMatchObject({
            interactiveActive: expect.any(Number),
            interactivePending: expect.any(Number),
            backgroundActive: expect.any(Number),
            backgroundPending: expect.any(Number),
            interactiveConcurrency: expect.any(Number),
            ewmaMs: expect.any(Number),
        });
    });

    it('lists paused import jobs as active disk work', async () => {
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Disk Activity' });
        const context = getAlbum(settings, album.id);

        createImportJob(album.id, 'disk-job-1', context.dir);
        updateImportJob(album.id, 'disk-job-1', { status: 'paused', total: 10, processed: 4 });
        invalidateJobViewCache();

        const data = await diskActivity();
        const job = data.items.find(item => item.kind === 'import');

        expect(job).toMatchObject({
            albumId: album.id,
            albumName: 'Disk Activity',
            touch: 'reading-writing',
            done: 4,
            total: 10,
            paused: true,
        });
    });
});
