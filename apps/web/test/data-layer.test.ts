import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocateSequence, partitionForSequence, storageKeyFor, writeMeta } from '../server/album/album-meta';
import { listRegisteredAlbums } from '../server/album/album-registry';
import { createAlbum, createTag, getAlbum, listAlbums, listTags } from '../server/album/album-store';
import { createThumbStore } from '../server/album/thumb-store';
import { thumbnailTable } from '../server/album/thumb-tables';
import {
    albumDatabase,
    albumThumbnailDatabasePath,
    closeAlbumDatabase,
    closeAllAlbumDatabases,
    closeIdleAlbumDatabases,
    holdAlbumDatabase,
    leaseAlbumDatabase,
    openAlbumDatabase,
    optimizeAlbumDatabases,
    registerAlbumIdleHook,
} from '../server/database/album';
import { isSimilarityIndexFresh, META_SIMILARITY_INDEX } from '../server/ingest/similarity-index';
import { assets } from '../server/database/schemas/album';
import { MODEL_CATALOG } from '../server/model/catalog';
import { ModelRegistry } from '../server/model/model-registry';
import { parseSettings } from '../server/settings/setting-schema';
import { loadSettings, resetSettingsCache } from '../server/settings/setting-store';
import { LocalStorageAdapter } from '../server/storage/local';
import { describeDataDirectories } from '../server/utils/data-dir';

const tempDirs: string[] = [];
let testDataDir = '';

function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'picturex-test-'));

    tempDirs.push(dir);

    return dir;
}

beforeEach(() => {
    testDataDir = mkdtempSync(join(tmpdir(), 'picturex-data-'));
    process.env.NUXT_DATA_DIR = testDataDir;
    resetSettingsCache();
});

afterEach(() => {
    closeAllAlbumDatabases();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    for (const dir of [testDataDir, ...tempDirs.splice(0)]) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
        catch {
            // Windows 下 SQLite 句柄释放有延迟，测试结束时忽略清理失败
        }
    }
});

describe('settings store', () => {
    it('writes defaults atomically and derives album/model roots', () => {
        const root = tempRoot();
        const dirs = describeDataDirectories({ argv: ['-dataDir', root], isProduction: true });
        const settings = loadSettings(dirs);
        const raw = JSON.parse(readFileSync(join(root, 'setting.json'), 'utf8'));

        expect(settings.schemaVersion).toBe(1);
        expect(settings.albumsRoot).toBe(join(root, 'albums'));
        expect(settings.modelsRoot).toBe(join(root, 'models'));
        expect(settings.storage.partitionMode).toBe('sequence');
        expect(raw.theme.preset).toBe('light');
        expect(raw.i18n.defaultLocale).toBe('zh-CN');
    });

    it('rejects a non-sequence partition mode at startup', () => {
        const root = tempRoot();
        const dirs = describeDataDirectories({ argv: ['-dataDir', root], isProduction: true });

        writeFileSync(join(root, 'setting.json'), JSON.stringify({ storage: { partitionMode: 'hash' } }));

        expect(() => loadSettings(dirs)).toThrow(/sequence/u);
    });

    it('rejects unimplemented storage backends at startup', () => {
        expect(() => parseSettings({ storage: { default: 'quark' } })).toThrow(/local/u);
    });
});

describe('sequence partitioning', () => {
    it('maps sequence numbers to 4-digit partitions', () => {
        expect(partitionForSequence(0, 8192)).toBe(1);
        expect(partitionForSequence(8191, 8192)).toBe(1);
        expect(partitionForSequence(8192, 8192)).toBe(2);
        expect(storageKeyFor(8192, 8192, 'jpg', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000'))
            .toBe('storage/0002/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jpg');
    });

    it('allocates monotonically inside a transaction', () => {
        const root = tempRoot();
        const handle = openAlbumDatabase(root);

        expect(allocateSequence(handle.album)).toBe(0);
        expect(allocateSequence(handle.album)).toBe(1);
        expect(allocateSequence(handle.album)).toBe(2);
        handle.close();
    });
});

describe('album store', () => {
    it('creates a self-contained album folder with index and databases', () => {
        const root = tempRoot();
        const settings = parseSettings({ albumsRoot: join(root, 'albums'), modelsRoot: join(root, 'models') });
        const album = createAlbum(settings, { name: '  Trip  ', description: 'Summer' });

        expect(album.name).toBe('Trip');
        expect(listAlbums(settings).map(item => item.id)).toEqual([album.id]);

        const dir = join(settings.albumsRoot, album.id);

        expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).name).toBe('Trip');
        // 建相册只落 index；SQLite（含 tag.db）要等真正访问相册时才创建
        expect(existsSync(join(dir, 'picture.db'))).toBe(false);
        expect(existsSync(join(dir, 'data', 'picture.db'))).toBe(false);
        expect(existsSync(join(dir, 'data', 'tag.db'))).toBe(false);
        expect(existsSync(join(dir, 'tag.json'))).toBe(false);

        getAlbum(settings, album.id);

        expect(readFileSync(join(dir, 'data', 'picture.db')).subarray(0, 15).toString()).toBe('SQLite format 3');
        expect(readFileSync(join(dir, 'data', 'tag.db')).subarray(0, 15).toString()).toBe('SQLite format 3');
        // 缩略图库不再写进相册目录，而是统一放在数据根的 data/ 里
        expect(existsSync(join(dir, 'thumbnails.db'))).toBe(false);
        expect(albumThumbnailDatabasePath()).toBe(join(testDataDir, 'data', 'thumbnails.db'));
        expect(existsSync(albumThumbnailDatabasePath())).toBe(true);

        const tag = createTag(settings, album.id, { name: 'Travel' });

        expect(listTags(settings, album.id)).toEqual([tag]);
        closeAlbumDatabase(dir);
    });

    it('treats a persisted group-count mismatch as stale after an interrupted rebuild', () => {
        const root = tempRoot();
        const settings = parseSettings({ albumsRoot: join(root, 'albums'), modelsRoot: join(root, 'models') });
        const album = createAlbum(settings, { name: 'Similarity' });
        const context = getAlbum(settings, album.id);
        const meta = {
            threshold: 8,
            phashedCount: 0,
            assetCount: 0,
            groups: 2,
            updatedAt: new Date().toISOString(),
        };

        writeMeta(context.db.album, META_SIMILARITY_INDEX, JSON.stringify(meta));

        // 上次重建在删除旧分组后中断：meta 仍写着 2 组，但表已空
        expect(isSimilarityIndexFresh(context.db.album, 8)).toBe(false);

        writeMeta(context.db.album, META_SIMILARITY_INDEX, JSON.stringify({ ...meta, groups: 0 }));

        expect(isSimilarityIndexFresh(context.db.album, 8)).toBe(true);

        closeAlbumDatabase(join(settings.albumsRoot, album.id));
    });

    it('maintains the generated pixiv column used by AI filtering', () => {
        const root = tempRoot();
        const settings = parseSettings({ albumsRoot: join(root, 'albums'), modelsRoot: join(root, 'models') });
        const album = createAlbum(settings, { name: 'Generated Pixiv' });
        const context = getAlbum(settings, album.id);
        const base = {
            ext: 'jpg',
            mime: 'image/jpeg',
            kind: 'image',
            size: 1,
            addedAt: new Date().toISOString(),
        };

        context.db.album.insert(assets).values({
            ...base,
            id: 'pixiv-asset',
            storageKey: 'storage/0001/pixiv-asset.jpg',
            filename: '123456_p0.jpg',
            sha256: 'a'.repeat(64),
            meta: JSON.stringify({ pixiv: { illustId: '123456', pageIndex: 0 } }),
        }).run();
        context.db.album.insert(assets).values({
            ...base,
            id: 'plain-asset',
            storageKey: 'storage/0001/plain-asset.jpg',
            filename: 'plain.jpg',
            sha256: 'b'.repeat(64),
            meta: '{}',
        }).run();

        const rows = context.db.album
            .select({ id: assets.id, pixiv: assets.pixivIllustId })
            .from(assets)
            .all();

        expect(rows.find(row => row.id === 'pixiv-asset')?.pixiv).toBe('123456');
        expect(rows.find(row => row.id === 'plain-asset')?.pixiv).toBeNull();

        closeAlbumDatabase(join(settings.albumsRoot, album.id));
    });

    it('refuses to reseed a corrupt album registry', () => {
        const root = tempRoot();
        const settings = parseSettings({ albumsRoot: join(root, 'albums'), modelsRoot: join(root, 'models') });
        const registry = join(settings.albumsRoot, '.albums.json');

        mkdirSync(settings.albumsRoot, { recursive: true });
        writeFileSync(registry, '{ broken');

        expect(() => listRegisteredAlbums(settings)).toThrow(/registry/u);
        // 损坏文件保持原样，不能被重新扫描结果覆盖
        expect(readFileSync(registry, 'utf8')).toBe('{ broken');
    });

    it('caches the album registry by mtime+size and reloads after an external rewrite', () => {
        const root = tempRoot();
        const settings = parseSettings({ albumsRoot: join(root, 'albums'), modelsRoot: join(root, 'models') });
        const registry = join(settings.albumsRoot, '.albums.json');

        mkdirSync(settings.albumsRoot, { recursive: true });

        const album = createAlbum(settings, { name: 'Cached' });
        const ids = () => listRegisteredAlbums(settings).map(entry => entry.id);

        // createAlbum 经 persist 写盘会失效缓存；随后读取落入缓存并保持一致
        expect(ids()).toContain(album.id);
        expect(ids()).toContain(album.id);

        // 外部直接改写登记表（size 变化）必须重新解析，而不是吐回旧缓存
        const forged = {
            schemaVersion: 2,
            albums: [{ id: 'external-1', dir: join(settings.albumsRoot, 'ext'), name: 'Ext', registeredAt: '2026-01-01T00:00:00.000Z' }],
        };

        writeFileSync(registry, JSON.stringify(forged));

        expect(ids()).toEqual(['external-1']);
    });

    it('runs 8 album databases concurrently without SQLITE_BUSY', async () => {
        const root = tempRoot();

        await Promise.all(Array.from({ length: 8 }, async (_, index) => {
            const dir = join(root, `album-${index}`);
            const handle = openAlbumDatabase(dir);

            for (let round = 0; round < 50; round += 1) {
                allocateSequence(handle.album);
            }

            expect(handle.album.$client.pragma('journal_mode', { simple: true })).toBe('wal');
            expect(handle.album.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
            handle.close();
        }));
    });

    it('keeps keyset pagination on a partial sort index instead of a full-table sort', () => {
        const handle = openAlbumDatabase(tempRoot());

        try {
            const indexes = handle.album.$client
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'assets_active%' ORDER BY name")
                .all() as { name: string }[];

            expect(indexes.map(row => row.name)).toEqual([
                'assets_active_added_idx',
                'assets_active_favorite_idx',
                'assets_active_filename_idx',
                'assets_active_pixiv_idx',
                'assets_active_taken_idx',
            ]);

            const client = handle.album.$client;
            const insert = client.prepare(`
                INSERT INTO assets (id, storage_key, filename, ext, mime, kind, size, sha256, added_at, meta)
                VALUES (?, ?, ?, 'jpg', 'image/jpeg', 'image', 1, ?, ?, '{}')
            `);

            for (let index = 0; index < 20; index += 1) {
                insert.run(`asset-${index}`, `storage/${index}.jpg`, `file-${index}.jpg`, `sha-${index}`, `2026-01-01T00:00:0${index % 10}.000Z`);
            }

            client.exec('ANALYZE assets');

            const plan = client
                .prepare('EXPLAIN QUERY PLAN SELECT id FROM assets WHERE deleted_at IS NULL ORDER BY added_at DESC, id DESC LIMIT 501')
                .all() as { detail: string }[];

            expect(plan.some(row => row.detail.includes('assets_active_added_idx'))).toBe(true);
            expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false);
        }
        finally {
            handle.close();
        }
    });
});

describe('album idle maintenance', () => {
    it('runs registered maintenance hooks for idle album databases', () => {
        const dir = tempRoot();
        let called = 0;
        const unregister = registerAlbumIdleHook((target) => {
            if (target === dir) {
                called += 1;
            }
        });

        try {
            albumDatabase(dir);
            optimizeAlbumDatabases(0);

            expect(called).toBe(1);
        }
        finally {
            unregister();
            closeAlbumDatabase(dir);
        }
    });

    it('invokes maintenance before closing an idle database', () => {
        const dir = tempRoot();
        let called = 0;
        const unregister = registerAlbumIdleHook((target) => {
            if (target === dir) {
                called += 1;
            }
        });

        try {
            albumDatabase(dir);
            closeIdleAlbumDatabases(0);

            expect(called).toBe(1);
        }
        finally {
            unregister();
            closeAlbumDatabase(dir);
        }
    });
});

describe('local storage', () => {
    it('stores files in sequence partitions and blocks path traversal', async () => {
        const root = tempRoot();
        const adapter = new LocalStorageAdapter(root, 2);

        const first = await adapter.put({ sequence: 0, ext: 'jpg', data: Buffer.from('a') });
        const second = await adapter.put({ sequence: 1, ext: 'png', data: Buffer.from('bb') });
        const third = await adapter.put({ sequence: 2, ext: 'webp', data: Buffer.from('ccc') });

        expect(first.key).toMatch(/^storage\/0001\/[0-9a-f-]+\.jpg$/u);
        expect(second.key).toMatch(/^storage\/0001\//u);
        expect(third.key).toMatch(/^storage\/0002\//u);

        const chunks: Buffer[] = [];

        for await (const chunk of await adapter.open(third.key)) {
            chunks.push(Buffer.from(chunk));
        }

        expect(Buffer.concat(chunks).toString()).toBe('ccc');
        expect(await adapter.exists(first.key)).toBe(true);

        await adapter.delete(first.key);
        expect(await adapter.exists(first.key)).toBe(false);

        await expect(adapter.delete('../escape')).rejects.toThrow(/越界/u);
    });
});

describe('thumbnail store', () => {
    it('round-trips BLOB data and evicts LRU to 90% of the cap', () => {
        const handle = openAlbumDatabase(tempRoot());
        const store = createThumbStore(handle.thumbnails, 1, 'test-album');
        const maxBytes = 1024 * 1024;
        const payload = Buffer.alloc(200 * 1024, 7);

        for (let index = 0; index < 5; index += 1) {
            store.put({ assetId: `asset-${index}`, size: 256, mime: 'image/webp', blob: payload, width: 10, height: 10 });
        }

        expect(store.get('asset-0', 256)?.blob.byteLength).toBe(payload.byteLength);
        expect(store.totalBytes()).toBeLessThanOrEqual(maxBytes);

        // 把最早的一条标成更久未访问，再写一条触发淘汰
        handle.thumbnails.$client
            .prepare(`UPDATE ${thumbnailTable(256)} SET last_accessed_at = ? WHERE album_id = ? AND asset_id = ?`)
            .run(0, 'test-album', 'asset-0');

        store.put({ assetId: 'asset-new', size: 256, mime: 'image/webp', blob: payload, width: 10, height: 10 });

        const total = store.totalBytes();
        const oldestExists = store.has('asset-0', 256);

        handle.close();

        expect(oldestExists).toBe(false);
        expect(total).toBeLessThanOrEqual(maxBytes * 0.9);
    });

    it('stores each size in its own table and reports them separately', () => {
        const handle = openAlbumDatabase(tempRoot());
        const store = createThumbStore(handle.thumbnails, 100, 'test-album-split');
        const client = handle.thumbnails.$client;

        store.put({ assetId: 'split', size: 256, mime: 'image/webp', blob: Buffer.alloc(20), width: 2, height: 2 });
        store.put({ assetId: 'split', size: 1024, mime: 'image/webp', blob: Buffer.alloc(80), width: 4, height: 4 });

        expect(store.assetSizes('split')).toEqual([256, 1024]);
        expect(store.sizeBreakdown()).toEqual([
            { size: 256, count: 1, bytes: 20 },
            { size: 1024, count: 1, bytes: 80 },
        ]);
        // 每个尺寸只落在自己的分表里，不再有跨尺寸的 thumbnails 单表
        expect(client.prepare(`SELECT count(*) n FROM ${thumbnailTable(256)}`).get()).toEqual({ n: 1 });
        expect(client.prepare(`SELECT count(*) n FROM ${thumbnailTable(1024)}`).get()).toEqual({ n: 1 });
        expect(client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thumbnails'").get())
            .toBeUndefined();
        expect(store.totalBytes()).toBe(100);

        // 触发器按分表增量维护累计字节：删掉一个尺寸后只剩另一个的字节
        store.deleteAsset('split');
        expect(store.totalBytes()).toBe(0);

        handle.close();
    });

    it('cleans corrupted rows where blob length differs from sizeBytes', () => {
        const handle = openAlbumDatabase(tempRoot());
        const store = createThumbStore(handle.thumbnails, 10, 'test-album-clean');

        store.put({ assetId: 'a', size: 256, mime: 'image/webp', blob: Buffer.alloc(10), width: 1, height: 1 });

        handle.thumbnails.$client.prepare(`UPDATE ${thumbnailTable(256)} SET size_bytes = 999 WHERE album_id = ? AND asset_id = ?`).run('test-album-clean', 'a');

        const removed = store.cleanupCorrupted();
        const remaining = store.count();

        handle.close();

        expect(removed).toBe(1);
        expect(remaining).toBe(0);
    });
});

describe('model registry', () => {
    it('keeps installed models but drops removed catalogue entries', () => {
        const root = tempRoot();
        const modelsRoot = join(root, 'models');
        const now = new Date().toISOString();

        mkdirSync(modelsRoot, { recursive: true });
        writeFileSync(join(modelsRoot, 'index.json'), JSON.stringify({
            schemaVersion: 1,
            models: [
                {
                    id: 'ghost-model',
                    name: 'Ghost',
                    task: 'captioning',
                    description: '',
                    status: 'available',
                    totalBytes: 0,
                    files: [],
                    installedFiles: [],
                    installedAt: null,
                    updatedAt: now,
                    error: null,
                },
                {
                    id: 'kept-model',
                    name: 'Kept',
                    task: 'captioning',
                    description: '',
                    status: 'installed',
                    totalBytes: 10,
                    files: [{ path: 'a.bin', url: '', size: 10, sha256: '' }],
                    installedFiles: [{ path: 'a.bin', size: 10, sha256: '' }],
                    installedAt: now,
                    updatedAt: now,
                    error: null,
                },
            ],
        }, null, 4));

        const ids = new ModelRegistry(modelsRoot).list().map(model => model.id);

        expect(ids).not.toContain('ghost-model');
        expect(ids).toContain('kept-model');
        expect(ids).toContain('clip-vit-base-patch32');
    });

    it('pins size and sha256 for every built-in model file', () => {
        for (const definition of MODEL_CATALOG) {
            expect(definition.files.length).toBeGreaterThan(0);

            for (const file of definition.files) {
                expect(file.size, `${definition.id}/${file.path}`).toBeGreaterThan(0);
                expect(file.sha256, `${definition.id}/${file.path}`).toMatch(/^[0-9a-f]{64}$/u);
                expect(file.url.startsWith('https://'), file.url).toBe(true);
            }
        }
    });
});

describe('album database lifecycle', () => {
    it('opens on demand and closes idle connections', () => {
        const dir = join(tempRoot(), 'lazy-album');

        expect(existsSync(join(dir, 'data', 'picture.db'))).toBe(false);

        albumDatabase(dir);

        expect(existsSync(join(dir, 'data', 'picture.db'))).toBe(true);
        expect(closeIdleAlbumDatabases(0)).toBe(1);
        expect(closeIdleAlbumDatabases(0)).toBe(0);
    });
});

describe('album database leases', () => {
    it('skips leased connections during idle sweeps and closes them after release', () => {
        const dir = join(tempRoot(), 'leased-album');
        const lease = leaseAlbumDatabase(dir);
        const handle = lease.handle;

        expect(closeIdleAlbumDatabases(0)).toBe(0);
        expect(() => handle.album.$client.prepare('SELECT 1').get()).not.toThrow();

        lease.release();

        expect(closeIdleAlbumDatabases(0)).toBe(1);
        expect(handle.album.$client.open).toBe(false);
    });
});

describe('album database request scope', () => {
    it('keeps an open handle alive while a request holds it', () => {
        const dir = join(tempRoot(), 'request-scoped-album');

        albumDatabase(dir);

        const release = holdAlbumDatabase(dir);

        expect(closeIdleAlbumDatabases(0)).toBe(0);
        expect(closeAlbumDatabase(dir)).toBe(false);

        release();
        // release 幂等：重复调用不能让计数变成负数
        release();

        expect(closeAlbumDatabase(dir)).toBe(true);
    });

    it('opens a cold handle so concurrent close sees the request', () => {
        const dir = join(tempRoot(), 'cold-album');
        const release = holdAlbumDatabase(dir);

        expect(closeAlbumDatabase(dir)).toBe(false);

        release();

        expect(closeAlbumDatabase(dir)).toBe(true);
    });
});
