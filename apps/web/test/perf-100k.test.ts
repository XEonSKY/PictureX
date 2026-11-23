import { describe, expect, it } from 'vitest';
import { createInMemoryAlbumDatabase } from '../server/database/album';
import { assetNeighbors, encodeCursor, listAssets } from '../server/domain/asset-query';
import { groupSimilar } from '../server/ingest/similarity';

/**
 * 10 万级合成基准（真实查询函数 + 真实 DDL/索引/FTS 触发器）。
 * 默认跳过，手动执行：
 *   PX_PERF_100K=1 pnpm --dir apps/web exec vitest run test/perf-100k.test.ts
 */

const TOTAL = Number(process.env.PX_PERF_TOTAL ?? 100_000);
const enabled = process.env.PX_PERF_100K === '1';

function idFor(index: number): string {
    return `${index.toString(16).padStart(12, '0')}-0000-7000-8000-000000000000`;
}

function hex(value: number, length: number): string {
    let text = '';

    while (text.length < length) {
        text += ((value * 2654435761 + text.length * 40503) >>> 0).toString(16).padStart(8, '0');
    }

    return text.slice(0, length);
}

function seed(): ReturnType<typeof createInMemoryAlbumDatabase> {
    const handle = createInMemoryAlbumDatabase();
    const client = handle.album.$client;
    const insert = client.prepare(`
        INSERT INTO assets (
            id, storage_key, filename, ext, mime, kind, size, width, height,
            duration_ms, sha256, phash, taken_at, added_at, deleted_at, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    const base = Math.floor(Date.parse('2026-10-25T00:00:00.000Z') / 1000);

    // 批量造数时先摘掉 FTS 逐行触发器，最后一次性重建，避免把 seed 时间算进查询基准
    const triggers = client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'assets_fts_%'")
        .all() as { name: string }[];

    for (const trigger of triggers) {
        client.exec(`DROP TRIGGER IF EXISTS "${trigger.name.replace(/"/gu, '""')}"`);
    }

    client.transaction(() => {
        for (let index = 0; index < TOTAL; index += 1) {
            const beach = index % 7 === 0;
            const addedAt = base - index * 60;
            const takenAt = index % 2 === 0 ? base - index * 86_400 : null;

            insert.run(
                idFor(index),
                `storage/${String(Math.floor(index / 8192) + 1).padStart(4, '0')}/${idFor(index)}.jpg`,
                `${beach ? 'beach' : 'photo'}-${index}.jpg`,
                'jpg',
                'image/jpeg',
                'image',
                200_000 + index,
                1920,
                1080,
                null,
                hex(index + 1, 64),
                hex(index + 99, 16),
                takenAt,
                addedAt,
                JSON.stringify(index % 10 === 0 ? { ai: { caption: `beach scene ${index}` } } : {}),
            );
        }
    })();

    const rebuildStarted = performance.now();

    client.exec(`
        DELETE FROM assets_fts;
        INSERT INTO assets_fts(asset_id, filename, caption)
        SELECT id, filename, coalesce(json_extract(meta, '$.ai.caption'), '') FROM assets
    `);
    console.log('[perf-100k] FTS rebuild', Math.round(performance.now() - rebuildStarted), 'ms');

    return handle;
}

describe.skipIf(!enabled)('100k synthetic benchmark', () => {
    it('measures list, FTS, deep pagination and pHash grouping', () => {
        const seedStarted = performance.now();
        const handle = seed();
        const seedMs = Math.round(performance.now() - seedStarted);
        const db = handle.album;
        const timings: Record<string, number> = { seed: seedMs };

        console.log('[perf-100k] seeded', TOTAL, 'assets in', seedMs, 'ms');

        const measure = <T>(name: string, run: () => T): T => {
            const started = performance.now();
            const value = run();

            timings[name] = Math.round(performance.now() - started);
            console.log('[perf-100k]', name, timings[name], 'ms');

            return value;
        };

        const firstPage = measure('listFirstPage', () => listAssets(db, {
            limit: 60,
            sort: 'addedAt',
            order: 'desc',
        }));
        const deepRow = db.$client
            .prepare('SELECT id, added_at FROM assets ORDER BY added_at DESC, id DESC LIMIT 1 OFFSET ?')
            .get(Math.floor(TOTAL * 0.9)) as { id: string, added_at: string };
        const deepCursor = encodeCursor(deepRow.added_at, deepRow.id);
        const deepPage = measure('listDeepPage', () => listAssets(db, {
            limit: 60,
            cursor: deepCursor,
            sort: 'addedAt',
            order: 'desc',
        }));
        const search = measure('ftsSearch', () => listAssets(db, {
            limit: 60,
            sort: 'addedAt',
            order: 'desc',
            q: 'beach',
        }));
        const neighbors = measure('neighbors', () => assetNeighbors(db, idFor(Math.floor(TOTAL / 2))));
        const phashes = measure('loadPhashes', () => db.$client
            .prepare('SELECT id, phash FROM assets WHERE length(phash) = 16')
            .all() as { id: string, phash: string }[]);
        const groups = measure('groupSimilar100k', () => groupSimilar(phashes, 8));
        const count = (db.$client.prepare('SELECT count(*) AS total FROM assets').get() as { total: number }).total;

        console.log('[perf-100k]', JSON.stringify({
            assets: count,
            firstPage: firstPage.data.length,
            deepPage: deepPage.data.length,
            searchHits: search.data.length,
            neighborIndex: neighbors.index,
            phashes: phashes.length,
            groups: groups.length,
            timings,
        }));

        expect(count).toBe(TOTAL);
        expect(firstPage.data).toHaveLength(60);
        expect(deepPage.data).toHaveLength(60);
        expect(search.data.length).toBeGreaterThan(0);
        expect(neighbors.total).toBe(TOTAL);

        // 阈值防线：keyset 深翻页、邻居单次聚合扫描、FTS 检索都必须在 10 万级下守住上限，
        // 否则退化会在这里失败（阈值留足 CI 共享 runner 的余量，只拦数量级的劣化）
        const budget = {
            listFirstPage: 500,
            listDeepPage: 1500,
            ftsSearch: 5000,
            neighbors: 5000,
            // 10 万条 pHash 两两分组是 O(n²) 主项，机器差异最大，留足共享 runner 余量只拦数量级劣化
            groupSimilar100k: 180_000,
        };

        for (const [name, limitMs] of Object.entries(budget)) {
            expect(timings[name], `${name}=${timings[name]}ms 超出预算 ${limitMs}ms`).toBeLessThanOrEqual(limitMs);
        }

        handle.album.$client.close();
        handle.thumbnails.$client.close();
    }, 420_000);
});
