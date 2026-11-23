import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { exportAlbumAssets, planExport } from '../../domain/export-assets';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { validateJson } from '../validation';

const exportBodySchema = z.object({
    targetPath: z.string().trim().min(1).max(4096),
    naming: z.enum(['sequence', 'filename', 'uuid']).default('sequence'),
});

export const exportRoutes = new Hono<AppEnv>()
    .post('/:albumId/exports', validateJson(exportBodySchema), (c) => {
        const settings = getSettings();
        const options = c.req.valid('json');
        // 先校验目标目录：错误在写响应头之前抛出，仍是 problem+json
        const plan = planExport(settings, c.req.param('albumId'), options);

        c.header('content-type', 'application/x-ndjson; charset=utf-8');
        c.header('cache-control', 'no-store');

        return stream(c, async (output) => {
            for await (const event of exportAlbumAssets(plan, options, c.req.raw.signal)) {
                await output.write(`${JSON.stringify(event)}\n`);
            }
        });
    });
