import { existsSync } from 'node:fs';
import { getSettings } from '../settings/setting-store';
import { getAlbum, listAlbumSummaries } from '../album/album-store';
import { leaseAlbumDatabase } from '../database/album';
import { pixivDatabase, writePixivIllustSnapshot } from '../database/pixiv';
import { ApiError } from '../hono/problem';
import { logger } from '../logger';
import { albumPictureDbPath } from '../utils/data-dir';
import { toIso, toSeconds } from '../utils/time';
import { fetchPixivIllust } from './api';
import { markGlobalPixivIllustInvalid, readGlobalPixivIllust, writeGlobalPixivIllust } from './global-cache';
import { parsePixivPages } from './pages';
import type { PixivIllust, PixivPage } from './types';

/**
 * 首页 Pixiv 资料库：直接读取 <dataDir>/data/pixiv.db，
 * 提供作品列表/筛选/详情/封面代理与单作品手动刷新。
 * 只做只读浏览与缓存维护，不下载分P、不修改任何原始图片。
 */

export type PixivLibraryStatus = 'all' | 'fetched' | 'placeholder' | 'invalid';
export type PixivLibrarySort = 'recent' | 'bookmarks' | 'views' | 'updated' | 'id';

export interface PixivLibraryQuery {
    q?: string
    status: PixivLibraryStatus
    type?: string
    userId?: string
    tagId?: string
    sort: PixivLibrarySort
    cursor?: string
    limit: number
}

export interface PixivLibraryItemDto {
    illustId: string
    title: string
    type: string
    userId: string
    userName: string
    userAccount: string
    pageCount: number
    width: number | null
    height: number | null
    xRestrict: number
    illustAiType: number
    createDate: string | null
    totalView: number
    totalBookmarks: number
    fetchedAt: string | null
    placeholder: boolean
    /** Pixiv 已返回 404（作品删除/不可见），不再参与后台同步 */
    invalid: boolean
    ugoira: boolean
    coverUrl: string | null
}

export interface PixivLibraryPageDto {
    data: PixivLibraryItemDto[]
    total: number
    pagination: {
        limit: number
        nextCursor: string | null
        hasMore: boolean
    }
}

export interface PixivLibraryTagDto {
    tagId: string
    name: string
    translatedName: string | null
    count: number
}

export interface PixivLibraryUserDto {
    userId: string
    name: string
    account: string
    count: number
}

export interface PixivLibraryTypeDto {
    type: string
    count: number
}

export interface PixivLibraryStatsDto {
    total: number
    fetched: number
    placeholder: number
    invalid: number
    ugoira: number
    users: number
    tags: number
    lastSyncedAt: string
    types: PixivLibraryTypeDto[]
    topTags: PixivLibraryTagDto[]
    topUsers: PixivLibraryUserDto[]
}

export interface PixivLibraryLocalAssetDto {
    albumId: string
    albumName: string
    assetId: string
    filename: string
    pageIndex: number
}

export interface PixivLibraryDetailDto {
    illustId: string
    placeholder: boolean
    invalid: boolean
    fetchedAt: string | null
    illust: PixivIllust | null
    locals: PixivLibraryLocalAssetDto[]
}

interface ListRow {
    illust_id: string
    title: string
    type: string
    user_id: string
    user_name: string | null
    user_account: string | null
    page_count: number
    width: number | null
    height: number | null
    x_restrict: number
    illust_ai_type: number
    create_date: number | null
    total_view: number
    total_bookmarks: number
    fetched_at: number
    invalid_at: number
    pages: string
    ugoira: string | null
    sort_value: number
}

const SORT_EXPRESSIONS: Record<PixivLibrarySort, string> = {
    recent: 'coalesce(i.create_date, 0)',
    bookmarks: 'i.total_bookmarks',
    views: 'i.total_view',
    updated: 'i.fetched_at',
    id: '0',
};

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/gu, match => `\\${match}`);
}

function coverUrl(illustId: string, pages: PixivPage[], fetchedAt: number): string | null {
    if (fetchedAt <= 0 || pages.length === 0) {
        return null;
    }

    const page = pages[0];
    const url = page?.urls.medium || page?.urls.squareMedium || page?.urls.large;

    if (!url) {
        return null;
    }

    return `/api/v1/pixiv/library/image?illustId=${encodeURIComponent(illustId)}&page=0&variant=medium`;
}

function rowToItem(row: ListRow): PixivLibraryItemDto {
    const pages = parsePixivPages(row.pages, row.page_count);

    return {
        illustId: row.illust_id,
        title: row.title,
        type: row.type,
        userId: row.user_id,
        userName: row.user_name ?? '',
        userAccount: row.user_account ?? '',
        pageCount: row.page_count,
        width: row.width,
        height: row.height,
        xRestrict: row.x_restrict,
        illustAiType: row.illust_ai_type,
        createDate: toIso(row.create_date),
        totalView: row.total_view,
        totalBookmarks: row.total_bookmarks,
        fetchedAt: toIso(row.fetched_at),
        placeholder: row.fetched_at <= 0,
        invalid: row.invalid_at > 0,
        ugoira: row.type === 'ugoira' || Boolean(row.ugoira),
        coverUrl: coverUrl(row.illust_id, pages, row.fetched_at),
    };
}

function encodeCursor(value: number, illustId: string): string {
    return Buffer.from(JSON.stringify({ v: value, i: illustId }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): { value: number, illustId: string } | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
            v?: unknown
            i?: unknown
        };

        if (typeof parsed.v !== 'number' || typeof parsed.i !== 'string' || parsed.i === '') {
            return null;
        }

        return { value: parsed.v, illustId: parsed.i };
    }
    catch {
        return null;
    }
}

interface WhereParts {
    sql: string
    params: unknown[]
}

function buildWhere(query: PixivLibraryQuery): WhereParts {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.status === 'fetched') {
        clauses.push('i.fetched_at > 0 AND i.invalid_at = 0');
    }
    else if (query.status === 'placeholder') {
        clauses.push('i.fetched_at = 0 AND i.invalid_at = 0');
    }
    else if (query.status === 'invalid') {
        clauses.push('i.invalid_at > 0');
    }

    if (query.type) {
        clauses.push('i.type = ?');
        params.push(query.type);
    }

    if (query.userId) {
        clauses.push('i.user_id = ?');
        params.push(query.userId);
    }

    if (query.tagId) {
        clauses.push('EXISTS (SELECT 1 FROM illust_tags it WHERE it.illust_id = i.illust_id AND it.tag_id = ?)');
        params.push(Number(query.tagId));
    }

    if (query.q) {
        const pattern = `%${escapeLike(query.q)}%`;

        clauses.push(`(
            i.title LIKE ? ESCAPE '\\'
            OR i.illust_id LIKE ? ESCAPE '\\'
            OR EXISTS (
                SELECT 1 FROM users u
                WHERE u.user_id = i.user_id
                  AND (u.name LIKE ? ESCAPE '\\' OR u.account LIKE ? ESCAPE '\\')
            )
            OR EXISTS (
                SELECT 1 FROM illust_tags it
                JOIN tags t ON t.tag_id = it.tag_id
                WHERE it.illust_id = i.illust_id
                  AND (t.name LIKE ? ESCAPE '\\' OR t.translated_name LIKE ? ESCAPE '\\')
            )
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }

    return {
        sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
        params,
    };
}

export function listPixivLibrary(query: PixivLibraryQuery): PixivLibraryPageDto {
    const client = pixivDatabase().$client;
    const where = buildWhere(query);
    const sortExpr = SORT_EXPRESSIONS[query.sort];
    const cursor = decodeCursor(query.cursor);
    const filterSql: string[] = [];
    const filterParams: unknown[] = [...where.params];

    if (cursor) {
        if (query.sort === 'id') {
            filterSql.push('i.illust_id < ?');
            filterParams.push(cursor.illustId);
        }
        else {
            filterSql.push(`(${sortExpr} < ? OR (${sortExpr} = ? AND i.illust_id < ?))`);
            filterParams.push(cursor.value, cursor.value, cursor.illustId);
        }
    }

    const sql = `
        SELECT
            i.illust_id, i.title, i.type, i.user_id,
            u.name AS user_name, u.account AS user_account,
            i.page_count, i.width, i.height, i.x_restrict, i.illust_ai_type,
            i.create_date, i.total_view, i.total_bookmarks, i.fetched_at, i.invalid_at, i.pages, i.ugoira,
            ${sortExpr} AS sort_value
        FROM illusts i
        LEFT JOIN users u ON u.user_id = i.user_id
        ${where.sql}
        ${filterSql.length > 0 ? `${where.sql ? 'AND' : 'WHERE'} ${filterSql.join(' AND ')}` : ''}
        ORDER BY ${query.sort === 'id' ? 'i.illust_id DESC' : `${sortExpr} DESC, i.illust_id DESC`}
        LIMIT ?
    `;
    const rows = client.prepare(sql).all(...filterParams, query.limit + 1) as ListRow[];
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const total = Number((client
        .prepare(`SELECT count(*) AS n FROM illusts i ${where.sql}`)
        .get(...where.params) as { n?: number } | undefined)?.n ?? 0);

    return {
        data: pageRows.map(rowToItem),
        total,
        pagination: {
            limit: query.limit,
            nextCursor: hasMore && last
                ? encodeCursor(query.sort === 'id' ? 0 : Number(last.sort_value), last.illust_id)
                : null,
            hasMore,
        },
    };
}

export function listPixivLibraryTags(limit = 24): PixivLibraryTagDto[] {
    const rows = pixivDatabase().$client.prepare(`
        SELECT t.tag_id, t.name, t.translated_name, count(*) AS count
        FROM tags t
        JOIN illust_tags it ON it.tag_id = t.tag_id
        GROUP BY t.tag_id
        ORDER BY count DESC, t.name ASC
        LIMIT ?
    `).all(limit) as { tag_id: number, name: string, translated_name: string | null, count: number }[];

    return rows.map(row => ({
        tagId: String(row.tag_id),
        name: row.name,
        translatedName: row.translated_name,
        count: Number(row.count),
    }));
}

export function listPixivLibraryUsers(limit = 24): PixivLibraryUserDto[] {
    const rows = pixivDatabase().$client.prepare(`
        SELECT i.user_id, coalesce(u.name, '') AS name, coalesce(u.account, '') AS account, count(*) AS count
        FROM illusts i
        LEFT JOIN users u ON u.user_id = i.user_id
        WHERE i.user_id <> ''
        GROUP BY i.user_id
        ORDER BY count DESC, name ASC
        LIMIT ?
    `).all(limit) as { user_id: string, name: string, account: string, count: number }[];

    return rows.map(row => ({
        userId: row.user_id,
        name: row.name,
        account: row.account,
        count: Number(row.count),
    }));
}

export function getPixivLibraryStats(): PixivLibraryStatsDto {
    const client = pixivDatabase().$client;
    const row = client.prepare(`
        SELECT
            count(*) AS total,
            coalesce(sum(CASE WHEN fetched_at > 0 AND invalid_at = 0 THEN 1 ELSE 0 END), 0) AS fetched,
            coalesce(sum(CASE WHEN fetched_at = 0 AND invalid_at = 0 THEN 1 ELSE 0 END), 0) AS placeholder,
            coalesce(sum(CASE WHEN invalid_at > 0 THEN 1 ELSE 0 END), 0) AS invalid,
            coalesce(sum(CASE WHEN type = 'ugoira' THEN 1 ELSE 0 END), 0) AS ugoira
        FROM illusts
    `).get() as { total: number, fetched: number, placeholder: number, invalid: number, ugoira: number };
    const users = Number((client.prepare('SELECT count(*) AS n FROM users').get() as { n?: number } | undefined)?.n ?? 0);
    const tags = Number((client.prepare('SELECT count(*) AS n FROM tags').get() as { n?: number } | undefined)?.n ?? 0);
    const lastSync = client.prepare("SELECT value FROM meta WHERE key = 'last_sync_at'").get() as { value?: string } | undefined;
    const types = client.prepare(`
        SELECT type, count(*) AS count FROM illusts GROUP BY type ORDER BY count DESC
    `).all() as { type: string, count: number }[];

    return {
        total: Number(row.total),
        fetched: Number(row.fetched),
        placeholder: Number(row.placeholder),
        invalid: Number(row.invalid),
        ugoira: Number(row.ugoira),
        users,
        tags,
        lastSyncedAt: toIso(toSeconds(lastSync?.value)) ?? '',
        types: types.map(item => ({ type: item.type, count: Number(item.count) })),
        topTags: listPixivLibraryTags(24),
        topUsers: listPixivLibraryUsers(24),
    };
}

function collectLocalAssets(illustId: string): PixivLibraryLocalAssetDto[] {
    const settings = getSettings();
    const albums = listAlbumSummaries(settings);
    const locals: PixivLibraryLocalAssetDto[] = [];

    for (const album of albums) {
        if (album.missing || album.corrupt || !existsSync(albumPictureDbPath(album.dir))) {
            continue;
        }

        let lease: ReturnType<typeof leaseAlbumDatabase>;

        try {
            lease = leaseAlbumDatabase(album.dir);
        }
        catch (error) {
            logger.warn({ err: error, albumId: album.id }, 'pixiv library could not open album');
            continue;
        }

        try {
            const rows = lease.handle.album.$client.prepare(`
                SELECT l.asset_id, l.page_index, coalesce(a.filename, '') AS filename
                FROM pixiv_asset_links l
                LEFT JOIN assets a ON a.id = l.asset_id
                WHERE l.illust_id = ? AND (a.deleted_at IS NULL OR a.id IS NULL)
                ORDER BY l.page_index ASC
                LIMIT 200
            `).all(illustId) as { asset_id: string, page_index: number, filename: string }[];

            for (const row of rows) {
                locals.push({
                    albumId: album.id,
                    albumName: album.name,
                    assetId: row.asset_id,
                    filename: row.filename,
                    pageIndex: row.page_index,
                });
            }
        }
        catch (error) {
            logger.warn({ err: error, albumId: album.id }, 'pixiv library could not read album links');
        }
        finally {
            lease.release();
        }
    }

    return locals;
}

export function getPixivLibraryDetail(illustId: string): PixivLibraryDetailDto | null {
    const client = pixivDatabase().$client;
    const row = client.prepare(`
        SELECT illust_id, fetched_at, invalid_at FROM illusts WHERE illust_id = ?
    `).get(illustId) as { illust_id: string, fetched_at: number, invalid_at: number } | undefined;

    if (!row) {
        return null;
    }

    const locals = collectLocalAssets(illustId);
    const invalid = row.invalid_at > 0;

    if (row.fetched_at <= 0) {
        return {
            illustId,
            placeholder: true,
            invalid,
            fetchedAt: null,
            illust: null,
            locals,
        };
    }

    const cached = readGlobalPixivIllust(illustId);

    if (!cached) {
        return {
            illustId,
            placeholder: true,
            invalid,
            fetchedAt: null,
            illust: null,
            locals,
        };
    }

    return {
        illustId,
        placeholder: false,
        invalid,
        fetchedAt: toIso(cached.fetchedAt),
        illust: cached.illust,
        locals,
    };
}

/**
 * 手动刷新是唯一会重试失效作品的入口：成功后同步所有引用该作品的相册副本，
 * 否则相册副本里的 invalid_at 会让自动补全继续永久跳过。
 */
function syncRefreshedIllustToAlbums(illust: PixivIllust): void {
    const settings = getSettings();

    for (const album of listAlbumSummaries(settings)) {
        if (!album.settings.pixivEnabled || album.missing || album.corrupt) {
            continue;
        }

        try {
            const context = getAlbum(settings, album.id);
            const exists = context.db.pixiv.$client
                .prepare('SELECT 1 AS present FROM illusts WHERE illust_id = ?')
                .get(illust.illustId);

            if (exists) {
                writePixivIllustSnapshot(context.db.pixiv.$client, illust);
            }
        }
        catch (error) {
            logger.warn({ err: error, albumId: album.id, illustId: illust.illustId }, 'failed to sync refreshed illust to album');
        }
    }
}

/** 从 Pixiv 手动刷新单个作品详情并写入全局库与引用它的相册副本 */
export async function refreshPixivLibraryIllust(illustId: string): Promise<PixivLibraryDetailDto | null> {
    try {
        const illust = await fetchPixivIllust(illustId);

        writeGlobalPixivIllust(illust);
        syncRefreshedIllustToAlbums(illust);

        return getPixivLibraryDetail(illust.illustId);
    }
    catch (error) {
        // 手动刷新是唯一会重试失效作品的入口：404 时记录失效并返回现状
        if (error instanceof ApiError && error.code === 'pixiv_illust_not_found') {
            markGlobalPixivIllustInvalid(illustId);

            return getPixivLibraryDetail(illustId);
        }

        throw error;
    }
}

export type PixivLibraryImageVariant = 'square' | 'medium' | 'large' | 'original';

/** 按作品 ID 从库内取图，绝不接受任意外部 URL（防 SSRF） */
export function resolvePixivLibraryImage(
    illustId: string,
    pageIndex: number,
    variant: PixivLibraryImageVariant,
): string | null {
    const row = pixivDatabase().$client.prepare(`
        SELECT pages, page_count, fetched_at FROM illusts WHERE illust_id = ?
    `).get(illustId) as { pages: string, page_count: number, fetched_at: number } | undefined;

    if (!row || row.fetched_at <= 0) {
        return null;
    }

    const pages = parsePixivPages(row.pages, row.page_count);
    const page = pages[Math.max(0, Math.min(pageIndex, pages.length - 1))];

    if (!page) {
        return null;
    }

    const urls = page.urls;
    const candidates = variant === 'square'
        ? [urls.squareMedium, urls.medium, urls.large]
        : variant === 'original'
            ? [urls.original, urls.large, urls.medium]
            : variant === 'large'
                ? [urls.large, urls.original, urls.medium]
                : [urls.medium, urls.large, urls.original];

    return candidates.find(url => url !== '') ?? null;
}
