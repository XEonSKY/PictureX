import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assets } from '../server/database/schemas/album';
import { closeAllAlbumDatabases } from '../server/database/album';

// 用一个「删文件必抛错」的假存储适配器替换真实后端：
// 只要 purgeTrash 先删库行、后删文件，行就必须照样消失，
// 反过来（旧实现）文件抛错会被吞掉、行留在回收站变成僵尸记录。
const deleteCalls: string[] = [];

vi.mock('../server/storage/registry', () => ({
    storageForAlbum: () => ({
        delete: async (key: string) => {
            deleteCalls.push(key);

            throw new Error('simulated disk failure');
        },
    }),
}));

let dataDir: string;

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-purge-order-'));
    process.env.NUXT_DATA_DIR = dataDir;
});

afterAll(() => {
    closeAllAlbumDatabases();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('permanent delete ordering (row first, file after)', () => {
    it('removes the database row even when the storage file cannot be deleted', async () => {
        const { createAlbum, getAlbum } = await import('../server/album/album-store');
        const { getSettings, resetSettingsCache } = await import('../server/settings/setting-store');
        const { purgeTrash } = await import('../server/domain/asset-query');

        resetSettingsCache();
        const settings = getSettings();
        const album = createAlbum(settings, { name: 'Purge Order' });

        const context = getAlbum(settings, album.id);

        context.db.album.insert(assets).values({
            id: 'trashed-1',
            storageKey: 'storage/0001/trashed-1.jpg',
            filename: 'trashed-1.jpg',
            ext: 'jpg',
            mime: 'image/jpeg',
            kind: 'image',
            size: 10,
            width: 10,
            height: 10,
            sha256: 'a'.repeat(64),
            takenAt: null,
            addedAt: 1_767_225_600,
            deletedAt: 1_767_312_000,
            meta: '{}',
        }).run();

        const result = await purgeTrash(settings, album.id);

        // 文件删除抛错，但行必须已被删除：removed 计数含该资产，failed 只统计删行失败
        expect(deleteCalls).toContain('storage/0001/trashed-1.jpg');
        expect(result.removed).toBe(1);
        expect(result.failed).toBe(0);

        const remaining = context.db.album.select().from(assets).all();

        expect(remaining).toHaveLength(0);
    });
});
