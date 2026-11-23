import { z } from 'zod';
import { Hono } from 'hono';
import { globalDatabase } from '../../database/global';
import type { ViewerMediaRow } from '../../database/schemas/global';
import { validateJson, validateParam, validateQuery } from '../validation';
import { toIsoRequired } from '../../utils/time';
import {
    createGlobalTag,
    deleteAllGlobalTags,
    deleteGlobalTag,
    deleteGlobalTags,
    importGlobalTags,
    listGlobalTagsWithCounts,
    mergeGlobalTags,
    recolorGlobalTags,
    updateGlobalTag,
} from '../../viewer/global-tags';
import {
    forgetViewerMedia,
    getViewerMedia,
    listViewerMedia,
    registerViewerMedia,
    setViewerMediaTags,
} from '../../viewer/media-store';
import type { AppEnv } from '../env';
import {
    tagCreateSchema,
    tagDeleteAllSchema,
    tagIdsSchema as tagIdsBodySchema,
    tagImportSchema,
    tagMergeSchema,
    tagPatchSchema,
    tagRecolorSchema,
} from '../tag-schemas';

/**
 * 查看器全局接口（挂载到 /api/v1/viewer）。
 * 只处理「按内容哈希存储的图片/视频记录 + 全局标签」，不涉及相册、路径或磁盘文件。
 */

const sha256ParamSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/iu) });
const tagIdParamSchema = z.object({ tagId: z.string().min(1) });

const registerSchema = z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    kind: z.enum(['image', 'video']),
    mime: z.string().min(1).max(120),
    filename: z.string().min(1).max(400),
    lastPath: z.string().max(4096).nullish(),
    size: z.coerce.number().int().min(0),
    width: z.coerce.number().int().min(0).nullish(),
    height: z.coerce.number().int().min(0).nullish(),
    durationMs: z.coerce.number().int().min(0).nullish(),
});
const mediaTagsSchema = z.object({ tagIds: z.array(z.string().min(1)).max(200) });
const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).optional(),
    tagId: z.string().min(1).max(64).optional(),
});

function mediaDto(row: ViewerMediaRow, tagIds: string[]) {
    return {
        sha256: row.sha256,
        kind: row.kind,
        mime: row.mime,
        filename: row.filename,
        lastPath: row.lastPath,
        size: row.size,
        width: row.width,
        height: row.height,
        durationMs: row.durationMs,
        addedAt: toIsoRequired(row.addedAt),
        updatedAt: toIsoRequired(row.updatedAt),
        tagIds,
    };
}

export const viewerRoutes = new Hono<AppEnv>()
    .get('/tags', c => c.json({ data: listGlobalTagsWithCounts(globalDatabase()) }))
    .get('/tags/export', (c) => {
        const payload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            library: { scope: 'global' },
            tags: listGlobalTagsWithCounts(globalDatabase()),
        };

        c.header('content-type', 'application/json; charset=utf-8');
        c.header('content-disposition', 'attachment; filename="picturex-global-tags.json"');

        return c.json(payload);
    })
    .post('/tags', validateJson(tagCreateSchema), (c) => {
        const tag = createGlobalTag(c.req.valid('json'));

        c.header('location', `/api/v1/viewer/tags/${tag.id}`);

        return c.json({ data: tag }, 201);
    })
    .post('/tags/import', validateJson(tagImportSchema), (c) => {
        const result = importGlobalTags(c.req.valid('json').tags);

        return c.json({ data: result });
    })
    .post('/tags/batch-delete', validateJson(tagIdsBodySchema), (c) => {
        const removed = deleteGlobalTags(globalDatabase(), c.req.valid('json').ids);

        return c.json({ data: { removed } });
    })
    .post('/tags/colors', validateJson(tagRecolorSchema), (c) => {
        const result = recolorGlobalTags(c.req.valid('json'));

        return c.json({ data: result });
    })
    .post('/tags/delete-all', validateJson(tagDeleteAllSchema), (c) => {
        const removed = deleteAllGlobalTags(globalDatabase());

        return c.json({ data: { removed } });
    })
    .post('/tags/merge', validateJson(tagMergeSchema), (c) => {
        const { sourceIds, targetId } = c.req.valid('json');
        const result = mergeGlobalTags(globalDatabase(), sourceIds, targetId);

        return c.json({ data: result });
    })
    .patch('/tags/:tagId', validateParam(tagIdParamSchema), validateJson(tagPatchSchema), (c) => {
        const data = updateGlobalTag(c.req.valid('param').tagId, c.req.valid('json'));

        return c.json({ data });
    })
    .delete('/tags/:tagId', validateParam(tagIdParamSchema), (c) => {
        deleteGlobalTag(globalDatabase(), c.req.valid('param').tagId);

        return c.body(null, 204);
    })

    .get('/media', validateQuery(listQuerySchema), (c) => {
        const db = globalDatabase();
        const query = c.req.valid('query');
        const page = listViewerMedia(db, {
            limit: query.limit,
            cursor: query.cursor,
            tagId: query.tagId,
        });

        return c.json(page);
    })
    .post('/media', validateJson(registerSchema), (c) => {
        const db = globalDatabase();
        const row = registerViewerMedia(db, c.req.valid('json'));
        const tagIds = getViewerMedia(db, row.sha256)?.tagIds ?? [];

        // 规范：创建资源 201 + Location
        c.header('location', `/api/v1/viewer/media/${row.sha256}`);

        return c.json({ data: mediaDto(row, tagIds) }, 201);
    })
    .get('/media/:sha256', validateParam(sha256ParamSchema), (c) => {
        const found = getViewerMedia(globalDatabase(), c.req.valid('param').sha256);

        if (!found) {
            return c.json({ data: null });
        }

        return c.json({ data: mediaDto(found.media, found.tagIds) });
    })
    .patch('/media/:sha256/tags', validateParam(sha256ParamSchema), validateJson(mediaTagsSchema), (c) => {
        const tagIds = setViewerMediaTags(globalDatabase(), c.req.valid('param').sha256, c.req.valid('json').tagIds);

        return c.json({ data: { tagIds } });
    })
    .delete('/media/:sha256', validateParam(sha256ParamSchema), (c) => {
        forgetViewerMedia(globalDatabase(), c.req.valid('param').sha256);

        return c.body(null, 204);
    });
