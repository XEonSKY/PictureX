import { Hono } from 'hono';
import { nowSeconds } from '../../utils/time';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { assertAlbumRegistered } from '../../album/album-store';
import { deleteImportJob, getImportJob, listImportJobs, pauseStaleImports, updateImportJob } from '../../album/import-job-store';
import { isImporting, requestImportCancel, requestImportPause, startImport } from '../../ingest/ingest-service';
import { jobsBus, type ImportJobEvent } from '../../jobs/event-bus';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { ApiError } from '../problem';
import { validateJson } from '../validation';

const createImportSchema = z.object({
    rootPath: z.string().trim().min(1).max(4096),
    resume: z.boolean().optional(),
});

function toEvent(job: ReturnType<typeof getImportJob>, albumId: string): ImportJobEvent {
    return {
        type: 'import',
        albumId,
        jobId: job.id,
        status: job.status,
        total: job.total,
        processed: job.processed,
        added: job.added,
        duplicates: job.duplicates,
        skipped: job.skipped,
        errors: job.errors,
        updatedAt: job.updatedAt,
    };
}

export const importRoutes = new Hono<AppEnv>()
    .get('/:albumId/imports', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleImports(albumId, isImporting(albumId));

        return c.json({ data: listImportJobs(albumId, 50) });
    })
    .post('/:albumId/imports', validateJson(createImportSchema), async (c) => {
        const albumId = c.req.param('albumId');
        const job = await startImport(albumId, c.req.valid('json'));

        c.header('location', `/api/v1/albums/${albumId}/imports/${job.id}`);

        return c.json({ data: job }, 202);
    })
    .get('/:albumId/imports/:jobId', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleImports(albumId, isImporting(albumId));

        const job = getImportJob(albumId, c.req.param('jobId'));

        return c.json({ data: job });
    })
    .post('/:albumId/imports/:jobId/pause', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);
        const job = getImportJob(albumId, c.req.param('jobId'));

        if (!requestImportPause(albumId, job.id)) {
            throw new ApiError(409, 'job_not_running', 'The import is not running.');
        }

        return c.json({ data: job });
    })
    .post('/:albumId/imports/:jobId/cancel', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);
        const job = getImportJob(albumId, c.req.param('jobId'));

        if (!requestImportCancel(albumId, job.id)) {
            if (job.status !== 'running' && job.status !== 'paused') {
                throw new ApiError(409, 'job_not_running', 'The import is not running.');
            }

            updateImportJob(albumId, job.id, {
                status: 'cancelled',
                finishedAt: nowSeconds(),
            });
        }

        return c.json({ data: getImportJob(albumId, job.id) }, 202);
    })
    .post('/:albumId/imports/:jobId/resume', async (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);
        const job = getImportJob(albumId, c.req.param('jobId'));

        if (isImporting(albumId)) {
            throw new ApiError(409, 'import_already_running', 'An import is already running for this album.');
        }
        if (job.status !== 'paused') {
            throw new ApiError(409, 'job_not_running', 'Only paused imports can be resumed.');
        }

        const resumed = await startImport(albumId, { rootPath: job.rootPath, resume: true, resumeJobId: job.id });

        return c.json({ data: resumed }, 202);
    })
    .get('/:albumId/imports/:jobId/events', (c) => {
        const albumId = c.req.param('albumId');
        const jobId = c.req.param('jobId');
        assertAlbumRegistered(getSettings(), albumId);
        const job = getImportJob(albumId, jobId);

        return streamSSE(c, async (stream) => {
            let closed = false;

            await stream.writeSSE({ event: 'import', data: JSON.stringify(toEvent(job, albumId)) });

            const unsubscribe = jobsBus.subscribe((event) => {
                if (event.type !== 'import' || event.albumId !== albumId || event.jobId !== jobId) {
                    return;
                }

                stream.writeSSE({ event: 'import', data: JSON.stringify(event) }).catch(() => {
                    closed = true;
                });
            });

            stream.onAbort(() => {
                closed = true;
                unsubscribe();
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

            unsubscribe();
        });
    })
    .delete('/:albumId/imports/:jobId', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleImports(albumId, isImporting(albumId));
        deleteImportJob(albumId, c.req.param('jobId'));

        return c.body(null, 204);
    });
