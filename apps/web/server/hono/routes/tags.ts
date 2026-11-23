import { count, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import {
    createTag,
    deleteAllTags,
    deleteTag,
    deleteTags,
    getAlbum,
    importTags,
    mergeTags,
    recolorTags,
    updateTag,
} from '../../album/album-store';
import { listTagRecords } from '../../tags/tag-store';
import { assetTags, assets } from '../../database/schemas/album';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { validateJson } from '../validation';
import {
    tagCreateSchema as tagBodySchema,
    tagDeleteAllSchema,
    tagIdsSchema as tagBatchDeleteSchema,
    tagImportSchema,
    tagMergeSchema,
    tagPatchSchema,
    tagRecolorSchema,
} from '../tag-schemas';

function tagsWithCounts(context: ReturnType<typeof getAlbum>) {
    const counts = context.db.album
        .select({ tagId: assetTags.tagId, total: count() })
        .from(assetTags)
        .innerJoin(assets, eq(assetTags.assetId, assets.id))
        .where(isNull(assets.deletedAt))
        .groupBy(assetTags.tagId)
        .all();
    const countMap = new Map(counts.map(row => [row.tagId, Number(row.total)]));

    return listTagRecords(context.db.tags).map(tag => ({
        ...tag,
        count: countMap.get(tag.id) ?? 0,
    }));
}

export const tagRoutes = new Hono<AppEnv>()
    .get('/:albumId/tags', (c) => {
        const context = getAlbum(getSettings(), c.req.param('albumId'));

        return c.json({ data: tagsWithCounts(context) });
    })
    .get('/:albumId/tags/export', (c) => {
        const settings = getSettings();
        const albumId = c.req.param('albumId');
        const context = getAlbum(settings, albumId);
        const payload = {
            schemaVersion: 1,
            album: { id: context.index.id, name: context.index.name },
            exportedAt: new Date().toISOString(),
            tags: tagsWithCounts(context),
        };
        const ascii = `${context.index.id}-tags.json`;
        const unicode = encodeURIComponent(`${context.index.name || 'album'}-tags.json`);

        c.header('content-type', 'application/json; charset=utf-8');
        c.header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${unicode}`);

        return c.json(payload);
    })
    .post('/:albumId/tags', validateJson(tagBodySchema), (c) => {
        const created = createTag(getSettings(), c.req.param('albumId'), c.req.valid('json'));

        c.header('location', `/api/v1/albums/${c.req.param('albumId')}/tags/${created.id}`);

        return c.json({ data: created }, 201);
    })
    .post('/:albumId/tags/import', validateJson(tagImportSchema), (c) => {
        const result = importTags(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json').tags,
        );

        return c.json({ data: result });
    })
    .post('/:albumId/tags/batch-delete', validateJson(tagBatchDeleteSchema), (c) => {
        const removed = deleteTags(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json').ids,
        );

        return c.json({ data: { removed } });
    })
    .post('/:albumId/tags/colors', validateJson(tagRecolorSchema), (c) => {
        const result = recolorTags(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json'),
        );

        return c.json({ data: result });
    })
    .post('/:albumId/tags/delete-all', validateJson(tagDeleteAllSchema), (c) => {
        const removed = deleteAllTags(getSettings(), c.req.param('albumId'));

        return c.json({ data: { removed } });
    })
    .post('/:albumId/tags/merge', validateJson(tagMergeSchema), (c) => {
        const { sourceIds, targetId } = c.req.valid('json');
        const result = mergeTags(
            getSettings(),
            c.req.param('albumId'),
            sourceIds,
            targetId,
        );

        return c.json({ data: result });
    })
    .patch('/:albumId/tags/:tagId', validateJson(tagPatchSchema), (c) => {
        const updated = updateTag(
            getSettings(),
            c.req.param('albumId'),
            c.req.param('tagId'),
            c.req.valid('json'),
        );

        return c.json({ data: updated });
    })
    .delete('/:albumId/tags/:tagId', (c) => {
        deleteTag(getSettings(), c.req.param('albumId'), c.req.param('tagId'));

        return c.body(null, 204);
    });
