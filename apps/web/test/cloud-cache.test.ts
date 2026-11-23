import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeCloudDatabase, cloudDatabase } from '../server/database/cloud';
import {
    pruneCloudPixivImageCache,
    readCloudPixivImage,
    writeCloudPixivImage,
} from '../server/pixiv/cloud-cache';
import { describeDataDirectories } from '../server/utils/data-dir';

let dataDir: string;

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-cloud-'));
    process.env.NUXT_DATA_DIR = dataDir;
});

afterAll(() => {
    closeCloudDatabase();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('cloud pixiv originals', () => {
    it('stores and updates original bytes in data/cloud.db.pixiv_locals', () => {
        writeCloudPixivImage('111111', 0, 'image/jpeg', Buffer.from('first'));

        const first = readCloudPixivImage('111111', 0);

        expect(first?.mime).toBe('image/jpeg');
        expect(first?.blob.toString()).toBe('first');
        expect(first?.sizeBytes).toBe(5);
        expect(existsSync(describeDataDirectories().cloudDbPath)).toBe(true);

        writeCloudPixivImage('111111', 0, 'image/png', Buffer.from('second'));

        const second = readCloudPixivImage('111111', 0);

        expect(second?.mime).toBe('image/png');
        expect(second?.blob.toString()).toBe('second');
        expect(readCloudPixivImage('111111', 1)).toBeNull();
    });

    it('evicts the oldest originals once the cache exceeds its cap', () => {
        for (const id of ['201', '202', '203']) {
            writeCloudPixivImage(id, 0, 'image/jpeg', Buffer.alloc(10, Number(id)));
        }

        const removed = pruneCloudPixivImageCache(12);

        expect(removed).toBeGreaterThan(0);

        const totals = cloudDatabase().$client
            .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total FROM pixiv_locals')
            .get() as { count: number, total: number };

        expect(totals.total).toBeLessThanOrEqual(12);
        // 按 last_accessed_at 从旧到新淘汰：最后写入的条目仍然在
        expect(readCloudPixivImage('203', 0)?.sizeBytes).toBe(10);
        expect(readCloudPixivImage('201', 0)).toBeNull();
    });
});
