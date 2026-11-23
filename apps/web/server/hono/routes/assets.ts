import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { resolveFfmpegPath } from '../../ingest/ffmpeg';
import { logger } from '../../logger';
import { and, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { getAlbum, type AlbumContext } from '../../album/album-store';
import { createThumbStore, type ThumbnailValue } from '../../album/thumb-store';
import {
    ensureThumbnail,
    noteThumbnailLookup,
    resolveThumbnailSize,
    thumbnailFingerprint,
} from '../../album/thumb-service';
import { assets } from '../../database/schemas/album';
import { getTagRecord, listTagRecords, tagIds } from '../../tags/tag-store';
import {
    assetNeighbors,
    deleteAsset,
    deleteAssetsBatch,
    getAssetDetail,
    getAssetRow,
    linkTag,
    linkTagsBatch,
    listAssets,
    livePhotoMeta,
    parseMeta,
    previewMeta,
    purgeTrash,
    renameAssetsBatch,
    updateAsset,
    restoreAsset,
    restoreAssetsBatch,
    toAssetSummary,
    unlinkTag,
} from '../../domain/asset-query';
import { readSimilarityGroupAssets } from '../../ingest/similarity-index';
import { ApiError, sendProblem } from '../problem';
import type { AppEnv } from '../env';
import { getSettings } from '../../settings/setting-store';
import { storageForAlbum } from '../../storage/registry';
import { validateJson, validateQuery } from '../validation';

const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(60),
    cursor: z.string().min(1).optional(),
    sort: z.enum(['addedAt', 'takenAt', 'filename', 'pixivId']).default('addedAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    kind: z.enum(['image', 'gif', 'dynamic', 'svg', 'video']).optional(),
    tagId: z.string().min(1).optional(),
    pixivTag: z.string().regex(/^\d+$/u).optional(),
    q: z.string().trim().max(200).optional(),
    trash: z.enum(['true', 'false']).optional(),
    favorite: z.enum(['true', 'false']).optional(),
});

const thumbnailQuerySchema = z.object({
    size: z.coerce.number().int().min(64).max(4096).default(256),
    /** 预载请求传 0：没有缓存时直接 404，不触发原图解码 */
    generate: z.enum(['0', '1']).default('1'),
    /** 停留升级请求传 1：缺目标档时同步生成，保证返回比首屏更清晰的图 */
    upgrade: z.enum(['0', '1']).default('0'),
});

const neighborsQuerySchema = z.object({
    from: z.enum(['similar']).optional(),
    group: z.string().min(1).max(64).optional(),
    // 相邻窗口：详情页一次取数百条元数据，连续快速切换不等待
    span: z.coerce.number().int().min(1).max(500).default(1),
    sort: z.enum(['addedAt', 'takenAt', 'filename', 'pixivId']).default('addedAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    kind: z.enum(['image', 'gif', 'dynamic', 'svg', 'video']).optional(),
    tagId: z.string().min(1).optional(),
    pixivTag: z.string().regex(/^\d+$/u).optional(),
    q: z.string().trim().max(200).optional(),
    favorite: z.enum(['true', 'false']).optional(),
});

const tagLinkSchema = z.object({
    tagId: z.string().min(1).max(64),
});

const renameSchema = z.object({
    filename: z.string().trim().min(1).max(200).optional(),
    favorite: z.boolean().optional(),
}).refine(value => value.filename !== undefined || value.favorite !== undefined, {
    message: 'filename or favorite is required',
});

const batchRenameSchema = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    prefix: z.string().max(80).default(''),
    start: z.coerce.number().int().min(0).max(1_000_000_000).default(1),
    padding: z.coerce.number().int().min(1).max(6).default(3),
});

const batchIdsSchema = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(1_000),
});

const batchDeleteSchema = batchIdsSchema.extend({
    confirm: z.literal(true),
});

const batchTagsSchema = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    addTagIds: z.array(z.string().min(1).max(64)).min(1).max(100),
});

interface ByteRange {
    start: number
    end: number
}

/** Node Readable → Web ReadableStream，pull 驱动自带背压，避免一次性读入大文件 */
function nodeToWeb(node: Readable): ReadableStream<Uint8Array> {
    const iterator = node[Symbol.asyncIterator]();

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();

                if (done) {
                    controller.close();

                    return;
                }

                controller.enqueue(new Uint8Array(value));
            }
            catch (error) {
                // pull 抛错（读盘失败等）：必须销毁源流释放 fd，否则句柄泄漏；再把错误上报
                node.destroy();
                controller.error(error);
            }
        },
        cancel() {
            node.destroy();
        },
    });
}

function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
    if (!header) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());

    if (!match) {
        return 'invalid';
    }

    const [, rawStart, rawEnd] = match;
    let start = rawStart ? Number(rawStart) : 0;
    let end = rawEnd ? Number(rawEnd) : size - 1;

    if (!rawStart && rawEnd) {
        const suffix = Number(rawEnd);

        start = Math.max(0, size - suffix);
        end = size - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
        return 'invalid';
    }

    // RFC 9110：last-byte-pos 超出资源长度时按最后一字节处理，而不是 416
    if (end >= size) {
        end = size - 1;
    }

    return { start, end };
}

function albumFor(albumId: string): AlbumContext {
    return getAlbum(getSettings(), albumId);
}

export const assetRoutes = new Hono<AppEnv>()
    .get('/:albumId/assets', validateQuery(listQuerySchema), (c) => {
        const albumId = c.req.param('albumId');
        const context = albumFor(albumId);
        const query = c.req.valid('query');
        const needle = query.q?.toLocaleLowerCase();
        const matchingTagIds = needle
            ? listTagRecords(context.db.tags)
                .filter(tag => tag.name.toLocaleLowerCase().includes(needle))
                .map(tag => tag.id)
            : undefined;
        const { trash, favorite, pixivTag, ...rest } = query;
        const started = Date.now();
        const result = listAssets(context.db.album, {
            ...rest,
            pixivTagId: pixivTag,
            pixivAttached: context.db.pixivAttached && context.index.settings.pixivEnabled,
            trash: trash === 'true',
            favorite: favorite === 'true',
            matchingTagIds,
        });

        logger.debug({
            albumId,
            limit: query.limit,
            sort: query.sort,
            order: query.order,
            cursor: Boolean(query.cursor),
            durationMs: Date.now() - started,
        }, 'asset list loaded');

        return c.json(result);
    })
    .get('/:albumId/assets/:assetId', (c) => {
        const context = albumFor(c.req.param('albumId'));
        const detail = getAssetDetail(context.db.album, context, c.req.param('assetId'));

        return c.json({ data: detail });
    })
    .patch('/:albumId/assets', validateJson(batchRenameSchema), (c) => {
        const context = albumFor(c.req.param('albumId'));
        const data = renameAssetsBatch(context.db.album, c.req.valid('json'));

        return c.json({ data });
    })
    .post('/:albumId/assets/batch-delete', validateJson(batchDeleteSchema), (c) => {
        const removed = deleteAssetsBatch(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json').ids,
        );

        return c.json({ data: { removed } });
    })
    .post('/:albumId/assets/batch-restore', validateJson(batchIdsSchema), (c) => {
        const restored = restoreAssetsBatch(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json').ids,
        );

        return c.json({ data: { restored } });
    })
    .post('/:albumId/assets/batch-tags', validateJson(batchTagsSchema), (c) => {
        const context = albumFor(c.req.param('albumId'));
        const { ids, addTagIds } = c.req.valid('json');
        const known = new Set(tagIds(context.db.tags));

        if (addTagIds.some(tagId => !known.has(tagId))) {
            throw new ApiError(404, 'tag_not_found', 'The requested tag does not exist.');
        }

        const linked = linkTagsBatch(context.db.album, ids, addTagIds);

        return c.json({ data: { linked } });
    })
    .patch('/:albumId/assets/:assetId', validateJson(renameSchema), (c) => {
        const context = albumFor(c.req.param('albumId'));
        const data = updateAsset(context.db.album, c.req.param('assetId'), c.req.valid('json'));

        return c.json({ data });
    })
    .get('/:albumId/assets/:assetId/neighbors', validateQuery(neighborsQuerySchema), (c) => {
        const context = albumFor(c.req.param('albumId'));
        const db = context.db.album;
        const assetId = c.req.param('assetId');
        const { from, group, span, favorite, pixivTag, ...listQuery } = c.req.valid('query');
        const needle = listQuery.q?.toLocaleLowerCase();
        // 与列表端点一致：搜索词命中应用标签名时也要进入 OR 条件
        const matchingTagIds = needle
            ? listTagRecords(context.db.tags)
                .filter(tag => tag.name.toLocaleLowerCase().includes(needle))
                .map(tag => tag.id)
            : undefined;

        if (from === 'similar' && group) {
            const items = readSimilarityGroupAssets(db, group);

            if (items.some(item => item.assetId === assetId)) {
                const rows = db
                    .select()
                    .from(assets)
                    .where(and(
                        inArray(assets.id, items.map(item => item.assetId)),
                        isNull(assets.deletedAt),
                    ))
                    .all();
                const byId = new Map(rows.map(row => [row.id, row]));
                const ordered = items.flatMap((item) => {
                    const row = byId.get(item.assetId);

                    return row ? [toAssetSummary(row)] : [];
                });
                const index = ordered.findIndex(item => item.id === assetId);

                if (index >= 0) {
                    const previousItems = ordered.slice(Math.max(0, index - span), index).reverse();
                    const nextItems = ordered.slice(index + 1, index + 1 + span);

                    return c.json({
                        data: {
                            scope: 'similar',
                            previous: previousItems[0] ?? null,
                            next: nextItems[0] ?? null,
                            previousItems,
                            nextItems,
                            index,
                            total: ordered.length,
                        },
                    });
                }
            }
        }

        return c.json({
            data: {
                scope: 'album',
                ...assetNeighbors(db, assetId, {
                    ...listQuery,
                    pixivTagId: pixivTag,
                    matchingTagIds,
                    pixivAttached: context.db.pixivAttached && context.index.settings.pixivEnabled,
                    favorite: favorite === 'true',
                    trash: false,
                }, span),
            },
        });
    })
    .delete('/:albumId/assets/:assetId', async (c) => {
        // 默认只移入回收站；永久删除走 /trash/:assetId
        await deleteAsset(getSettings(), c.req.param('albumId'), c.req.param('assetId'));

        return c.body(null, 204);
    })
    .delete('/:albumId/trash/:assetId', async (c) => {
        await deleteAsset(getSettings(), c.req.param('albumId'), c.req.param('assetId'), { purge: true });

        return c.body(null, 204);
    })
    .post('/:albumId/assets/:assetId/restore', (c) => {
        const settings = getSettings();
        const albumId = c.req.param('albumId');
        const assetId = c.req.param('assetId');

        restoreAsset(settings, albumId, assetId);

        const context = getAlbum(settings, albumId);

        return c.json({ data: toAssetSummary(getAssetRow(context.db.album, assetId)) });
    })
    .post('/:albumId/trash/purge', validateJson(z.object({ confirm: z.literal(true) })), async (c) => {
        const result = await purgeTrash(getSettings(), c.req.param('albumId'));

        return c.json({ data: result });
    })
    .post('/:albumId/trash/batch-purge', validateJson(batchDeleteSchema), async (c) => {
        const result = await purgeTrash(
            getSettings(),
            c.req.param('albumId'),
            c.req.valid('json').ids,
        );

        return c.json({ data: result });
    })
    .get('/:albumId/assets/:assetId/file', async (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const row = getAssetRow(context.db.album, c.req.param('assetId'));
        const storage = storageForAlbum(context.dir, settings);

        if (!(await storage.exists(row.storageKey))) {
            throw new ApiError(404, 'asset_file_missing', 'The original file is missing from storage.');
        }

        const info = await storage.stat(row.storageKey);
        const etag = `"${row.sha256}"`;

        if (c.req.header('if-none-match') === etag) {
            c.header('etag', etag);

            return c.body(null, 304);
        }

        const localPath = storage.localPath(row.storageKey);
        // 远端存储只返回整文件流；Range 直接忽略，不能伪造 206/content-range
        const range = localPath ? parseRange(c.req.header('range'), info.size) : null;

        if (range === 'invalid') {
            c.header('content-range', `bytes */${info.size}`);

            return sendProblem(c, 416, 'range_not_satisfiable', 'The requested byte range is not satisfiable.');
        }

        const effectiveRange = range;
        const isSvg = row.mime === 'image/svg+xml';
        const headers: Record<string, string> = {
            'content-type': row.mime,
            'accept-ranges': localPath ? 'bytes' : 'none',
            'cache-control': 'private, max-age=3600',
            'etag': etag,
            'x-content-type-options': 'nosniff',
            // SVG 内可携带脚本；图片标签里不会执行，但直接打开会变成同源页面
            'content-disposition': isSvg
                ? `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`
                : `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
            ...(isSvg ? { 'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox' } : {}),
        };

        if (effectiveRange) {
            headers['content-length'] = String(effectiveRange.end - effectiveRange.start + 1);
            headers['content-range'] = `bytes ${effectiveRange.start}-${effectiveRange.end}/${info.size}`;
        }
        else {
            headers['content-length'] = String(info.size);
        }

        const nodeStream = localPath && effectiveRange
            ? createReadStream(localPath, { start: effectiveRange.start, end: effectiveRange.end })
            : localPath
                ? createReadStream(localPath)
                : await storage.open(row.storageKey);
        return new Response(nodeToWeb(nodeStream), { status: effectiveRange ? 206 : 200, headers });
    })
    .get('/:albumId/assets/:assetId/preview', async (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const row = getAssetRow(context.db.album, c.req.param('assetId'));
        const preview = previewMeta(row);

        if (!preview) {
            throw new ApiError(404, 'asset_preview_missing', 'This asset has no generated preview.');
        }

        const storage = storageForAlbum(context.dir, settings);

        if (!(await storage.exists(preview.storageKey))) {
            throw new ApiError(404, 'asset_preview_missing', 'The preview file is missing from storage.');
        }

        const info = await storage.stat(preview.storageKey);
        const localPath = storage.localPath(preview.storageKey);
        const nodeStream = localPath
            ? createReadStream(localPath)
            : await storage.open(preview.storageKey);

        return new Response(nodeToWeb(nodeStream), {
            status: 200,
            headers: {
                'content-type': preview.mime,
                'content-length': String(info.size),
                'cache-control': 'private, max-age=3600',
                'etag': `"${row.sha256}-preview"`,
            },
        });
    })
    .get('/:albumId/assets/:assetId/stream', async (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const albumId = c.req.param('albumId');
        const assetId = c.req.param('assetId');
        const row = getAssetRow(context.db.album, assetId);
        const codec = String(parseMeta(row.meta).codec ?? '').toLowerCase();
        const native = ['mp4', 'm4v', 'webm'].includes(row.ext)
          && (codec === '' || ['h264', 'vp8', 'vp9', 'av1'].includes(codec));

        if (native) {
            return c.redirect(`/api/v1/albums/${albumId}/assets/${assetId}/file`, 302);
        }

        const ffmpeg = resolveFfmpegPath(settings);

        if (!ffmpeg) {
            throw new ApiError(501, 'ffmpeg_missing', 'ffmpeg is required to transcode this video.');
        }

        const storage = storageForAlbum(context.dir, settings);
        const localPath = storage.localPath(row.storageKey);

        if (!localPath) {
            throw new ApiError(501, 'transcode_remote_unsupported', 'Video transcoding requires local storage.');
        }

        if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
            throw new ApiError(503, 'transcode_busy', 'Too many concurrent video transcodes; please retry shortly.');
        }

        activeTranscodes += 1;
        let slotReleased = false;
        const releaseSlot = (): void => {
            if (slotReleased) {
                return;
            }
            slotReleased = true;
            activeTranscodes -= 1;
        };

        const child = spawn(ffmpeg, [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-i', localPath,
            '-map', '0:v:0',
            '-map', '0:a?',
            // 媒体信息只进数据库：转码流不携带输入文件的容器/EXIF 元数据
            '-map_metadata', '-1',
            '-fflags', '+bitexact',
            '-flags:v', '+bitexact',
            '-flags:a', '+bitexact',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            'pipe:1',
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = child.stdout!;
        const iterator = stdout[Symbol.asyncIterator]();

        child.stderr.on('data', (chunk: Buffer) => {
            logger.warn({ assetId, stderr: chunk.toString().slice(0, 400) }, 'video transcode');
        });
        child.on('error', (error) => {
            logger.warn({ err: error, assetId }, 'failed to spawn ffmpeg');
            releaseSlot();
        });
        child.on('close', releaseSlot);

        const stopChild = (): void => {
            child.kill();
            stdout.destroy();
        };

        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const { value, done } = await iterator.next();

                    if (done) {
                        controller.close();

                        return;
                    }

                    controller.enqueue(new Uint8Array(value));
                }
                catch (error) {
                    // 转码中途 pull 抛错：杀掉 ffmpeg，否则留下孤儿进程与句柄
                    stopChild();
                    controller.error(error);
                }
            },
            cancel() {
                stopChild();
            },
        });

        return new Response(body, {
            status: 200,
            headers: {
                'content-type': 'video/mp4',
                'cache-control': 'no-store',
            },
        });
    })
    .get('/:albumId/assets/:assetId/live', async (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const row = getAssetRow(context.db.album, c.req.param('assetId'));
        const live = livePhotoMeta(row);

        if (!live) {
            throw new ApiError(404, 'asset_live_missing', 'This asset has no Live Photo video.');
        }

        const storage = storageForAlbum(context.dir, settings);

        if (!(await storage.exists(live.storageKey))) {
            throw new ApiError(404, 'asset_live_missing', 'The Live Photo video is missing from storage.');
        }

        const info = await storage.stat(live.storageKey);
        const range = parseRange(c.req.header('range'), info.size);

        if (range === 'invalid') {
            c.header('content-range', `bytes */${info.size}`);

            return sendProblem(c, 416, 'range_not_satisfiable', 'The requested byte range is not satisfiable.');
        }

        const headers: Record<string, string> = {
            'content-type': live.mime,
            'accept-ranges': 'bytes',
            'cache-control': 'private, max-age=3600',
            'etag': `"${row.sha256}-live"`,
        };

        if (range) {
            headers['content-length'] = String(range.end - range.start + 1);
            headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`;
        }
        else {
            headers['content-length'] = String(info.size);
        }

        const localPath = storage.localPath(live.storageKey);
        const nodeStream = localPath
            ? createReadStream(localPath, range ? { start: range.start, end: range.end } : undefined)
            : await storage.open(live.storageKey);

        return new Response(nodeToWeb(nodeStream), { status: range ? 206 : 200, headers });
    })
    .get('/:albumId/assets/:assetId/thumbnail', validateQuery(thumbnailQuerySchema), async (c) => {
        const settings = getSettings();
        const context = getAlbum(settings, c.req.param('albumId'));
        const assetId = c.req.param('assetId');
        const { size, generate, upgrade } = c.req.valid('query');
        const allowGenerate = generate === '1';
        const wantsUpgrade = allowGenerate && upgrade === '1';
        const cacheFirst = settings.thumbnails.cacheFirst;
        const store = createThumbStore(context.db.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);
        // 只生成一个最贴近请求的配置尺寸；已有更大的图时直接复用，不重复解码
        const targetSize = resolveThumbnailSize(settings, size);
        const fingerprint = thumbnailFingerprint(settings, targetSize);
        const lookup = (): { value: ThumbnailValue, size: number } | null => {
            const exact = store.get(assetId, size);

            if (exact) {
                return { value: exact, size };
            }

            // 配置比请求大时（如 256/1024 + 请求 512）优先返回已生成的大图，避免长期用更小的档位
            if (targetSize >= size) {
                const target = store.get(assetId, targetSize);

                if (target) {
                    return { value: target, size: targetSize };
                }
            }

            return store.getClosest(assetId, size);
        };
        let found = lookup();

        noteThumbnailLookup(Boolean(found));

        const canGenerate = allowGenerate
          && (!found || found.size < size)
          && !store.has(assetId, targetSize)
          && !store.hasFailure(assetId, fingerprint);

        if (cacheFirst) {
            // 缓存优先：浏览请求绝不等待解码原图。缺目标档只进后台队列；
            // 完全没有缓存时先生成最小配置档，让瓦片用最短时间拿到图。
            if (canGenerate) {
                const generateSize = found ? targetSize : resolveThumbnailSize(settings, 1);
                const generateFingerprint = generateSize === targetSize
                    ? fingerprint
                    : thumbnailFingerprint(settings, generateSize);

                if (!store.has(assetId, generateSize) && !store.hasFailure(assetId, generateFingerprint)) {
                    void ensureThumbnail(
                        context.index.id,
                        context.dir,
                        settings,
                        assetId,
                        generateSize,
                        'background',
                    );
                }
            }
        }
        else if (
            wantsUpgrade
            && (!found || found.size < targetSize)
            && !store.has(assetId, targetSize)
            && !store.hasFailure(assetId, fingerprint)
        ) {
            // 停留升级：首屏图已经展示，这里可以等目标档生成完再返回，避免拿到与首屏相同的小图
            const generated = await ensureThumbnail(
                context.index.id,
                context.dir,
                settings,
                assetId,
                targetSize,
                'interactive',
            );

            if (generated) {
                found = lookup();
            }
        }
        else if (canGenerate) {
            if (found) {
                // stale-while-revalidate：先把已有的较小缩略图返回给首屏，
                // 目标尺寸在后台低优先级队列生成，下次请求自然升级
                void ensureThumbnail(context.index.id, context.dir, settings, assetId, targetSize, 'background');
            }
            else {
                const generated = await ensureThumbnail(context.index.id, context.dir, settings, assetId, targetSize, 'interactive');

                if (generated) {
                    found = lookup();
                }
            }
        }

        if (!found) {
            throw new ApiError(404, 'thumbnail_not_found', 'The requested thumbnail does not exist.');
        }

        const { value: thumbnail, size: resolvedSize } = found;
        const etag = `"${assetId}-${resolvedSize}-${thumbnail.createdAt}"`;

        c.header('content-type', thumbnail.mime);
        // 同一 URL 的缩略图会随质量/尺寸调整而变化，不能声明 immutable
        c.header('cache-control', 'private, max-age=300, must-revalidate');
        c.header('etag', etag);

        if (c.req.header('if-none-match') === etag) {
            return c.body(null, 304);
        }

        return c.body(new Uint8Array(thumbnail.blob));
    })
    .post('/:albumId/assets/:assetId/tags', validateJson(tagLinkSchema), (c) => {
        const context = albumFor(c.req.param('albumId'));
        const { tagId } = c.req.valid('json');
        const tagExists = getTagRecord(context.db.tags, tagId) !== undefined;

        if (!tagExists) {
            throw new ApiError(404, 'tag_not_found', 'The requested tag does not exist.');
        }

        linkTag(context.db.album, c.req.param('assetId'), tagId);
        c.header('location', `/api/v1/albums/${c.req.param('albumId')}/assets/${c.req.param('assetId')}/tags/${tagId}`);

        return c.body(null, 201);
    })
    .delete('/:albumId/assets/:assetId/tags/:tagId', (c) => {
        const context = albumFor(c.req.param('albumId'));

        unlinkTag(context.db.album, c.req.param('assetId'), c.req.param('tagId'));

        return c.body(null, 204);
    });

/**
 * 转码并发上限：ffmpeg 每路进程吃 CPU 与句柄，反复拖动进度会并发多路。
 * 超限直接 503（前端提示稍后重试），而不是无限起进程。槽位随进程 close/exit 释放。
 */
const MAX_CONCURRENT_TRANSCODES = 2;
let activeTranscodes = 0;
