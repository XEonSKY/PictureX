import { Hono } from 'hono';
import { z } from 'zod';
import { getAlbum } from '../../album/album-store';
import { createThumbStore } from '../../album/thumb-store';
import { thumbnailServiceStats } from '../../album/thumb-service';
import {
    cancelThumbnailWarmup,
    pauseThumbnailWarmup,
    resetThumbnailWarmupPosition,
    startThumbnailWarmup,
    thumbnailWarmupState,
} from '../../album/thumb-warmup';
import { startThumbMaintenance, thumbMaintenanceStatus } from '../../album/thumb-maintenance';
import { getSettings } from '../../settings/setting-store';
import { validateJson } from '../validation';
import type { AppEnv } from '../env';

/**
 * 缩略图库维护入口：统计、手动优化与清空。
 * 自动维护由 05-thumbnails 插件在空闲关闭前和每小时执行。
 */
const warmupBodySchema = z.object({
    restart: z.boolean().optional(),
});

export const thumbnailRoutes = new Hono<AppEnv>()
    .get('/:albumId/thumbnails', (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const store = createThumbStore(context.db.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);

        return c.json({
            data: {
                ...store.stats(),
                sizes: store.sizeBreakdown(),
                autoOptimize: settings.thumbnails.autoOptimize,
                maintenance: thumbMaintenanceStatus(c.req.param('albumId')),
                warmup: thumbnailWarmupState(c.req.param('albumId'), context),
                generator: thumbnailServiceStats(),
            },
        });
    })
    .post('/:albumId/thumbnails/warmup', validateJson(warmupBodySchema), (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const data = startThumbnailWarmup(settings, context, {
            restart: c.req.valid('json').restart === true,
        });

        c.status(202);

        return c.json({ data });
    })
    .post('/:albumId/thumbnails/warmup/pause', (c) => {
        const context = getAlbum(getSettings(), c.req.param('albumId'));
        const data = pauseThumbnailWarmup(c.req.param('albumId'), context);

        c.status(202);

        return c.json({ data });
    })
    .post('/:albumId/thumbnails/warmup/cancel', (c) => {
        const context = getAlbum(getSettings(), c.req.param('albumId'));
        const data = cancelThumbnailWarmup(c.req.param('albumId'), context);

        c.status(202);

        return c.json({ data });
    })
    .post('/:albumId/thumbnails/optimize', (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const data = startThumbMaintenance(settings, context, 'optimize');

        c.status(202);

        return c.json({ data });
    })
    .delete('/:albumId/thumbnails', (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));

        cancelThumbnailWarmup(context.index.id, context);
        resetThumbnailWarmupPosition(context);

        const data = startThumbMaintenance(settings, context, 'clear');

        c.status(202);

        return c.json({ data });
    });
