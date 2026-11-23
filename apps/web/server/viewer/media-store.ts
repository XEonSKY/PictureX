import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { GlobalDatabase } from '../database/global';
import { viewerMedia, viewerMediaTags } from '../database/schemas/global';
import type { ViewerMediaRow } from '../database/schemas/global';
import type { LibraryMediaPage } from '../../shared/library';
import { ApiError } from '../hono/problem';
import { knownGlobalTagIds } from './global-tags';
import { nowSeconds, toIsoRequired, toSeconds } from '../utils/time';

/**
 * 查看器媒体记录：一律以内容 SHA-256 为标识，绝不按路径关联（路径随时可能变）。
 * 打开一张图片/视频时 upsert 一条记录，标签关联存在 viewer_media_tags。
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

export interface RegisterMediaInput {
    sha256: string
    kind: string
    mime: string
    filename: string
    lastPath?: string | null
    size: number
    width?: number | null
    height?: number | null
    durationMs?: number | null
}

function assertSha256(sha256: string): void {
    if (!SHA256_PATTERN.test(sha256)) {
        throw new ApiError(422, 'validation_failed', 'sha256 must be a 64-char hex digest.');
    }
}

export function registerViewerMedia(db: GlobalDatabase, input: RegisterMediaInput): ViewerMediaRow {
    assertSha256(input.sha256);

    const now = nowSeconds();

    db.insert(viewerMedia)
        .values({
            sha256: input.sha256,
            kind: input.kind,
            mime: input.mime,
            filename: input.filename,
            lastPath: input.lastPath ?? null,
            size: input.size,
            width: input.width ?? null,
            height: input.height ?? null,
            durationMs: input.durationMs ?? null,
            addedAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: viewerMedia.sha256,
            set: {
                kind: input.kind,
                mime: input.mime,
                filename: input.filename,
                lastPath: input.lastPath ?? null,
                size: input.size,
                width: input.width ?? null,
                height: input.height ?? null,
                durationMs: input.durationMs ?? null,
                updatedAt: now,
            },
        })
        .run();

    const row = db.select().from(viewerMedia).where(eq(viewerMedia.sha256, input.sha256)).get();

    if (!row) {
        throw new ApiError(500, 'internal_error', 'Failed to register viewer media.');
    }

    return row;
}

export function tagIdsForMedia(db: GlobalDatabase, sha256: string): string[] {
    return db
        .select({ tagId: viewerMediaTags.tagId })
        .from(viewerMediaTags)
        .where(eq(viewerMediaTags.sha256, sha256))
        .all()
        .map(row => row.tagId);
}

export function getViewerMedia(db: GlobalDatabase, sha256: string): { media: ViewerMediaRow, tagIds: string[] } | null {
    const media = db.select().from(viewerMedia).where(eq(viewerMedia.sha256, sha256)).get();

    if (!media) {
        return null;
    }

    return { media, tagIds: tagIdsForMedia(db, sha256) };
}

export interface ViewerMediaQuery {
    limit: number
    cursor?: string
    tagId?: string
}

function encodeCursor(addedAt: number, sha256: string): string {
    return Buffer.from(JSON.stringify([addedAt, sha256]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { addedAt: number, sha256: string } {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

        if (Array.isArray(parsed) && typeof parsed[1] === 'string') {
            const addedAt = typeof parsed[0] === 'number'
                ? Math.floor(parsed[0])
                : toSeconds(parsed[0] as string | null);

            if (addedAt !== null) {
                return { addedAt, sha256: parsed[1] };
            }
        }
    }
    catch {
        // fallthrough
    }

    throw new ApiError(422, 'validation_failed', 'Invalid pagination cursor.');
}

/** 全局图库列表：按键集分页，标签/Pixiv 过滤与总数在同一条件集下计算 */
export function listViewerMedia(db: GlobalDatabase, query: ViewerMediaQuery): LibraryMediaPage {
    const filters: SQL[] = [];

    if (query.tagId) {
        filters.push(inArray(
            viewerMedia.sha256,
            db.select({ sha256: viewerMediaTags.sha256 })
                .from(viewerMediaTags)
                .where(eq(viewerMediaTags.tagId, query.tagId)),
        ));
    }

    const pageClauses = [...filters];

    if (query.cursor) {
        const cursor = decodeCursor(query.cursor);

        pageClauses.push(sql`(${viewerMedia.addedAt}, ${viewerMedia.sha256}) < (${cursor.addedAt}, ${cursor.sha256})`);
    }

    const pageWhere = pageClauses.length > 0 ? and(...pageClauses) : undefined;
    const filterWhere = filters.length > 0 ? and(...filters) : undefined;
    const rows = db
        .select()
        .from(viewerMedia)
        .where(pageWhere)
        .orderBy(desc(viewerMedia.addedAt), desc(viewerMedia.sha256))
        .limit(query.limit + 1)
        .all();
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const totalRow = db
        .select({ total: sql<number>`count(*)` })
        .from(viewerMedia)
        .where(filterWhere)
        .get();
    const links = visible.length > 0
        ? db
            .select()
            .from(viewerMediaTags)
            .where(inArray(viewerMediaTags.sha256, visible.map(row => row.sha256)))
            .all()
        : [];
    const tagsBySha = new Map<string, string[]>();

    for (const link of links) {
        const bucket = tagsBySha.get(link.sha256) ?? [];

        bucket.push(link.tagId);
        tagsBySha.set(link.sha256, bucket);
    }

    const last = visible[visible.length - 1];

    return {
        data: visible.map(row => ({
            sha256: row.sha256,
            kind: row.kind,
            mime: row.mime,
            filename: row.filename,
            size: row.size,
            width: row.width,
            height: row.height,
            durationMs: row.durationMs,
            addedAt: toIsoRequired(row.addedAt),
            tagIds: tagsBySha.get(row.sha256) ?? [],
        })),
        total: Number(totalRow?.total ?? 0),
        pagination: {
            limit: query.limit,
            nextCursor: hasMore && last ? encodeCursor(last.addedAt, last.sha256) : null,
            hasMore,
        },
    };
}

/** 设置某张媒体的标签集合：只接受已知全局标签 id，整组替换 */
export function setViewerMediaTags(db: GlobalDatabase, sha256: string, tagIds: string[]): string[] {
    assertSha256(sha256);

    const unique = [...new Set(tagIds)];
    const known = knownGlobalTagIds();
    const unknown = unique.filter(id => !known.has(id));

    if (unknown.length > 0) {
        throw new ApiError(404, 'tag_not_found', 'One or more tags do not exist.');
    }

    const media = db.select({ sha256: viewerMedia.sha256 }).from(viewerMedia).where(eq(viewerMedia.sha256, sha256)).get();

    if (!media) {
        throw new ApiError(404, 'viewer_media_not_found', 'The requested viewer media does not exist.');
    }

    db.transaction((tx) => {
        tx.delete(viewerMediaTags).where(eq(viewerMediaTags.sha256, sha256)).run();

        if (unique.length > 0) {
            tx.insert(viewerMediaTags)
                .values(unique.map(tagId => ({ sha256, tagId })))
                .run();
        }
    });

    return unique;
}

/** 从全局库移除一张媒体的记录（连带标签关联）；不删磁盘文件 */
export function forgetViewerMedia(db: GlobalDatabase, sha256: string): void {
    assertSha256(sha256);

    db.delete(viewerMediaTags).where(eq(viewerMediaTags.sha256, sha256)).run();
    const removed = db.delete(viewerMedia).where(and(eq(viewerMedia.sha256, sha256))).run();

    if (Number(removed.changes ?? 0) === 0) {
        throw new ApiError(404, 'viewer_media_not_found', 'The requested viewer media does not exist.');
    }
}
