import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAlbum, getAlbum } from '../server/album/album-store';
import { closeAllAlbumDatabases } from '../server/database/album';
import { assetTags, assets } from '../server/database/schemas/album';
import { linkTagsBatch, renameAssetsBatch } from '../server/domain/asset-query';
import { getSettings, resetSettingsCache } from '../server/settings/setting-store';
import type { AlbumContext } from '../server/album/album-store';

let dataDir: string;

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-bulk-ops-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();
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

function shaFor(id: string): string {
    return createHash('sha256').update(id).digest('hex');
}

function seedAsset(context: AlbumContext, id: string, filename: string, ext: string): void {
    context.db.album.insert(assets).values({
        id,
        storageKey: `storage/0001/${id}.${ext}`,
        filename,
        ext,
        mime: ext === 'png' ? 'image/png' : 'image/jpeg',
        kind: 'image',
        size: 100,
        width: 100,
        height: 100,
        sha256: shaFor(id),
        takenAt: null,
        addedAt: 1_767_225_600 + Number(id.slice(-1)),
        deletedAt: null,
        meta: '{}',
    }).run();
}

function freshAlbum(name: string, ids: { id: string, filename: string, ext: string }[]): AlbumContext {
    const settings = getSettings();
    const album = createAlbum(settings, { name });
    const context = getAlbum(settings, album.id);

    for (const entry of ids) {
        seedAsset(context, entry.id, entry.filename, entry.ext);
    }

    return context;
}

describe('linkTagsBatch (bulk insert)', () => {
    it('links every combination once and counts new rows correctly', () => {
        const context = freshAlbum('Bulk Link', [
            { id: 'a1', filename: 'a1.jpg', ext: 'jpg' },
            { id: 'a2', filename: 'a2.jpg', ext: 'jpg' },
        ]);

        const linked = linkTagsBatch(context.db.album, ['a1', 'a2', 'a1'], ['t1', 't2']);

        // 去重后 2 资产 × 2 标签 = 4 条
        expect(linked).toBe(4);

        const rows = context.db.album.select().from(assetTags).all();

        expect(rows).toHaveLength(4);

        // 再次关联同一组合全部冲突跳过 → 0 新增
        expect(linkTagsBatch(context.db.album, ['a1', 'a2'], ['t1', 't2'])).toBe(0);
    });
});

describe('renameAssetsBatch (in-memory result, atomic validation)', () => {
    it('returns summaries matching persisted rows without re-reading per asset', () => {
        const context = freshAlbum('Bulk Rename', [
            { id: 'r1', filename: 'one.jpg', ext: 'jpg' },
            { id: 'r2', filename: 'two.png', ext: 'png' },
        ]);

        const result = renameAssetsBatch(context.db.album, { ids: ['r1', 'r2'], prefix: 'IMG_', start: 1, padding: 3 });

        expect(result.map(item => item.filename)).toEqual(['IMG_001.jpg', 'IMG_002.png']);

        const persisted = context.db.album
            .select({ id: assets.id, filename: assets.filename })
            .from(assets)
            .all()
            .sort((a, b) => a.id.localeCompare(b.id));

        expect(persisted.map(row => row.filename)).toEqual(['IMG_001.jpg', 'IMG_002.png']);
    });

    it('validates every name before writing, so an illegal name changes nothing', () => {
        const context = freshAlbum('Rename Abort', [
            { id: 'b1', filename: 'first.jpg', ext: 'jpg' },
            { id: 'b2', filename: 'second.jpg', ext: 'jpg' },
        ]);

        // 前缀含非法字符：normalizeFilename 在事务外就抛 422，一行都不该被改
        expect(() => renameAssetsBatch(context.db.album, { ids: ['b1', 'b2'], prefix: 'a/b', start: 1, padding: 2 }))
            .toThrow();

        const filenames = context.db.album
            .select({ filename: assets.filename })
            .from(assets)
            .all()
            .map(row => row.filename)
            .sort();

        expect(filenames).toEqual(['first.jpg', 'second.jpg']);
    });
});
