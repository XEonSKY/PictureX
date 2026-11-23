import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../server/hono/env';
import { closeAllAlbumDatabases } from '../server/database/album';
import { resetSettingsCache } from '../server/settings/setting-store';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

let app: Hono<AppEnv>;
let dataDir: string;

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-media-'));
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
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    const deadline = Date.now() + 30_000;

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

async function assetsOf(albumId: string): Promise<{ id: string, ext: string }[]> {
    return (await (await app.request(`/albums/${albumId}/assets?limit=10`)).json()).data;
}

describe('media preview and playback', () => {
    it('transcodes a non-native container to a fragmented mp4 stream', async () => {
        const album = await createAlbum('Video Album');
        const root = mkdtempSync(join(tmpdir(), 'picturex-video-'));

        try {
            const png = join(root, 'frame.png');
            const mkv = join(root, 'clip.mkv');

            await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 30, g: 120, b: 200 } } })
                .png()
                .toFile(png);

            const ffmpeg = nodeRequire('ffmpeg-static') as string;

            await execFileAsync(ffmpeg, [
                '-y',
                '-loop', '1',
                '-i', png,
                '-t', '1',
                '-r', '10',
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-an',
                '-metadata', 'title=PictureXSecret',
                '-metadata', 'comment=LegacyContainerMetadata',
                mkv,
            ], { timeout: 30_000 });

            await importAndWait(album.id, root);

            const [asset] = await assetsOf(album.id);
            const response = await app.request(`/albums/${album.id}/assets/${asset?.id}/stream`);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('video/mp4');

            const body = await response.arrayBuffer();

            expect(body.byteLength).toBeGreaterThan(1_000);

            // 转码流不能把输入容器的标题/注释等元数据带出去
            const output = join(root, 'stream.mp4');
            const ffprobe = (nodeRequire('ffprobe-static') as { path: string }).path;

            writeFileSync(output, Buffer.from(body));

            const probed = await execFileAsync(ffprobe, [
                '-v', 'error',
                '-show_entries', 'format_tags:stream_tags',
                '-of', 'json',
                output,
            ], { timeout: 30_000 });

            expect(probed.stdout).not.toContain('PictureXSecret');
            expect(probed.stdout).not.toContain('LegacyContainerMetadata');
        }
        finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });

    it('skips an undecodable heic file without creating a broken asset', async () => {
        const album = await createAlbum('HEIC Skip');
        const root = mkdtempSync(join(tmpdir(), 'picturex-heic-'));

        try {
            const { writeFileSync } = await import('node:fs');

            writeFileSync(join(root, 'broken.heic'), 'not a real heic');

            await importAndWait(album.id, root);

            expect(await assetsOf(album.id)).toHaveLength(0);

            const jobs: { data: { skipped: number }[] } = await (await app.request(`/albums/${album.id}/imports`)).json();

            expect(jobs.data[0]?.skipped).toBe(1);
        }
        finally {
            rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    });
});
