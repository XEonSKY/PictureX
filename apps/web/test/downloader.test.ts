import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DownloadTaskStore } from '../server/model/download-task-store';
import { ModelDownloader } from '../server/model/model-downloader';
import { ModelRegistry } from '../server/model/model-registry';
import type { ModelEntry } from '../server/model/types';
import { parseSettings } from '../server/settings/setting-schema';

const cleanup: (() => Promise<void> | void)[] = [];

function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'picturex-dl-'));

    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    return dir;
}

function sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

interface ServeOptions {
    content: Buffer
    etag?: string
    chunkSize?: number
    delayMs?: number
    failures?: number
    ignoreRange?: boolean
}

function serve(options: ServeOptions): Promise<{ url: string, close: () => Promise<void> }> {
    const chunkSize = options.chunkSize ?? 64 * 1024;
    const delayMs = options.delayMs ?? 2;

    function writeBody(target: ServerResponse, body: Buffer): void {
        let offset = 0;

        const tick = () => {
            if (target.destroyed) {
                return;
            }

            if (offset >= body.byteLength) {
                target.end();

                return;
            }

            const chunk = body.subarray(offset, Math.min(offset + chunkSize, body.byteLength));

            offset += chunk.byteLength;
            target.write(chunk);
            setTimeout(tick, delayMs);
        };

        tick();
    }

    let failures = options.failures ?? 0;

    const server: Server = createServer((req, res) => {
        if (failures > 0) {
            failures -= 1;
            req.destroy();

            return;
        }

        const etag = options.etag ?? '"v1"';
        const range = req.headers.range;
        const ifRange = req.headers['if-range'];
        const validRange = typeof range === 'string' && (!ifRange || ifRange === etag);

        if (req.method === 'HEAD') {
            res.writeHead(200, {
                'content-length': String(options.content.byteLength),
                'accept-ranges': 'bytes',
                etag,
                'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
            });
            res.end();

            return;
        }

        if (validRange && range && !options.ignoreRange) {
            const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
            const start = Number(match?.[1] ?? 0);
            const end = match?.[2] ? Number(match[2]) : options.content.byteLength - 1;
            const body = options.content.subarray(start, end + 1);

            res.writeHead(206, {
                'content-type': 'application/octet-stream',
                'content-length': String(body.byteLength),
                'content-range': `bytes ${start}-${end}/${options.content.byteLength}`,
                'accept-ranges': 'bytes',
                etag,
                'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
            });
            writeBody(res, body);

            return;
        }

        // 客户端带了旧 If-Range：按约定回 200 全量
        res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(options.content.byteLength),
            'accept-ranges': 'bytes',
            etag,
            'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
        });
        writeBody(res, options.content);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if (!address || typeof address === 'string') {
                throw new Error('failed to bind test server');
            }

            cleanup.push(async () => {
                server.closeAllConnections();
                await new Promise<void>(done => server.close(() => done()));
            });

            resolve({
                url: `http://127.0.0.1:${address.port}/model.bin`,
                close: async () => {
                    server.closeAllConnections();
                    await new Promise<void>(done => server.close(() => done()));
                },
            });
        });
    });
}

function makeEntry(url: string, content: Buffer, hash: string): ModelEntry {
    return {
        id: 'test-model',
        name: 'Test Model',
        task: 'zero-shot',
        description: 'fixture',
        status: 'available',
        totalBytes: content.byteLength,
        files: [{
            path: 'onnx/model.onnx',
            url,
            size: content.byteLength,
            sha256: hash,
        }],
        installedFiles: [],
        installedAt: null,
        updatedAt: new Date().toISOString(),
        error: null,
    };
}

function setup(root: string, entry: ModelEntry) {
    const settings = parseSettings({
        albumsRoot: join(root, 'albums'),
        modelsRoot: join(root, 'models'),
        ai: { downloadConcurrency: 3 },
    });
    const registry = new ModelRegistry(settings.modelsRoot);

    registry.importEntry(entry);

    const downloadDir = join(root, '.download');
    const store = new DownloadTaskStore(downloadDir);
    const downloader = new ModelDownloader({ settings, downloadDir, registry, store });

    return { settings, registry, store, downloader };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timeout waiting for condition');
        }

        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) {
        await task();
    }
});

describe('model downloader', () => {
    it('downloads sharded content, verifies sha256 and installs', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(9 * 1024 * 1024 + 123, 3);
        const hash = sha256(content);
        const server = await serve({ content, delayMs: 0 });
        const { downloader, store, registry } = setup(root, makeEntry(server.url, content, hash));

        await downloader.start('test-model');
        await waitFor(() => store.get('test-model')?.status === 'completed');

        const installed = readFileSync(join(registry.dirFor('test-model'), 'onnx/model.onnx'));

        expect(installed.byteLength).toBe(content.byteLength);
        expect(sha256(installed)).toBe(hash);
        expect(registry.get('test-model').status).toBe('installed');
        expect(registry.get('test-model').installedFiles[0]?.sha256).toBe(hash);
    }, 30_000);

    it('retries dropped connections instead of failing the download', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(3 * 1024 * 1024 + 7, 11);
        const hash = sha256(content);
        const server = await serve({ content, delayMs: 0, failures: 3 });
        const { downloader, store, registry } = setup(root, makeEntry(server.url, content, hash));

        await downloader.start('test-model');
        await waitFor(() => store.get('test-model')?.status === 'completed');

        expect(registry.get('test-model').status).toBe('installed');
        expect(sha256(readFileSync(join(registry.dirFor('test-model'), 'onnx/model.onnx')))).toBe(hash);
    }, 40_000);

    it('falls back to a whole download when the server ignores Range', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(300 * 1024, 21);
        const hash = sha256(content);
        const server = await serve({ content, delayMs: 0, ignoreRange: true });
        const { downloader, store, registry } = setup(root, makeEntry(server.url, content, hash));

        await downloader.start('test-model');
        await waitFor(() => store.get('test-model')?.status === 'completed');

        const installed = readFileSync(join(registry.dirFor('test-model'), 'onnx/model.onnx'));

        expect(installed.byteLength).toBe(content.byteLength);
        expect(sha256(installed)).toBe(hash);
        expect(store.get('test-model')?.totalBytes).toBe(content.byteLength);
    }, 30_000);

    it('pauses after in-flight chunks and resumes from the byte offset', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(9 * 1024 * 1024, 5);
        const hash = sha256(content);
        const server = await serve({ content, delayMs: 4, chunkSize: 32 * 1024 });
        const { downloader, store, registry } = setup(root, makeEntry(server.url, content, hash));

        await downloader.start('test-model');
        await waitFor(() => (store.get('test-model')?.bytesDone ?? 0) > 512 * 1024);

        const paused = await downloader.pause('test-model');

        expect(paused.status).toBe('paused');
        const checkpoint = paused.bytesDone;

        expect(checkpoint).toBeGreaterThan(0);
        expect(checkpoint).toBeLessThan(content.byteLength);

        await downloader.resume('test-model');
        await waitFor(() => store.get('test-model')?.status === 'completed');

        const installed = readFileSync(join(registry.dirFor('test-model'), 'onnx/model.onnx'));

        expect(sha256(installed)).toBe(hash);
    }, 40_000);

    it('re-downloads fully when the server ETag changes (If-Range)', async () => {
        const root = tempRoot();
        const contentA = Buffer.alloc(9 * 1024 * 1024, 1);
        const contentB = Buffer.alloc(9 * 1024 * 1024, 9);
        const options = { content: contentA, etag: '"v1"', delayMs: 4, chunkSize: 32 * 1024 };
        const server = await serve(options);
        const { downloader, store, registry } = setup(root, makeEntry(server.url, contentA, sha256(contentA)));

        await downloader.start('test-model');
        await waitFor(() => (store.get('test-model')?.bytesDone ?? 0) > 512 * 1024);
        await downloader.pause('test-model');

        options.content = contentB;
        options.etag = '"v2"';
        registry.importEntry(makeEntry(server.url, contentB, sha256(contentB)));

        await downloader.resume('test-model');
        await waitFor(() => store.get('test-model')?.status === 'completed');

        const installed = readFileSync(join(registry.dirFor('test-model'), 'onnx/model.onnx'));

        expect(sha256(installed)).toBe(sha256(contentB));
    }, 45_000);

    it('fails with a checksum error and never installs a corrupted file', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(256 * 1024, 8);
        const server = await serve({ content, delayMs: 0 });
        const { downloader, store, registry } = setup(root, makeEntry(server.url, content, 'deadbeef'));

        await downloader.start('test-model');
        await waitFor(() => store.get('test-model')?.status === 'failed');

        expect(store.get('test-model')?.error).toContain('checksum');
        expect(registry.get('test-model').status).not.toBe('installed');
    }, 30_000);

    it('cancels a running download and removes partial files', async () => {
        const root = tempRoot();
        const content = Buffer.alloc(9 * 1024 * 1024, 1);
        const server = await serve({ content, delayMs: 4, chunkSize: 32 * 1024 });
        const { downloader, store } = setup(root, makeEntry(server.url, content, sha256(content)));

        await downloader.start('test-model');
        await waitFor(() => (store.get('test-model')?.bytesDone ?? 0) > 256 * 1024);
        const cancelled = await downloader.cancel('test-model');

        expect(cancelled.status).toBe('cancelled');
        expect(store.get('test-model')?.speedBps).toBe(0);
    }, 30_000);
});
