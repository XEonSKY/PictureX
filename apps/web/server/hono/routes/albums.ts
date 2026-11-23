import { Hono } from 'hono';
import { z } from 'zod';
import {
    albumDirFor,
    createAlbum,
    deleteAlbum,
    getAlbum,
    linkExistingAlbum,
    listAlbumSummaries,
    updateAlbum,
} from '../../album/album-store';
import { isImporting } from '../../ingest/ingest-service';
import { prewarmAlbumCover } from '../../album/thumb-service';
import { schedulePixivAutoFetch } from '../../pixiv/auto-fetch';
import { schedulePixivDatabaseSync } from '../../pixiv/database-sync';
import { schedulePixivLinkBackfill } from '../../pixiv/link-backfill';
import { clearLocalPixivPageCache } from '../../pixiv/local-assets';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { ApiError } from '../problem';
import { validateJson, validateQuery } from '../validation';
import { aiRoutes } from './ai';
import { assetRoutes } from './assets';
import { exportRoutes } from './exports';
import { groupRoutes } from './groups';
import { importRoutes } from './imports';
import { albumPixivRoutes } from './pixiv';
import { tagRoutes } from './tags';
import { thumbnailRoutes } from './thumbnails';

const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createBodySchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    dir: z.string().trim().max(4096).optional(),
});

const deleteQuerySchema = z.object({
    deleteFiles: z.enum(['true', 'false']).optional(),
});

const linkBodySchema = z.object({
    dir: z.string().trim().min(1).max(4096),
});

const patchBodySchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    coverAssetId: z.string().min(1).max(64).nullable().optional(),
    settings: z.object({
        similarityThreshold: z.number().int().min(0).max(64).nullable().optional(),
        autoTag: z.boolean().nullable().optional(),
        pixivEnabled: z.boolean().optional(),
        pixivAutoDownload: z.boolean().optional(),
    }).optional(),
});

export const albumRoutes = new Hono<AppEnv>()
    .get('/', validateQuery(listQuerySchema), (c) => {
        const { page, pageSize } = c.req.valid('query');
        const albums = listAlbumSummaries(getSettings());
        const start = (page - 1) * pageSize;

        return c.json({
            data: albums.slice(start, start + pageSize),
            pagination: { page, pageSize, total: albums.length },
        });
    })
    .post('/', validateJson(createBodySchema), (c) => {
        const settings = getSettings();
        const created = createAlbum(settings, c.req.valid('json'));

        c.header('location', `/api/v1/albums/${created.id}`);

        return c.json({ data: { ...created, dir: albumDirFor(settings, created.id), missing: false, corrupt: false } }, 201);
    })
    .post('/link', validateJson(linkBodySchema), (c) => {
        const linked = linkExistingAlbum(getSettings(), c.req.valid('json').dir);

        c.header('location', `/api/v1/albums/${linked.id}`);

        return c.json({ data: linked }, 201);
    })
    .get('/:albumId', (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));

        // 封面缩略图缺失时后台预热一次，首页卡片随后直接命中缓存
        prewarmAlbumCover(context.index.id, context.dir, settings, context.index.coverAssetId);

        // 打开启用 Pixiv 的相册时，后台串行补全作品信息
        if (context.index.settings.pixivEnabled) {
            schedulePixivLinkBackfill(context.index.id);
            schedulePixivAutoFetch(context.index.id);
            schedulePixivDatabaseSync();
        }

        return c.json({ data: context.index });
    })
    .patch('/:albumId', validateJson(patchBodySchema), (c) => {
        const updated = updateAlbum(getSettings(), c.req.param('albumId'), c.req.valid('json'));

        if (updated.settings.pixivEnabled) {
            schedulePixivLinkBackfill(updated.id);
            schedulePixivAutoFetch(updated.id);
        }

        return c.json({ data: updated });
    })
    .delete('/:albumId', validateQuery(deleteQuerySchema), (c) => {
        const albumId = c.req.param('albumId');

        if (isImporting(albumId)) {
            throw new ApiError(409, 'import_already_running', 'An import is running for this album.');
        }

        deleteAlbum(getSettings(), albumId, { deleteFiles: c.req.valid('query').deleteFiles === 'true' });
        clearLocalPixivPageCache();

        return c.body(null, 204);
    })
    .route('/', assetRoutes)
    .route('/', tagRoutes)
    .route('/', thumbnailRoutes)
    .route('/', groupRoutes)
    .route('/', importRoutes)
    .route('/', aiRoutes)
    .route('/', exportRoutes)
    .route('/', albumPixivRoutes);
