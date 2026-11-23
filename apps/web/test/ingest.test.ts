import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createAlbum, getAlbum } from '../server/album/album-store';
import { getImportJob } from '../server/album/import-job-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeTaskDatabase } from '../server/database/task';
import { assets } from '../server/database/schemas/album';
import { createThumbStore } from '../server/album/thumb-store';
import { extractMetadata } from '../server/ingest/extractors';
import { computePhash } from '../server/ingest/phash';
import { groupSimilar, hammingDistance } from '../server/ingest/similarity';
import { ensureSimilarityIndex, readSimilarityIndexMeta } from '../server/ingest/similarity-index';
import { isImporting, startImport } from '../server/ingest/ingest-service';
import { parseSettings } from '../server/settings/setting-schema';
import { resetSettingsCache } from '../server/settings/setting-store';

const tempDirs: string[] = [];

function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'picturex-ingest-'));

    tempDirs.push(dir);

    return dir;
}

async function makeImage(path: string, color: { r: number, g: number, b: number }): Promise<void> {
    await sharp({
        create: { width: 64, height: 48, channels: 3, background: color },
    }).jpeg({ quality: 90 }).toFile(path);
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timeout');
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

afterEach(() => {
    closeAllAlbumDatabases();
    closeTaskDatabase();
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
        catch {
            // Windows 句柄释放延迟
        }
    }

    resetSettingsCache();
});

describe('pHash', () => {
    it('keeps similar images close and separates different ones', async () => {
        const root = tempRoot();
        const basePath = join(root, 'base.jpg');
        const similarPath = join(root, 'similar.jpg');
        const differentPath = join(root, 'different.jpg');

        await makeImage(basePath, { r: 120, g: 130, b: 140 });
        await makeImage(similarPath, { r: 122, g: 132, b: 142 });

        const checker = Buffer.alloc(64 * 48 * 3);

        for (let y = 0; y < 48; y += 1) {
            for (let x = 0; x < 64; x += 1) {
                const value = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 0;
                const offset = (y * 64 + x) * 3;

                checker[offset] = value;
                checker[offset + 1] = value;
                checker[offset + 2] = value;
            }
        }

        await sharp(checker, { raw: { width: 64, height: 48, channels: 3 } }).jpeg().toFile(differentPath);

        const base = await computePhash(basePath);
        const similar = await computePhash(similarPath);
        const different = await computePhash(differentPath);

        expect(base).toMatch(/^[0-9a-f]{16}$/u);
        expect(similar).toMatch(/^[0-9a-f]{16}$/u);
        expect(different).toMatch(/^[0-9a-f]{16}$/u);

        expect(hammingDistance(base ?? '', similar ?? '')).toBeLessThanOrEqual(
            hammingDistance(base ?? '', different ?? ''),
        );
    });

    it('groups by hamming threshold', () => {
        const items = [
            { id: 'a', phash: '0000000000000000' },
            { id: 'b', phash: '0000000000000003' },
            { id: 'c', phash: 'ffffffffffffffff' },
        ];
        const groups = groupSimilar(items, 4);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.items.map(item => item.id)).toEqual(['a', 'b']);
    });
});

describe('metadata extraction', () => {
    it('reads image dimensions and SVG size', async () => {
        const root = tempRoot();
        const jpeg = join(root, 'photo.jpg');
        const svg = join(root, 'vector.svg');

        await makeImage(jpeg, { r: 10, g: 20, b: 30 });
        writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#ccc"/></svg>');

        const settings = parseSettings({});
        const image = await extractMetadata(jpeg, settings);
        const vector = await extractMetadata(svg, settings);

        expect(image?.mime).toBe('image/jpeg');
        expect(image?.kind).toBe('image');
        expect(image?.width).toBe(64);
        expect(image?.height).toBe(48);
        expect(vector?.kind).toBe('svg');
        expect(vector?.width).toBe(120);
        expect(vector?.height).toBe(90);
    });

    it('returns null for unsupported files', async () => {
        const root = tempRoot();
        const text = join(root, 'note.txt');

        writeFileSync(text, 'hello');

        expect(await extractMetadata(text, parseSettings({}))).toBeNull();
    });
});

describe('ingest pipeline', () => {
    it('imports, deduplicates by sha256, stores files and warms small thumbnails in the background', async () => {
        const root = tempRoot();
        const source = join(root, 'source');
        const dataDir = tempRoot();

        process.env.NUXT_DATA_DIR = dataDir;
        resetSettingsCache();

        mkdirSync(source, { recursive: true });

        await makeImage(join(source, 'one.jpg'), { r: 200, g: 40, b: 40 });
        await makeImage(join(source, 'two.jpg'), { r: 40, g: 200, b: 40 });
        copyFileSync(join(source, 'one.jpg'), join(source, 'one-copy.jpg'));
        writeFileSync(join(source, 'notes.txt'), 'ignore me');

        const settings = parseSettings({ albumsRoot: join(dataDir, 'albums'), modelsRoot: join(dataDir, 'models') });
        const album = createAlbum(settings, { name: 'Ingest' });
        const context = getAlbum(settings, album.id);
        const job = await startImport(album.id, { rootPath: source });

        await waitFor(() => {
            const status = getImportJob(album.id, job.id).status;

            return status === 'completed' || status === 'failed';
        });

        const finished = getImportJob(album.id, job.id);

        expect(finished.status).toBe('completed');
        expect(finished.total).toBe(3);
        expect(finished.added).toBe(2);
        expect(finished.duplicates).toBe(1);
        expect(isImporting(album.id)).toBe(false);

        const rows = context.db.album.select().from(assets).all();

        expect(rows).toHaveLength(2);
        expect(rows.every(row => row.storageKey.startsWith('storage/0001/'))).toBe(true);
        expect(rows.every(row => row.sha256.length === 64)).toBe(true);

        // 导入只做原样复制 + 改名：存储副本必须与导入源文件逐字节一致，之后任何流程都不得改写
        for (const row of rows) {
            const stored = readFileSync(join(context.dir, row.storageKey));
            const sourceBytes = readFileSync(join(source, row.filename));

            expect(stored.equals(sourceBytes)).toBe(true);
        }

        // 导入完成后低优先级预热最小配置尺寸，不阻塞导入主流程
        const thumbStore = createThumbStore(context.db.thumbnails, 1024, album.id);

        await waitFor(() => thumbStore.count() === 2);

        const warmed = thumbStore.sizeBreakdown();

        expect(warmed.reduce((sum, usage) => sum + usage.count, 0)).toBe(2);
        expect(warmed.every(usage => usage.size > 0)).toBe(true);

        await ensureSimilarityIndex(album.id, 8);

        const hashed = context.db.album.select().from(assets).all();
        const meta = readSimilarityIndexMeta(context.db.album);

        expect(hashed.every(row => row.phash?.length === 16)).toBe(true);
        expect(meta?.threshold).toBe(8);
        expect(meta?.phashedCount).toBe(2);
    }, 40_000);

    it('imports a large file with a single read and still deduplicates it', async () => {
        const root = tempRoot();
        const source = join(root, 'source');
        const dataDir = tempRoot();

        process.env.NUXT_DATA_DIR = dataDir;
        resetSettingsCache();

        mkdirSync(source, { recursive: true });

        // >8 MiB 的有效 PNG（尾部填充）：走「边复制边算哈希」路径，只读一次源文件
        const base = await sharp({
            create: { width: 64, height: 48, channels: 3, background: { r: 5, g: 6, b: 7 } },
        }).png().toBuffer();
        const padded = Buffer.concat([base, Buffer.alloc(9 * 1024 * 1024, 0x2a)]);

        writeFileSync(join(source, 'big.png'), padded);
        copyFileSync(join(source, 'big.png'), join(source, 'big-copy.png'));

        const settings = parseSettings({ albumsRoot: join(dataDir, 'albums'), modelsRoot: join(dataDir, 'models') });
        const album = createAlbum(settings, { name: 'Large files' });
        const context = getAlbum(settings, album.id);
        const job = await startImport(album.id, { rootPath: source });

        await waitFor(() => {
            const status = getImportJob(album.id, job.id).status;

            return status === 'completed' || status === 'failed';
        });

        const finished = getImportJob(album.id, job.id);

        expect(finished.status).toBe('completed');
        expect(finished.added).toBe(1);
        expect(finished.duplicates).toBe(1);

        const rows = context.db.album.select().from(assets).all();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.sha256).toBe(createHash('sha256').update(padded).digest('hex'));
        expect(readFileSync(join(context.dir, rows[0]?.storageKey ?? '')).equals(padded)).toBe(true);

        // 重复文件不能留下孤儿副本：storage/0001 下只有真正入库的那一份
        expect(readdirSync(join(context.dir, 'storage', '0001'))).toHaveLength(1);
    }, 40_000);
});
