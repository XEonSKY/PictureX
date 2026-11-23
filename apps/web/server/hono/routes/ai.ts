import { Hono } from 'hono';
import { z } from 'zod';
import { deleteAiJob, getAiJob, listAiJobs, pauseStaleAiJobs } from '../../album/ai-job-store';
import { assertAlbumRegistered } from '../../album/album-store';
import { cancelTagging, isTagging, pauseTagging, resumeTagging, startTagging } from '../../ai/tagging-service';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { validateJson } from '../validation';

const tagBodySchema = z.object({
    mode: z.enum(['zero-shot', 'generative', 'external']).optional(),
    assetIds: z.array(z.string().min(1).max(64)).max(500).optional(),
    // 不传时打标相册内全部资产
    limit: z.coerce.number().int().min(1).max(1_000_000).optional(),
});

export const aiRoutes = new Hono<AppEnv>()
    .post('/:albumId/ai/tag', validateJson(tagBodySchema), async (c) => {
        const albumId = c.req.param('albumId');
        const input = c.req.valid('json');
        const job = await startTagging(albumId, input);

        c.header('location', `/api/v1/albums/${albumId}/ai/jobs/${job.id}`);

        return c.json({ data: job }, 202);
    })
    .get('/:albumId/ai/jobs', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleAiJobs(albumId, isTagging(albumId));

        return c.json({ data: listAiJobs(albumId, 50) });
    })
    .get('/:albumId/ai/jobs/:jobId', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleAiJobs(albumId, isTagging(albumId));

        return c.json({ data: getAiJob(albumId, c.req.param('jobId')) });
    })
    .post('/:albumId/ai/jobs/:jobId/pause', (c) => {
        return c.json({ data: pauseTagging(c.req.param('albumId'), c.req.param('jobId')) });
    })
    .post('/:albumId/ai/jobs/:jobId/resume', (c) => {
        return c.json({ data: resumeTagging(c.req.param('albumId'), c.req.param('jobId')) });
    })
    .post('/:albumId/ai/jobs/:jobId/cancel', (c) => {
        return c.json({ data: cancelTagging(c.req.param('albumId'), c.req.param('jobId')) });
    })
    .delete('/:albumId/ai/jobs/:jobId', (c) => {
        const albumId = c.req.param('albumId');
        assertAlbumRegistered(getSettings(), albumId);

        pauseStaleAiJobs(albumId, isTagging(albumId));
        deleteAiJob(albumId, c.req.param('jobId'));

        return c.body(null, 204);
    });
