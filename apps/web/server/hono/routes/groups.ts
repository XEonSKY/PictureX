import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { toIsoRequired } from '../../utils/time';
import { Hono } from 'hono';
import { z } from 'zod';
import { getAlbum } from '../../album/album-store';
import { assets, duplicateFiles } from '../../database/schemas/album';
import { toAssetSummary } from '../../domain/asset-query';
import { clearDuplicateRecord, cleanupDuplicateFiles } from '../../domain/duplicate-cleanup';
import {
    isSimilarityIndexFresh,
    pendingPhashCount,
    readSimilarityGroups,
    readSimilarityIndexMeta,
    similarityProgress,
    warmSimilarityIndex,
} from '../../ingest/similarity-index';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { validateJson, validateQuery } from '../validation';

const cleanupBodySchema = z.object({
    confirm: z.literal(true),
});

const limitQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

const similarQuerySchema = z.object({
    threshold: z.coerce.number().int().min(0).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

const similarRebuildSchema = z.object({
    threshold: z.coerce.number().int().min(0).max(64).optional(),
});

export const groupRoutes = new Hono<AppEnv>()
    .get('/:albumId/groups/duplicates', validateQuery(limitQuerySchema), (c) => {
        const { limit } = c.req.valid('query');
        const context = getAlbum(getSettings(), c.req.param('albumId'));
        const db = context.db.album;
        const duplicates = db
            .select({ sha256: duplicateFiles.sha256, total: count() })
            .from(duplicateFiles)
            .groupBy(duplicateFiles.sha256)
            .orderBy(desc(sql`count(*)`))
            .limit(limit)
            .all();

        return c.json({
            data: duplicates.flatMap((group) => {
                // 原件在回收站时整组先隐藏，恢复后再展示；避免把已删除资产当成“保留项”
                const asset = db
                    .select()
                    .from(assets)
                    .where(and(eq(assets.sha256, group.sha256), isNull(assets.deletedAt)))
                    .limit(1)
                    .get();

                if (!asset) {
                    return [];
                }

                return [{
                    key: group.sha256,
                    count: 1 + Number(group.total),
                    asset: toAssetSummary(asset),
                    duplicates: db
                        .select()
                        .from(duplicateFiles)
                        .where(eq(duplicateFiles.sha256, group.sha256))
                        .limit(50)
                        .all()
                        .map(file => ({
                            id: file.id,
                            sourcePath: file.sourcePath,
                            filename: file.filename,
                            size: file.size,
                            foundAt: toIsoRequired(file.foundAt),
                        })),
                }];
            }),
        });
    })
    .post('/:albumId/duplicates/cleanup', validateJson(cleanupBodySchema), (c) => {
        const result = cleanupDuplicateFiles(getSettings(), c.req.param('albumId'));

        return c.json({ data: result });
    })
    .delete('/:albumId/duplicates/:duplicateId', (c) => {
        // 只移除记录；相册目录以外的源文件永远不由应用删除
        clearDuplicateRecord(getSettings(), c.req.param('albumId'), c.req.param('duplicateId'));

        return c.body(null, 204);
    })
    .post('/:albumId/similarity/rebuild', validateJson(similarRebuildSchema), (c) => {
        const settings = getSettings();
        const albumId = c.req.param('albumId');
        const context = getAlbum(settings, albumId);
        const db = context.db.album;
        const { threshold } = c.req.valid('json');
        const effectiveThreshold = threshold
          ?? context.index.settings.similarityThreshold
          ?? settings.similarity.hammingThreshold;

        if (!settings.similarity.enabled) {
            return c.json({ data: { rebuilding: false } }, 202);
        }

        // 重建是写库 + 耗 CPU 的副作用：只在显式 POST 时触发，GET 只读
        if (!isSimilarityIndexFresh(db, effectiveThreshold)) {
            warmSimilarityIndex(albumId, effectiveThreshold);
        }

        return c.json({ data: { rebuilding: true } }, 202);
    })
    .get('/:albumId/groups/similar', validateQuery(similarQuerySchema), (c) => {
        const settings = getSettings();
        const albumId = c.req.param('albumId');
        const context = getAlbum(settings, albumId);
        const db = context.db.album;
        const { limit, threshold } = c.req.valid('query');
        const effectiveThreshold = threshold
          ?? context.index.settings.similarityThreshold
          ?? settings.similarity.hammingThreshold;
        const enabled = settings.similarity.enabled;
        const meta = enabled ? readSimilarityIndexMeta(db) : null;
        const fresh = !enabled || isSimilarityIndexFresh(db, effectiveThreshold);

        const groups = enabled ? readSimilarityGroups(db, limit) : [];
        const progress = enabled ? similarityProgress(db) : { indexed: 0, total: 0 };
        const assetIds = [...new Set(groups.flatMap(group => group.items.map(item => item.assetId)))];
        const assetRows = assetIds.length === 0
            ? []
            : db
                .select()
                .from(assets)
                .where(and(inArray(assets.id, assetIds), isNull(assets.deletedAt)))
                .all();
        const byId = new Map(assetRows.map(row => [row.id, row]));

        return c.json({
            data: groups.flatMap((group) => {
                const members = group.items.flatMap((item) => {
                    const row = byId.get(item.assetId);

                    if (!row) {
                        return [];
                    }

                    return [{
                        ...toAssetSummary(row),
                        distance: item.distance,
                        score: Number((1 - item.distance / 64).toFixed(3)),
                    }];
                });

                if (members.length < 2) {
                    return [];
                }

                return [{
                    id: group.groupId,
                    representativeId: group.representativeId,
                    maxDistance: group.maxDistance,
                    assets: members,
                }];
            }),
            meta: {
                threshold: effectiveThreshold,
                indexedThreshold: meta?.threshold ?? null,
                groups: meta?.groups ?? 0,
                pendingPhash: enabled ? pendingPhashCount(db) : 0,
                phashedCount: progress.indexed,
                assetCount: progress.total,
                rebuilding: enabled && !fresh,
            },
        });
    });
