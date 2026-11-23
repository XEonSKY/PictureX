import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryAlbumDatabase, type ThumbnailDatabase } from '../server/database/album';
import { createThumbStore } from '../server/album/thumb-store';

const databases: ThumbnailDatabase[] = [];

function createStore(maxMb: number) {
    const { thumbnails } = createInMemoryAlbumDatabase();

    databases.push(thumbnails);

    return createThumbStore(thumbnails, maxMb, 'test-album');
}

function blob(bytes: number): Buffer {
    return Buffer.alloc(bytes, 1);
}

afterEach(() => {
    for (const database of databases.splice(0)) {
        database.$client.close();
    }
});

describe('thumbnail store', () => {
    it('tracks the total size incrementally on insert, update and delete', () => {
        const store = createStore(1024);

        store.put({ assetId: 'a', size: 256, mime: 'image/webp', blob: blob(100), width: 10, height: 10 });
        store.put({ assetId: 'a', size: 512, mime: 'image/webp', blob: blob(200), width: 10, height: 10 });

        expect(store.totalBytes()).toBe(300);

        // 覆盖写只增加差值
        store.put({ assetId: 'a', size: 512, mime: 'image/webp', blob: blob(50), width: 10, height: 10 });

        expect(store.totalBytes()).toBe(150);

        store.deleteAsset('a');

        expect(store.totalBytes()).toBe(0);
    });

    it('evicts the least recently used rows down to the target ratio', () => {
        const store = createStore(1);

        for (let index = 0; index < 8; index += 1) {
            store.put({
                assetId: `asset-${index}`,
                size: 256,
                mime: 'image/webp',
                blob: blob(100 * 1024),
                width: 10,
                height: 10,
            });
        }

        expect(store.totalBytes()).toBe(8 * 100 * 1024);

        const removed = store.sweep(0.5);

        expect(removed).toBeGreaterThan(0);
        expect(store.totalBytes()).toBeLessThanOrEqual(512 * 1024);
        expect(store.count()).toBeLessThan(8);
    });

    it('vacuums free pages and reports compacted file size', () => {
        const store = createStore(64);

        for (let index = 0; index < 100; index += 1) {
            store.put({
                assetId: `asset-${index}`,
                size: 256,
                mime: 'image/webp',
                blob: blob(200 * 1024),
                width: 10,
                height: 10,
            });
        }

        for (let index = 0; index < 90; index += 1) {
            store.deleteAsset(`asset-${index}`);
        }

        const statsBefore = store.stats();
        const result = store.optimize();
        const statsAfter = store.stats();

        expect(result.vacuumed).toBe(true);
        expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
        expect(statsAfter.count).toBe(10);
        expect(statsAfter.fileBytes).toBeLessThan(statsBefore.fileBytes);
        expect(store.totalBytes()).toBe(10 * 200 * 1024);
    });

    it('falls back to the closest size when the requested size is missing', () => {
        const store = createStore(1024);

        store.put({ assetId: 'a', size: 256, mime: 'image/webp', blob: blob(10), width: 10, height: 10 });

        expect(store.getClosest('a', 512)?.size).toBe(256);
        expect(store.getClosest('a', 128)?.size).toBe(256);
        expect(store.getClosest('a', 256)?.size).toBe(256);
        expect(store.getClosest('missing', 256)).toBeNull();
    });

    it('clears every cached thumbnail and failure mark', () => {
        const store = createStore(1024);

        store.put({ assetId: 'a', size: 256, mime: 'image/webp', blob: blob(100), width: 10, height: 10 });
        store.put({ assetId: 'b', size: 512, mime: 'image/webp', blob: blob(200), width: 10, height: 10 });
        store.markFailure('c', '256:80');

        const result = store.clear();

        expect(result.removed).toBe(2);
        expect(store.count()).toBe(0);
        expect(store.totalBytes()).toBe(0);
        expect(store.hasFailure('c', '256:80')).toBe(false);
    });
});
