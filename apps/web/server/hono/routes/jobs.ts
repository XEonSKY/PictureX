import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { clearFinishedJobs, listJobViews } from '../../jobs/job-query';
import { collectDiskActivity } from '../../jobs/disk-activity';
import { jobsBus } from '../../jobs/event-bus';
import { modelDownloader } from '../../model/model-downloader';
import type { AppEnv } from '../env';
import { validateJson, validateQuery } from '../validation';

const listQuerySchema = z.object({
    type: z.enum(['import', 'download', 'ai']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    albumId: z.string().min(1).max(64).optional(),
});

const scopeQuerySchema = z.object({
    albumId: z.string().min(1).max(64).optional(),
});

const clearBodySchema = z.object({
    type: z.enum(['import', 'download', 'ai']).optional(),
    albumId: z.string().min(1).max(64).optional(),
    confirm: z.literal(true),
});

export const jobRoutes = new Hono<AppEnv>()
    .get('/', validateQuery(listQuerySchema), (c) => {
        const { type, limit, albumId } = c.req.valid('query');
        const views = listJobViews(albumId, limit);

        return c.json({
            data: (type ? views.filter(view => view.type === type) : views).slice(0, limit),
        });
    })
    .get('/disk', (c) => {
        return c.json({ data: collectDiskActivity() });
    })
    .post('/clear', validateJson(clearBodySchema), (c) => {
        const result = clearFinishedJobs(c.req.valid('json'));

        return c.json({ data: result });
    })
    .get('/events', validateQuery(scopeQuerySchema), (c) => {
        const downloader = modelDownloader();
        const albumId = c.req.valid('query').albumId ?? '';

        // 反向代理/网关不能缓冲事件流，否则进度会整段延迟
        c.header('cache-control', 'no-cache, no-transform');
        c.header('x-accel-buffering', 'no');

        return streamSSE(c, async (stream) => {
            let closed = false;
            const lastSent = new Map<string, number>();

            await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(listJobViews(albumId)) });

            const unsubscribeBus = jobsBus.subscribe((event) => {
                if (albumId && (event.type === 'download' || event.albumId !== albumId)) {
                    return;
                }

                stream.writeSSE({ event: 'job', data: JSON.stringify(event) }).catch(() => {
                    closed = true;
                });
            });

            const unsubscribeDownloads = downloader.subscribe((tasks) => {
                if (albumId) {
                    return;
                }

                const now = Date.now();

                for (const task of tasks) {
                    const last = lastSent.get(task.modelId) ?? 0;

                    if (now - last < 250) {
                        continue;
                    }

                    lastSent.set(task.modelId, now);
                    stream.writeSSE({
                        event: 'job',
                        data: JSON.stringify({
                            type: 'download',
                            modelId: task.modelId,
                            status: task.status,
                            bytesDone: task.bytesDone,
                            totalBytes: task.totalBytes,
                            speedBps: task.speedBps,
                            updatedAt: task.updatedAt,
                        }),
                    }).catch(() => {
                        closed = true;
                    });
                }
            });

            stream.onAbort(() => {
                closed = true;
                unsubscribeBus();
                unsubscribeDownloads();
            });

            while (!closed) {
                await stream.sleep(15_000);

                if (!closed) {
                    try {
                        await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
                    }
                    catch {
                        closed = true;
                    }
                }
            }

            unsubscribeBus();
            unsubscribeDownloads();
        });
    });
