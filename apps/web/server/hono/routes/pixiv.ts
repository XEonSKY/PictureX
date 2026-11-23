import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import { testPixivConnection } from '../../pixiv/api';
import {
    getPixivAutoFetchStatus,
    pausePixivAutoFetch,
    resumePixivAutoFetch,
    triggerPixivAutoFetch,
} from '../../pixiv/auto-fetch';
import {
    loginWithRefreshToken,
    logoutPixiv,
    pixivStatus,
} from '../../pixiv/auth';
import {
    getPixivDatabaseStatus,
    syncPixivDatabaseNow,
} from '../../pixiv/database-sync';
import {
    getPixivLibraryDetail,
    getPixivLibraryStats,
    listPixivLibrary,
    refreshPixivLibraryIllust,
    resolvePixivLibraryImage,
} from '../../pixiv/library';
import { ensureUgoiraArchive, getAssetPixivContext } from '../../pixiv/sync-service';
import { readCloudPixivImage } from '../../pixiv/cloud-cache';
import { ensureCloudPixivImage } from '../../pixiv/cloud-sync';
import { findLocalPixivPage } from '../../pixiv/local-assets';
import { pixivImageStream } from '../../pixiv/http';
import { getAlbum } from '../../album/album-store';
import { getSettings } from '../../settings/setting-store';
import { ApiError } from '../problem';
import { validateJson, validateQuery } from '../validation';
import type { AppEnv } from '../env';

/**
 * 全局 Pixiv 账号与网络设置（挂载到 /api/v1/pixiv）。
 * 账号只支持 refresh token 登录；相册资产级端点见 albumPixivRoutes。
 */

const tokenBodySchema = z.object({
    refreshToken: z.string().trim().min(1).max(4096),
});

const autoFetchBodySchema = z.object({
    albumId: z.string().min(1).max(64).optional(),
});

const illustIdSchema = z.string().regex(/^\d{6,}$/u);

const libraryQuerySchema = z.object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(['all', 'fetched', 'placeholder', 'invalid']).default('all'),
    type: z.string().trim().max(32).optional(),
    userId: z.string().trim().max(64).optional(),
    tagId: z.string().regex(/^\d+$/u).optional(),
    sort: z.enum(['recent', 'bookmarks', 'views', 'updated', 'id']).default('recent'),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(60),
});

const libraryImageQuerySchema = z.object({
    illustId: illustIdSchema,
    page: z.coerce.number().int().min(0).max(999).default(0),
    variant: z.enum(['square', 'medium', 'large', 'original']).default('medium'),
});

export const pixivRoutes = new Hono<AppEnv>()
    .get('/library/stats', c => c.json({ data: getPixivLibraryStats() }))
    .get('/library/image', validateQuery(libraryImageQuerySchema), async (c) => {
        const query = c.req.valid('query');
        const { illustId, page, variant } = query;

        // 1) 本地相册优先：直接复用资产原图/缩略图，完全不联网
        const local = findLocalPixivPage(illustId, page);

        if (local) {
            const base = `/api/v1/albums/${encodeURIComponent(local.albumId)}/assets/${encodeURIComponent(local.assetId)}`;

            if (variant === 'original') {
                return c.redirect(`${base}/file`, 302);
            }

            const size = variant === 'square' ? 256 : variant === 'large' ? 1024 : 512;

            return c.redirect(`${base}/thumbnail?size=${size}`, 302);
        }

        const blobResponse = (image: { mime: string, blob: Buffer }): Response => new Response(new Uint8Array(image.blob), {
            status: 200,
            headers: {
                'content-type': image.mime,
                'content-length': String(image.blob.byteLength),
                'cache-control': 'private, max-age=604800, immutable',
            },
        });

        // 2) 已缓存的云端原图：large/original 直接用；小尺寸仍走轻量代理避免网格拉整张原图
        if (variant === 'large' || variant === 'original') {
            const cached = readCloudPixivImage(illustId, page);

            if (cached) {
                return blobResponse(cached);
            }

            const originalUrl = resolvePixivLibraryImage(illustId, page, 'original');

            if (originalUrl) {
                const downloaded = await ensureCloudPixivImage(illustId, page, originalUrl);

                if (downloaded) {
                    return blobResponse(downloaded);
                }
            }
        }

        // 3) 兜底：按请求尺寸流式代理
        const url = resolvePixivLibraryImage(illustId, page, variant);

        if (!url) {
            throw new ApiError(404, 'pixiv_image_not_found', 'This Pixiv illustration has no image at the requested page.');
        }

        let upstream: Awaited<ReturnType<typeof pixivImageStream>>;

        try {
            upstream = await pixivImageStream(url, {
                timeoutMs: 30_000,
            });
        }
        catch (error) {
            throw new ApiError(
                502,
                'pixiv_api_error',
                error instanceof Error ? error.message : 'Pixiv image request failed.',
            );
        }

        if (upstream.status < 200 || upstream.status >= 300) {
            upstream.stream.destroy();

            throw new ApiError(502, 'pixiv_api_error', `Pixiv image request failed with ${upstream.status}.`);
        }

        const headers: Record<string, string> = {
            'content-type': typeof upstream.headers['content-type'] === 'string'
                ? upstream.headers['content-type']
                : 'image/jpeg',
            'cache-control': 'private, max-age=604800, immutable',
        };
        const length = upstream.headers['content-length'];

        if (typeof length === 'string') {
            headers['content-length'] = length;
        }

        return new Response(Readable.toWeb(upstream.stream) as ReadableStream<Uint8Array>, {
            status: 200,
            headers,
        });
    })
    .get('/library', validateQuery(libraryQuerySchema), (c) => {
        const query = c.req.valid('query');

        return c.json({
            data: listPixivLibrary({
                q: query.q || undefined,
                status: query.status,
                type: query.type || undefined,
                userId: query.userId || undefined,
                tagId: query.tagId || undefined,
                sort: query.sort,
                cursor: query.cursor || undefined,
                limit: query.limit,
            }),
        });
    })
    .get('/library/:illustId', (c) => {
        const parsed = illustIdSchema.safeParse(c.req.param('illustId'));

        if (!parsed.success) {
            throw new ApiError(404, 'pixiv_illust_not_found', 'The Pixiv illustration does not exist.');
        }

        const data = getPixivLibraryDetail(parsed.data);

        if (!data) {
            throw new ApiError(404, 'pixiv_illust_not_found', 'The Pixiv illustration does not exist.');
        }

        return c.json({ data });
    })
    .post('/library/:illustId/refresh', async (c) => {
        const parsed = illustIdSchema.safeParse(c.req.param('illustId'));

        if (!parsed.success) {
            throw new ApiError(404, 'pixiv_illust_not_found', 'The Pixiv illustration does not exist.');
        }

        const data = await refreshPixivLibraryIllust(parsed.data);

        if (!data) {
            throw new ApiError(404, 'pixiv_illust_not_found', 'The Pixiv illustration does not exist.');
        }

        return c.json({ data });
    })
    .get('/auto-fetch', c => c.json({ data: getPixivAutoFetchStatus() }))
    .post('/auto-fetch', validateJson(autoFetchBodySchema), (c) => {
        const data = triggerPixivAutoFetch(c.req.valid('json').albumId);

        return c.json({ data });
    })
    .post('/auto-fetch/pause', (c) => {
        return c.json({ data: pausePixivAutoFetch() });
    })
    .post('/auto-fetch/resume', (c) => {
        return c.json({ data: resumePixivAutoFetch() });
    })
    .get('/database', c => c.json({ data: getPixivDatabaseStatus() }))
    .post('/database/sync', (c) => {
        return c.json({ data: syncPixivDatabaseNow() });
    })
    .get('/status', c => c.json({ data: pixivStatus() }))
    .post('/auth/token', validateJson(tokenBodySchema), async (c) => {
        const data = await loginWithRefreshToken(c.req.valid('json').refreshToken);

        return c.json({ data });
    })
    .delete('/auth', (c) => {
        logoutPixiv();

        return c.body(null, 204);
    })
    .post('/test', async (c) => {
        await testPixivConnection();

        return c.json({ data: { ok: true } });
    });

const contextQuerySchema = z.object({
    refresh: z.enum(['0', '1']).optional(),
});

const syncBodySchema = z.object({
    download: z.boolean().default(true),
});

function ugoiraResponse(path: string, illustId: string): Response {
    const size = statSync(path).size;
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;

    return new Response(stream, {
        status: 200,
        headers: {
            'content-type': 'application/zip',
            'content-length': String(size),
            'content-disposition': `inline; filename="${illustId}_ugoira.zip"`,
            'cache-control': 'private, max-age=3600',
        },
    });
}

export const albumPixivRoutes = new Hono<AppEnv>()
    .get('/:albumId/pixiv/tags', (c) => {
        const context = getAlbum(getSettings(), c.req.param('albumId'));

        if (!context.index.settings.pixivEnabled) {
            return c.json({ data: [] });
        }

        // 优先用附加的 pixiv schema 直接统计本地资产；内存库/附加失败时退回作品数
        const rows = context.db.pixivAttached
            ? context.db.album.$client.prepare(`
                SELECT t.tag_id, t.name, t.translated_name,
                    count(DISTINCT l.asset_id) AS count
                FROM pixiv.tags t
                JOIN pixiv.illust_tags it ON it.tag_id = t.tag_id
                JOIN pixiv_asset_links l ON l.illust_id = it.illust_id
                JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
                GROUP BY t.tag_id, t.name, t.translated_name
                ORDER BY count DESC, t.name ASC
            `).all() as { tag_id: number, name: string, translated_name: string | null, count: number }[]
            : context.db.pixiv.$client.prepare(`
                SELECT t.tag_id, t.name, t.translated_name, count(*) AS count
                FROM tags t
                JOIN illust_tags it ON it.tag_id = t.tag_id
                GROUP BY t.tag_id, t.name, t.translated_name
                ORDER BY count DESC, t.name ASC
            `).all() as { tag_id: number, name: string, translated_name: string | null, count: number }[];

        return c.json({
            data: rows.map(row => ({
                tagId: String(row.tag_id),
                name: row.name,
                translatedName: row.translated_name,
                count: Number(row.count),
            })),
        });
    })
    .get('/:albumId/assets/:assetId/pixiv', validateQuery(contextQuerySchema), async (c) => {
        const data = await getAssetPixivContext(
            getSettings(),
            c.req.param('albumId'),
            c.req.param('assetId'),
            { force: c.req.valid('query').refresh === '1' },
        );

        return c.json({ data });
    })
    .post('/:albumId/assets/:assetId/pixiv/sync', validateJson(syncBodySchema), async (c) => {
        const data = await getAssetPixivContext(
            getSettings(),
            c.req.param('albumId'),
            c.req.param('assetId'),
            { download: c.req.valid('json').download },
        );

        return c.json({ data });
    })
    .get('/:albumId/assets/:assetId/pixiv/ugoira', async (c) => {
        const data = await getAssetPixivContext(
            getSettings(),
            c.req.param('albumId'),
            c.req.param('assetId'),
        );

        if (!data.pixiv) {
            throw new ApiError(404, 'pixiv_ugoira_unavailable', 'This asset is not a Pixiv illustration.');
        }

        const archive = await ensureUgoiraArchive(
            getSettings(),
            c.req.param('albumId'),
            c.req.param('assetId'),
        );

        return ugoiraResponse(archive.path, data.illustId);
    });
