import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { getAlbum, reconcileAlbum, type AlbumContext, type TagRecord } from '../album/album-store';
import { listTagRecords } from '../tags/tag-store';
import { createThumbStore } from '../album/thumb-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import { assetTags, assets, duplicateFiles, pixivAssetLinks } from '../database/schemas/album';
import { logger } from '../logger';
import { ApiError } from '../hono/problem';
import type { Settings } from '../settings/setting-schema';
import { formatPixivDisplayName } from '../../shared/pixiv';
import { storageForAlbum } from '../storage/registry';
import { nowSeconds, toIso, toIsoRequired } from '../utils/time';
import { pruneAlbumPixivData } from '../pixiv/store';
import { clearLocalPixivPageCache } from '../pixiv/local-assets';

export type AssetSort = 'addedAt' | 'takenAt' | 'filename' | 'pixivId';
export type SortOrder = 'asc' | 'desc';

export interface AssetSummaryDto {
    id: string
    filename: string
    /** 展示名：Pixiv 作品取标题（多分P带页码），否则等于 filename */
    displayName: string
    ext: string
    mime: string
    kind: string
    size: number
    width: number | null
    height: number | null
    durationMs: number | null
    takenAt: string | null
    addedAt: string
    deletedAt: string | null
    favorite: boolean
}

export interface AssetLiveDto {
    mime: string
    size: number
}

export interface AssetDetailDto extends AssetSummaryDto {
    storageKey: string
    sha256: string
    phash: string | null
    live: AssetLiveDto | null
    preview: AssetLiveDto | null
    meta: Record<string, unknown>
    tags: TagRecord[]
}

export interface AssetFilterQuery {
    sort: AssetSort
    order: SortOrder
    kind?: string
    tagId?: string
    /** Pixiv 标签 id（相册副本 tags.tag_id），只在 pixivAttached 时生效 */
    pixivTagId?: string
    q?: string
    /** 标签名命中搜索词的标签 id，由调用方读取标签库后传入 */
    matchingTagIds?: string[]
    /** true 时只返回回收站里的资产 */
    trash?: boolean
    /** true 时只返回收藏 */
    favorite?: boolean
    /** 相册库是否 ATTACH 了 pixiv.db；内存库没有附加时空过 Pixiv 搜索 */
    pixivAttached?: boolean
}

export interface AssetListQuery extends AssetFilterQuery {
    limit: number
    cursor?: string
}

export interface AssetListResult {
    data: AssetSummaryDto[]
    pagination: {
        limit: number
        nextCursor: string | null
        hasMore: boolean
    }
}

interface CursorPayload {
    value: string
    id: string
}

export function encodeCursor(value: string | number, id: string): string {
    return Buffer.from(JSON.stringify([value, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
    try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

        if (
            Array.isArray(decoded)
            && (typeof decoded[0] === 'string' || typeof decoded[0] === 'number')
            && typeof decoded[1] === 'string'
        ) {
            return { value: String(decoded[0]), id: decoded[1] };
        }
    }
    catch {
        // fallthrough
    }

    throw new ApiError(422, 'validation_failed', 'Invalid pagination cursor.');
}

export function parseMeta(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);

        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    }
    catch {
        return {};
    }
}

function pixivTitle(row: { meta: string }): { title: string, pageIndex: number, pageCount: number } | null {
    const value = parseMeta(row.meta).pixiv;

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const pixiv = value as Record<string, unknown>;
    const title = typeof pixiv.title === 'string' ? pixiv.title.trim() : '';

    if (title === '') {
        return null;
    }

    return {
        title,
        pageIndex: typeof pixiv.pageIndex === 'number' ? pixiv.pageIndex : 0,
        pageCount: typeof pixiv.pageCount === 'number' ? pixiv.pageCount : 1,
    };
}

export function toAssetSummary(row: typeof assets.$inferSelect): AssetSummaryDto {
    const pixiv = pixivTitle(row);
    let displayName = row.filename;

    if (pixiv) {
        displayName = formatPixivDisplayName(pixiv.title, pixiv.pageIndex, pixiv.pageCount);
    }

    return {
        id: row.id,
        filename: row.filename,
        displayName,
        ext: row.ext,
        mime: row.mime,
        kind: row.kind,
        size: row.size,
        width: row.width,
        height: row.height,
        durationMs: row.durationMs,
        takenAt: toIso(row.takenAt),
        addedAt: toIsoRequired(row.addedAt),
        deletedAt: toIso(row.deletedAt),
        favorite: row.favorite === 1,
    };
}

function sortExpression(sort: AssetSort): SQL {
    if (sort === 'filename') {
        return sql`${assets.filename}`;
    }
    if (sort === 'takenAt') {
        return sql`coalesce(${assets.takenAt}, ${assets.addedAt})`;
    }
    if (sort === 'pixivId') {
        return sql`${assets.pixivIllustNum}`;
    }

    return sql`${assets.addedAt}`;
}

function cursorValue(row: typeof assets.$inferSelect, sort: AssetSort): string | number {
    if (sort === 'filename') {
        return row.filename;
    }
    if (sort === 'takenAt') {
        return row.takenAt ?? row.addedAt;
    }
    if (sort === 'pixivId') {
        return row.pixivIllustNum ?? 0;
    }

    return row.addedAt;
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/gu, char => `\\${char}`);
}

function buildAssetClauses(db: AlbumDatabase, query: AssetFilterQuery): SQL[] {
    const clauses: SQL[] = [
        query.trash ? isNotNull(assets.deletedAt) : isNull(assets.deletedAt),
    ];

    if (query.kind) {
        clauses.push(eq(assets.kind, query.kind));
    }
    if (query.favorite) {
        clauses.push(eq(assets.favorite, 1));
    }
    if (query.q) {
        const needle = query.q.trim();
        const matches: SQL[] = [];

        // trigram 索引覆盖子串搜索；少于 3 个字符时 FTS 无法命中，退回 LIKE
        if ([...needle].length >= 3) {
            const ftsQuery = `"${needle.replace(/"/gu, '""')}"`;

            matches.push(sql`${assets.id} IN (
                SELECT asset_id FROM assets_fts WHERE assets_fts MATCH ${ftsQuery}
            )`);
        }
        else {
            // % 与 _ 是通配符，必须转义后再包前后缀，否则用户输入的 % 会命中全部
            const pattern = `%${escapeLike(needle)}%`;

            matches.push(
                sql`${assets.filename} LIKE ${pattern} ESCAPE '\\'`,
                sql`json_extract(${assets.meta}, '$.ai.caption') LIKE ${pattern} ESCAPE '\\'`,
            );
        }

        if (query.matchingTagIds && query.matchingTagIds.length > 0) {
            matches.push(inArray(
                assets.id,
                db.select({ id: assetTags.assetId })
                    .from(assetTags)
                    .where(inArray(assetTags.tagId, query.matchingTagIds)),
            ));
        }

        // Pixiv 作品标题/画师/作品标签不在 assets 表里：用附加的 pixiv.db 做一次 EXISTS
        if (query.pixivAttached) {
            const pattern = `%${escapeLike(needle)}%`;

            matches.push(sql`EXISTS (
                SELECT 1 FROM pixiv_asset_links l
                JOIN pixiv.illusts i ON i.illust_id = l.illust_id
                LEFT JOIN pixiv.users u ON u.user_id = i.user_id
                WHERE l.asset_id = ${assets.id}
                  AND (
                      i.title LIKE ${pattern} ESCAPE '\\'
                      OR i.illust_id LIKE ${pattern} ESCAPE '\\'
                      OR u.name LIKE ${pattern} ESCAPE '\\'
                      OR u.account LIKE ${pattern} ESCAPE '\\'
                      OR EXISTS (
                          SELECT 1 FROM pixiv.illust_tags it
                          JOIN pixiv.tags t ON t.tag_id = it.tag_id
                          WHERE it.illust_id = i.illust_id
                            AND (t.name LIKE ${pattern} ESCAPE '\\'
                                 OR t.translated_name LIKE ${pattern} ESCAPE '\\')
                      )
                  )
            )`);
        }

        const searchClause = or(...matches);

        if (searchClause) {
            clauses.push(searchClause);
        }
    }
    if (query.tagId) {
        clauses.push(inArray(
            assets.id,
            db.select({ id: assetTags.assetId }).from(assetTags).where(eq(assetTags.tagId, query.tagId)),
        ));
    }
    if (query.pixivTagId && query.pixivAttached) {
        const tagId = Number(query.pixivTagId);

        if (Number.isInteger(tagId) && tagId > 0) {
            clauses.push(sql`EXISTS (
                SELECT 1 FROM pixiv_asset_links l
                JOIN pixiv.illust_tags it ON it.illust_id = l.illust_id
                WHERE l.asset_id = ${assets.id} AND it.tag_id = ${tagId}
            )`);
        }
    }

    return clauses;
}

export function listAssets(db: AlbumDatabase, query: AssetListQuery): AssetListResult {
    const sortExpr = sortExpression(query.sort);
    const direction = query.order === 'asc' ? asc : desc;
    const clauses = buildAssetClauses(db, query);

    if (query.cursor) {
        const cursor = decodeCursor(query.cursor);
        // 时间/数值排序列是 INTEGER：游标必须按数字绑定，否则 SQLite 按 TEXT 比较导致分页错位
        const value = query.sort === 'filename' ? cursor.value : Number(cursor.value);

        // 行值比较与 (sort, id) 索引同向，SQLite 能直接定位到游标位置
        clauses.push(query.order === 'asc'
            ? sql`(${sortExpr}, ${assets.id}) > (${value}, ${cursor.id})`
            : sql`(${sortExpr}, ${assets.id}) < (${value}, ${cursor.id})`);
    }

    const rows = db
        .select()
        .from(assets)
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .orderBy(direction(sortExpr), direction(assets.id))
        .limit(query.limit + 1)
        .all();
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const last = visible[visible.length - 1];

    return {
        data: visible.map(toAssetSummary),
        pagination: {
            limit: query.limit,
            nextCursor: hasMore && last ? encodeCursor(cursorValue(last, query.sort), last.id) : null,
            hasMore,
        },
    };
}

export interface AssetNeighbors {
    previous: AssetSummaryDto | null
    next: AssetSummaryDto | null
    previousItems: AssetSummaryDto[]
    nextItems: AssetSummaryDto[]
    index: number
    total: number
}

/**
 * 查看器的上一张/下一张：按 `addedAt desc`（与网格默认排序一致）用
 * `(added_at, id)` 直接比较取相邻行，10 万级资产也不做全表扫描；
 * 不再像旧实现那样只在前 200 条里找位置。
 */
type NeighborDirection = 'next' | 'previous';

function keysetClause(
    row: typeof assets.$inferSelect,
    query: AssetFilterQuery,
    direction: NeighborDirection,
): SQL {
    const sortExpr = sortExpression(query.sort);
    const value = cursorValue(row, query.sort);
    // 列表升序时 next 更大；降序时 next 更小。previous 反之。
    const useGreater = (direction === 'next') === (query.order === 'asc');

    return useGreater
        ? sql`(${sortExpr}, ${assets.id}) > (${value}, ${row.id})`
        : sql`(${sortExpr}, ${assets.id}) < (${value}, ${row.id})`;
}

function neighborRows(
    db: AlbumDatabase,
    anchor: typeof assets.$inferSelect,
    query: AssetFilterQuery,
    direction: NeighborDirection,
    limit: number,
    excludeIds: string[] = [],
): typeof assets.$inferSelect[] {
    const clauses = buildAssetClauses(db, query);

    clauses.push(keysetClause(anchor, query, direction));

    if (excludeIds.length > 0) {
        clauses.push(notInArray(assets.id, excludeIds));
    }

    const sortExpr = sortExpression(query.sort);
    // next 永远沿列表方向（升序列表取升序、降序列表取降序）；previous 反向
    const order = direction === 'next'
        ? (query.order === 'asc' ? asc : desc)
        : (query.order === 'asc' ? desc : asc);

    return db
        .select()
        .from(assets)
        .where(and(...clauses))
        .orderBy(order(sortExpr), order(assets.id))
        .limit(limit)
        .all();
}

function countNeighbors(
    db: AlbumDatabase,
    anchor: typeof assets.$inferSelect,
    query: AssetFilterQuery,
    direction: NeighborDirection,
    excludeIds: string[] = [],
): number {
    const clauses = buildAssetClauses(db, query);

    clauses.push(keysetClause(anchor, query, direction));

    if (excludeIds.length > 0) {
        clauses.push(notInArray(assets.id, excludeIds));
    }

    const row = db
        .select({ total: sql<number>`count(*)` })
        .from(assets)
        .where(and(...clauses))
        .get();

    return Number(row?.total ?? 0);
}

function countFiltered(db: AlbumDatabase, query: AssetFilterQuery): number {
    const clauses = buildAssetClauses(db, query);
    const row = db
        .select({ total: sql<number>`count(*)` })
        .from(assets)
        .where(clauses.length > 0 ? and(...clauses) : undefined)
        .get();

    return Number(row?.total ?? 0);
}

function compareListOrder(
    left: typeof assets.$inferSelect,
    right: typeof assets.$inferSelect,
    query: AssetFilterQuery,
): number {
    const leftValue = cursorValue(left, query.sort);
    const rightValue = cursorValue(right, query.sort);
    let compared: number;

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        compared = leftValue - rightValue;
    }
    else {
        const a = String(leftValue);
        const b = String(rightValue);

        compared = a < b ? -1 : a > b ? 1 : 0;
    }

    if (compared === 0) {
        compared = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }

    return query.order === 'asc' ? compared : -compared;
}

/** 当前作品在本相册的本地分P（按 page_index 升序，且仍满足当前列表筛选） */
function collectSiblingPages(
    db: AlbumDatabase,
    illustId: string,
    query: AssetFilterQuery,
): typeof assets.$inferSelect[] {
    return db
        .select({ item: assets, pageIndex: pixivAssetLinks.pageIndex })
        .from(pixivAssetLinks)
        .innerJoin(assets, eq(assets.id, pixivAssetLinks.assetId))
        .where(and(...buildAssetClauses(db, query), eq(pixivAssetLinks.illustId, illustId)))
        .orderBy(asc(pixivAssetLinks.pageIndex), asc(assets.id))
        .all()
        .map(row => row.item);
}

/**
 * 查看器的上一张/下一张：
 * - 同一 Pixiv 作品的本地分P按页码连续，不因列表排序（入库时间/文件名等）被拆散；
 * - 跨作品时回到当前列表的顺序，分P组的第一个/最后一个对应组前后一个列表项。
 */
export function assetNeighbors(
    db: AlbumDatabase,
    assetId: string,
    query: AssetFilterQuery,
    span = 1,
): AssetNeighbors {
    const current = getAssetRow(db, assetId);
    const radius = Math.max(1, Math.min(500, span));
    const link = db
        .select({ illustId: pixivAssetLinks.illustId })
        .from(pixivAssetLinks)
        .where(eq(pixivAssetLinks.assetId, assetId))
        .get();
    const siblings = link
        ? collectSiblingPages(db, link.illustId, query)
        : [];
    const currentIndex = siblings.findIndex(item => item.id === assetId);

    if (currentIndex > 0 || (currentIndex === 0 && siblings.length > 1)) {
        const siblingIds = siblings.map(item => item.id);
        // 分P按页码播放，但跨越列表组边界必须锚定“列表顺序”的首尾，
        // 否则补下载/改名导致分P在列表中不相邻时会跳进组内部
        const listFirst = siblings.reduce((left, right) => (
            compareListOrder(left, right, query) <= 0 ? left : right
        ));
        const listLast = siblings.reduce((left, right) => (
            compareListOrder(left, right, query) >= 0 ? left : right
        ));
        const nextItems = siblings.slice(currentIndex + 1);
        const previousItems = siblings.slice(0, currentIndex).reverse();

        if (nextItems.length < radius) {
            nextItems.push(...neighborRows(
                db,
                listLast,
                query,
                'next',
                radius - nextItems.length,
                siblingIds,
            ));
        }
        if (previousItems.length < radius) {
            previousItems.push(...neighborRows(
                db,
                listFirst,
                query,
                'previous',
                radius - previousItems.length,
                siblingIds,
            ));
        }

        const beforeGroup = countNeighbors(db, listFirst, query, 'previous', siblingIds);
        // index/total 保持“实际图片数”语义；分P组只影响相邻关系，不折叠计数
        const total = countFiltered(db, query);

        return {
            previous: previousItems[0] ? toAssetSummary(previousItems[0]) : null,
            next: nextItems[0] ? toAssetSummary(nextItems[0]) : null,
            previousItems: previousItems.map(toAssetSummary),
            nextItems: nextItems.map(toAssetSummary),
            index: beforeGroup + currentIndex,
            total,
        };
    }

    const nextRows = neighborRows(db, current, query, 'next', radius);
    const previousRows = neighborRows(db, current, query, 'previous', radius);
    const previousItems = previousRows.map(toAssetSummary);

    return {
        previous: previousItems[0] ?? null,
        next: nextRows[0] ? toAssetSummary(nextRows[0]) : null,
        previousItems,
        nextItems: nextRows.map(toAssetSummary),
        index: countNeighbors(db, current, query, 'previous'),
        total: countFiltered(db, query),
    };
}

const ILLEGAL_FILENAME = /[<>:"/\\|?*]/;
const MAX_FILENAME = 200;
// Windows 保留设备名（大小写不敏感，带扩展名也算）；这些文件名导出/落盘会失败或行为异常
const RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function hasControlChar(value: string): boolean {
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;

        if (code < 32) {
            return true;
        }
    }

    return false;
}

function normalizeFilename(filename: string, ext: string): string {
    const trimmed = filename.trim();
    // 结尾的点与空格会被 Windows 静默剥离，导出比对时变成 missing；一并拒绝
    const reserved = trimmed.split('.')[0] ?? '';

    if (
        trimmed.length === 0
        || trimmed.length > MAX_FILENAME
        || ILLEGAL_FILENAME.test(trimmed)
        || hasControlChar(trimmed)
        || /[. ]$/u.test(trimmed)
        || RESERVED_BASENAME.test(reserved)
    ) {
        throw new ApiError(422, 'validation_failed', 'The filename is not valid.');
    }

    if (ext === '') {
        return trimmed;
    }

    const suffix = `.${ext}`;

    return trimmed.toLowerCase().endsWith(suffix.toLowerCase()) ? trimmed : `${trimmed}${suffix}`;
}

/** 重命名只改展示用的文件名，不动存储键与扩展名（扩展名跟随原文件，避免 MIME 与解码不一致） */
export function updateAsset(
    db: AlbumDatabase,
    assetId: string,
    patch: { filename?: string, favorite?: boolean },
): AssetSummaryDto {
    const row = getAssetRow(db, assetId);
    const values: { filename?: string, favorite?: number } = {};

    if (patch.filename !== undefined) {
        values.filename = normalizeFilename(patch.filename, row.ext);
    }
    if (patch.favorite !== undefined) {
        values.favorite = patch.favorite ? 1 : 0;
    }

    if (Object.keys(values).length > 0) {
        db.update(assets).set(values).where(eq(assets.id, assetId)).run();
    }

    return toAssetSummary(getAssetRow(db, assetId));
}

export interface BatchRenameInput {
    ids: string[]
    prefix: string
    start: number
    padding: number
}

/** 批量重命名：按传入顺序编号，前缀 + 序号，扩展名各自保留 */
export function renameAssetsBatch(db: AlbumDatabase, input: BatchRenameInput): AssetSummaryDto[] {
    const rows = db.select().from(assets).where(inArray(assets.id, input.ids)).all();
    const byId = new Map(rows.map(row => [row.id, row]));
    const ordered = input.ids.flatMap((id) => {
        const row = byId.get(id);

        return row ? [row] : [];
    });

    if (ordered.length === 0) {
        throw new ApiError(404, 'asset_not_found', 'None of the assets exist.');
    }

    const prefix = input.prefix.trim();

    if (prefix.length > 80) {
        throw new ApiError(422, 'validation_failed', 'The rename prefix is too long.');
    }

    // 先在事务外算好并校验每个新文件名：normalizeFilename 抛错时不会有半提交
    const planned = ordered.map((row, index) => {
        const number = String(input.start + index).padStart(input.padding, '0');

        return { row, filename: normalizeFilename(`${prefix}${number}`, row.ext) };
    });

    db.transaction((tx) => {
        for (const { row, filename } of planned) {
            tx.update(assets).set({ filename }).where(eq(assets.id, row.id)).run();
        }
    });

    // 用内存里已知的行推导返回摘要，省掉 N 次 getAssetRow 回读
    return planned.map(({ row, filename }) => toAssetSummary({ ...row, filename }));
}

export function getAssetRow(db: AlbumDatabase, assetId: string): typeof assets.$inferSelect {
    const row = db.select().from(assets).where(eq(assets.id, assetId)).get();

    if (!row) {
        throw new ApiError(404, 'asset_not_found', 'The requested media does not exist.');
    }

    return row;
}

export function assetTagsFor(db: AlbumDatabase, context: AlbumContext, assetId: string): TagRecord[] {
    const ids = db
        .select({ tagId: assetTags.tagId })
        .from(assetTags)
        .where(eq(assetTags.assetId, assetId))
        .all()
        .map(row => row.tagId);

    if (ids.length === 0) {
        return [];
    }

    const wanted = new Set(ids);

    return listTagRecords(context.db.tags).filter(tag => wanted.has(tag.id));
}

export interface LivePhotoMeta {
    storageKey: string
    mime: string
    size: number
}

function storageObjectMeta(meta: Record<string, unknown>, key: 'live' | 'preview'): LivePhotoMeta | null {
    const value = meta[key];

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;

    return typeof record.storageKey === 'string'
      && typeof record.mime === 'string'
      && typeof record.size === 'number'
        ? { storageKey: record.storageKey, mime: record.mime, size: record.size }
        : null;
}

/** meta.live 只由导入流程写入；缺失或字段不完整时视为普通静态图 */
export function livePhotoMeta(row: { meta: string }): LivePhotoMeta | null {
    return storageObjectMeta(parseMeta(row.meta), 'live');
}

/** HEIC/RAW 的 JPEG 预览对象 */
export function previewMeta(row: { meta: string }): LivePhotoMeta | null {
    return storageObjectMeta(parseMeta(row.meta), 'preview');
}

export function getAssetDetail(db: AlbumDatabase, context: AlbumContext, assetId: string): AssetDetailDto {
    const row = getAssetRow(db, assetId);
    const meta = parseMeta(row.meta);
    const live = livePhotoMeta(row);
    const preview = previewMeta(row);

    return {
        ...toAssetSummary(row),
        storageKey: row.storageKey,
        sha256: row.sha256,
        phash: row.phash,
        live: live ? { mime: live.mime, size: live.size } : null,
        preview: preview ? { mime: preview.mime, size: preview.size } : null,
        meta,
        tags: assetTagsFor(db, context, assetId),
    };
}

/**
 * 默认移入回收站（只标记 deleted_at，文件与缩略图保留），
 * `purge: true` 才真正删除存储文件、缩略图与数据库行。
 */
export async function deleteAsset(
    settings: Settings,
    albumId: string,
    assetId: string,
    options: { purge?: boolean } = {},
): Promise<void> {
    const context = getAlbum(settings, albumId);
    const row = getAssetRow(context.db.album, assetId);

    if (!options.purge) {
        context.db.album
            .update(assets)
            .set({ deletedAt: nowSeconds() })
            .where(eq(assets.id, assetId))
            .run();
        // 资产已移入回收站，重复副本记录不再展示
        context.db.album.delete(duplicateFiles).where(eq(duplicateFiles.assetId, assetId)).run();
        clearLocalPixivPageCache();
        reconcileAlbum(settings, context);

        return;
    }

    // 永久删除只允许作用于回收站资产，避免误用 /trash 端点直接删掉正常照片
    if (!row.deletedAt) {
        throw new ApiError(409, 'asset_not_in_trash', 'Only assets in the trash can be permanently deleted.');
    }

    const storage = storageForAlbum(context.dir, settings);
    const thumbStore = createThumbStore(context.db.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);
    const live = livePhotoMeta(row);
    const preview = previewMeta(row);

    // 先删数据库行：宁可因文件删除失败留下孤儿文件（可后续清扫），
    // 也不要文件已消失却残留指向它的僵尸记录。
    context.db.album.delete(assets).where(eq(assets.id, assetId)).run();
    thumbStore.deleteAsset(assetId);

    try {
        await storage.delete(row.storageKey);

        if (live) {
            await storage.delete(live.storageKey).catch(() => undefined);
        }
        if (preview) {
            await storage.delete(preview.storageKey).catch(() => undefined);
        }
    }
    catch (error) {
        logger.warn({ err: error, assetId }, 'storage file delete failed, orphan may remain');
    }

    clearLocalPixivPageCache();
    reconcileAlbum(settings, context);
}

export function restoreAsset(settings: Settings, albumId: string, assetId: string): void {
    const context = getAlbum(settings, albumId);

    getAssetRow(context.db.album, assetId);
    context.db.album
        .update(assets)
        .set({ deletedAt: null })
        .where(eq(assets.id, assetId))
        .run();
    clearLocalPixivPageCache();
    reconcileAlbum(settings, context);
}

/** 批量软删除：一个事务改多行，最后只对账一次 */
export function deleteAssetsBatch(settings: Settings, albumId: string, ids: string[]): number {
    const unique = [...new Set(ids)];

    if (unique.length === 0) {
        return 0;
    }

    const context = getAlbum(settings, albumId);
    const now = nowSeconds();
    const removed = context.db.album.transaction((tx) => {
        const result = tx
            .update(assets)
            .set({ deletedAt: now })
            .where(and(inArray(assets.id, unique), isNull(assets.deletedAt)))
            .run();

        tx.delete(duplicateFiles).where(inArray(duplicateFiles.assetId, unique)).run();

        return Number(result.changes ?? 0);
    });

    clearLocalPixivPageCache();
    reconcileAlbum(settings, context);

    return removed;
}

export function restoreAssetsBatch(settings: Settings, albumId: string, ids: string[]): number {
    const unique = [...new Set(ids)];

    if (unique.length === 0) {
        return 0;
    }

    const context = getAlbum(settings, albumId);
    const restored = context.db.album
        .update(assets)
        .set({ deletedAt: null })
        .where(and(inArray(assets.id, unique), isNotNull(assets.deletedAt)))
        .run();

    clearLocalPixivPageCache();
    reconcileAlbum(settings, context);

    return Number(restored.changes ?? 0);
}

export interface PurgeResult {
    removed: number
    failed: number
}

/**
 * 永久删除回收站资产。长任务持有数据库租约，避免空闲巡检在中途关闭连接；
 * 单个文件失败只计入 failed，不中断其余资产。
 */
export async function purgeTrash(
    settings: Settings,
    albumId: string,
    ids?: string[],
): Promise<PurgeResult> {
    const context = getAlbum(settings, albumId);
    const lease = leaseAlbumDatabase(context.dir);
    const db = lease.handle.album;
    const filter = ids && ids.length > 0
        ? and(isNotNull(assets.deletedAt), inArray(assets.id, [...new Set(ids)]))
        : isNotNull(assets.deletedAt);

    try {
        const rows = db.select().from(assets).where(filter).all();
        const storage = storageForAlbum(context.dir, settings);
        const thumbStore = createThumbStore(context.db.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);
        let removed = 0;
        let failed = 0;

        for (const row of rows) {
            const live = livePhotoMeta(row);
            const preview = previewMeta(row);

            // 先删数据库行，删行失败才算失败并跳过；文件删除失败只记 warning，
            // 宁可留下可清扫的孤儿文件，也不留指向已删文件的僵尸记录
            try {
                db.delete(assets).where(eq(assets.id, row.id)).run();
            }
            catch (error) {
                logger.warn({ err: error, assetId: row.id }, 'failed to remove asset row');
                failed += 1;

                continue;
            }

            thumbStore.deleteAsset(row.id);

            try {
                await storage.delete(row.storageKey);

                if (live) {
                    await storage.delete(live.storageKey).catch(() => undefined);
                }
                if (preview) {
                    await storage.delete(preview.storageKey).catch(() => undefined);
                }
            }
            catch (error) {
                logger.warn({ err: error, assetId: row.id }, 'storage file delete failed, orphan may remain');
            }

            removed += 1;
        }

        // 永久删除后映射已级联清理；同步裁掉不再被引用的 Pixiv 详情/断点
        pruneAlbumPixivData(db, lease.handle.pixiv);
        clearLocalPixivPageCache();
        reconcileAlbum(settings, context);

        return { removed, failed };
    }
    finally {
        lease.release();
    }
}

export function linkTag(db: AlbumDatabase, assetId: string, tagId: string): void {
    getAssetRow(db, assetId);
    db.insert(assetTags)
        .values({ assetId, tagId })
        .onConflictDoNothing()
        .run();
}

/** 批量建立资产-标签关联，重复组合直接跳过，返回新增关联数 */
export function linkTagsBatch(db: AlbumDatabase, assetIds: string[], tagIds: string[]): number {
    const assetList = [...new Set(assetIds)];
    const tagList = [...new Set(tagIds)];

    if (assetList.length === 0 || tagList.length === 0) {
        return 0;
    }

    const values = assetList.flatMap(assetId => tagList.map(tagId => ({ assetId, tagId })));

    return db.transaction((tx) => {
        let linked = 0;
        // 多值批量插入把 500×100=5 万条从「一条一语句」压到几百条；
        // 每批 500 行 × 3 绑定参数，远低于 SQLite 变量上限
        const BATCH = 500;

        for (let index = 0; index < values.length; index += BATCH) {
            const result = tx
                .insert(assetTags)
                .values(values.slice(index, index + BATCH))
                .onConflictDoNothing()
                .run();

            linked += Number(result.changes ?? 0);
        }

        return linked;
    });
}

export function unlinkTag(db: AlbumDatabase, assetId: string, tagId: string): void {
    getAssetRow(db, assetId);
    db.delete(assetTags)
        .where(and(eq(assetTags.assetId, assetId), eq(assetTags.tagId, tagId)))
        .run();
}
