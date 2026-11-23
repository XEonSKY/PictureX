import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAllAlbumDatabases } from '../server/database/album';
import { closeGlobalDatabase } from '../server/database/global';
import {
    closePixivDatabase,
    ensureGlobalPixivIllustPlaceholder,
} from '../server/database/pixiv';
import { markGlobalPixivIllustInvalid, writeGlobalPixivIllust } from '../server/pixiv/global-cache';
import {
    getPixivLibraryDetail,
    getPixivLibraryStats,
    listPixivLibrary,
    listPixivLibraryTags,
    listPixivLibraryUsers,
    resolvePixivLibraryImage,
} from '../server/pixiv/library';
import type { PixivIllust } from '../server/pixiv/types';
import { resetSettingsCache } from '../server/settings/setting-store';

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-pixiv-library-'));
    process.env.NUXT_DATA_DIR = dataDir;
    resetSettingsCache();
});

afterEach(() => {
    closeAllAlbumDatabases();
    closeGlobalDatabase();
    closePixivDatabase();
    resetSettingsCache();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

function fakeIllust(illustId: string, overrides: Partial<PixivIllust> = {}): PixivIllust {
    return {
        illustId,
        title: `Title ${illustId}`,
        type: 'illust',
        caption: '',
        userId: '42',
        userName: 'Artist',
        userAccount: 'artist',
        pageCount: 2,
        width: 1000,
        height: 1500,
        xRestrict: 0,
        sanityLevel: 0,
        illustAiType: 1,
        createDate: '2026-01-02T03:04:05.000Z',
        totalView: 100,
        totalBookmarks: 10,
        tags: [
            { name: 'landscape', translatedName: '风景' },
            { name: 'original', translatedName: null },
        ],
        pages: [
            {
                index: 0,
                urls: {
                    squareMedium: 'https://i.pximg.net/c/360x360/square.jpg',
                    medium: 'https://i.pximg.net/c/540x540/medium.jpg',
                    large: 'https://i.pximg.net/img/large.jpg',
                    original: 'https://i.pximg.net/img/original.jpg',
                },
            },
            {
                index: 1,
                urls: {
                    squareMedium: 'https://i.pximg.net/c/360x360/square-1.jpg',
                    medium: 'https://i.pximg.net/c/540x540/medium-1.jpg',
                    large: 'https://i.pximg.net/img/large-1.jpg',
                    original: 'https://i.pximg.net/img/original-1.jpg',
                },
            },
        ],
        ugoira: null,
        ...overrides,
    };
}

describe('pixiv library queries', () => {
    it('lists, filters and searches works read from the global database', () => {
        writeGlobalPixivIllust(fakeIllust('111111'), 1_800_000_000);
        writeGlobalPixivIllust(fakeIllust('222222', {
            title: 'Blue sky',
            type: 'ugoira',
            createDate: '2025-01-01T00:00:00.000Z',
            totalBookmarks: 50,
            tags: [{ name: 'sky', translatedName: null }],
        }), 1_800_000_100);
        ensureGlobalPixivIllustPlaceholder('333333');

        const stats = getPixivLibraryStats();

        expect(stats.total).toBe(3);
        expect(stats.fetched).toBe(2);
        expect(stats.placeholder).toBe(1);
        expect(stats.ugoira).toBe(1);
        expect(stats.users).toBe(1);
        expect(stats.tags).toBe(3);

        const all = listPixivLibrary({ status: 'all', sort: 'recent', limit: 10 });

        expect(all.total).toBe(3);
        expect(all.data.map(item => item.illustId)).toEqual(['111111', '222222', '333333']);
        expect(all.data[0].coverUrl).toContain('illustId=111111');
        expect(all.data[2].placeholder).toBe(true);

        const pending = listPixivLibrary({ status: 'placeholder', sort: 'recent', limit: 10 });

        expect(pending.data.map(item => item.illustId)).toEqual(['333333']);

        const search = listPixivLibrary({
            q: 'Artist',
            status: 'all',
            sort: 'recent',
            limit: 10,
        });

        expect(search.data).toHaveLength(2);

        const tagged = listPixivLibrary({
            q: '风景',
            status: 'all',
            sort: 'recent',
            limit: 10,
        });

        expect(tagged.data.map(item => item.illustId)).toEqual(['111111']);

        const bookmarks = listPixivLibrary({ status: 'all', sort: 'bookmarks', limit: 10 });

        expect(bookmarks.data[0].illustId).toBe('222222');
    });

    it('paginates with keyset cursors', () => {
        writeGlobalPixivIllust(fakeIllust('111111'), 1_800_000_000);
        writeGlobalPixivIllust(fakeIllust('222222'), 1_800_000_100);
        writeGlobalPixivIllust(fakeIllust('333333'), 1_800_000_200);

        const first = listPixivLibrary({ status: 'all', sort: 'id', limit: 2 });

        expect(first.data).toHaveLength(2);
        expect(first.pagination.hasMore).toBe(true);
        expect(first.pagination.nextCursor).toBeTruthy();

        const second = listPixivLibrary({
            status: 'all',
            sort: 'id',
            limit: 2,
            cursor: first.pagination.nextCursor ?? undefined,
        });

        expect(second.data).toHaveLength(1);
        expect(second.pagination.hasMore).toBe(false);
        expect([...first.data, ...second.data].map(item => item.illustId).sort())
            .toEqual(['111111', '222222', '333333']);

        const tags = listPixivLibraryTags(10);
        const users = listPixivLibraryUsers(10);

        expect(tags.length).toBeGreaterThan(0);
        expect(users[0]?.userId).toBe('42');
    });

    it('records unavailable works and excludes them from pending states', () => {
        writeGlobalPixivIllust(fakeIllust('111111'), 1_800_000_000);
        ensureGlobalPixivIllustPlaceholder('333333');
        markGlobalPixivIllustInvalid('111111', 1_800_000_500);
        markGlobalPixivIllustInvalid('333333', 1_800_000_600);

        const stats = getPixivLibraryStats();

        expect(stats.total).toBe(2);
        expect(stats.fetched).toBe(0);
        expect(stats.placeholder).toBe(0);
        expect(stats.invalid).toBe(2);

        const invalid = listPixivLibrary({ status: 'invalid', sort: 'recent', limit: 10 });

        expect(invalid.data.map(item => item.illustId).sort()).toEqual(['111111', '333333']);
        expect(invalid.data.every(item => item.invalid)).toBe(true);

        expect(listPixivLibrary({ status: 'fetched', sort: 'recent', limit: 10 }).data).toEqual([]);
        expect(listPixivLibrary({ status: 'placeholder', sort: 'recent', limit: 10 }).data).toEqual([]);

        // 已缓存详情的失效作品仍可浏览元数据，只是不再参与自动同步
        const detail = getPixivLibraryDetail('111111');

        expect(detail?.invalid).toBe(true);
        expect(detail?.illust?.title).toBe('Title 111111');

        const pendingDetail = getPixivLibraryDetail('333333');

        expect(pendingDetail?.invalid).toBe(true);
        expect(pendingDetail?.placeholder).toBe(true);
        expect(pendingDetail?.illust).toBeNull();
    });

    it('returns details and resolves images only from stored pages', () => {
        writeGlobalPixivIllust(fakeIllust('111111'), 1_800_000_000);
        ensureGlobalPixivIllustPlaceholder('333333');

        const detail = getPixivLibraryDetail('111111');

        expect(detail?.placeholder).toBe(false);
        expect(detail?.illust?.title).toBe('Title 111111');
        expect(detail?.locals).toEqual([]);
        expect(detail?.fetchedAt).toBe(new Date(1_800_000_000_000).toISOString());

        const placeholder = getPixivLibraryDetail('333333');

        expect(placeholder?.placeholder).toBe(true);
        expect(placeholder?.illust).toBeNull();

        expect(resolvePixivLibraryImage('111111', 1, 'large'))
            .toBe('https://i.pximg.net/img/large-1.jpg');
        expect(resolvePixivLibraryImage('333333', 0, 'medium')).toBeNull();
        expect(getPixivLibraryDetail('999999')).toBeNull();
    });
});
