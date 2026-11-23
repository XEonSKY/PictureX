import { existsSync } from 'node:fs';
import { listAlbumSummaries } from '../album/album-store';
import { leaseAlbumDatabase } from '../database/album';
import { logger } from '../logger';
import { getSettings } from '../settings/setting-store';
import { albumPictureDbPath } from '../utils/data-dir';

/**
 * 在已登记相册里查找某个 Pixiv 分P的本地资产。
 * 相册库按需打开并持租约；命中/未命中都做短缓存，避免资料库每张封面都扫一遍所有相册。
 */

export interface LocalPixivPage {
    albumId: string
    assetId: string
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: LocalPixivPage | null, at: number }>();

function cacheKey(illustId: string, pageIndex: number): string {
    return `${illustId}:${pageIndex}`;
}

export function findLocalPixivPage(illustId: string, pageIndex: number): LocalPixivPage | null {
    const key = cacheKey(illustId, pageIndex);
    const cached = cache.get(key);

    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
    }

    const settings = getSettings();
    let lookupFailed = false;

    for (const album of listAlbumSummaries(settings)) {
        if (album.missing || album.corrupt || !existsSync(albumPictureDbPath(album.dir))) {
            continue;
        }

        let lease: ReturnType<typeof leaseAlbumDatabase>;

        try {
            lease = leaseAlbumDatabase(album.dir);
        }
        catch {
            continue;
        }

        try {
            const row = lease.handle.album.$client.prepare(`
                SELECT l.asset_id
                FROM pixiv_asset_links l
                JOIN assets a ON a.id = l.asset_id
                WHERE l.illust_id = ? AND l.page_index = ? AND a.deleted_at IS NULL
                LIMIT 1
            `).get(illustId, pageIndex) as { asset_id?: string } | undefined;

            if (row?.asset_id) {
                const value = { albumId: album.id, assetId: row.asset_id };

                cache.set(key, { value, at: Date.now() });

                return value;
            }
        }
        catch (error) {
            lookupFailed = true;
            logger.debug({ err: error, albumId: album.id, illustId, pageIndex }, 'local pixiv page lookup failed');
        }
        finally {
            lease.release();
        }
    }

    // 某个相册库打开/查询失败时不能把“没找到”缓存下来，否则本地图片会被误判为缺失
    if (!lookupFailed) {
        cache.set(key, { value: null, at: Date.now() });
    }

    if (cache.size > 512) {
        const now = Date.now();

        for (const [entryKey, entry] of cache) {
            if (now - entry.at > CACHE_TTL_MS) {
                cache.delete(entryKey);
            }
        }
    }

    return null;
}

export function clearLocalPixivPageCache(): void {
    cache.clear();
}
