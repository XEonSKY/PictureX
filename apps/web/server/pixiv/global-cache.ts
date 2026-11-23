import { eq, gte } from 'drizzle-orm';
import {
    listInvalidPixivIllustIds,
    markPixivIllustInvalid,
    pixivDatabase,
    readPixivIllustInvalidAt,
    writePixivIllustSnapshot,
    type PixivDatabase,
} from '../database/pixiv';
import { illusts, illustTags, pixivTags } from '../database/schemas/pixiv';
import { logger } from '../logger';
import { nowSeconds, toIso } from '../utils/time';
import { parsePixivPages } from './pages';
import type { PixivIllust, PixivTag, PixivUgoira } from './types';

/**
 * Pixiv 元数据缓存的读写（同构 5 表）。
 * 同一套函数既服务数据根的全局库，也服务相册的「按相册裁剪副本」<album>/data/pixiv.db。
 */

export interface GlobalCachedIllust {
    illust: PixivIllust
    fetchedAt: number
    /** >0 表示 Pixiv 已确认作品不可用 */
    invalidAt: number
}

function parseUgoira(raw: string | null): PixivUgoira | null {
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as PixivUgoira;
    }
    catch {
        return null;
    }
}

export interface IllustRowLike {
    illustId: string
    userId: string
    title: string
    type: string
    caption: string
    pageCount: number
    width: number | null
    height: number | null
    xRestrict: number
    sanityLevel: number
    illustAiType: number
    createDate: number | null
    totalView: number
    totalBookmarks: number
    pages: string
    ugoira: string | null
}

/** 同构 5 表的行 → 领域对象；全局库与相册副本共用，避免两处各写一份转换 */
export function buildPixivIllust(
    row: IllustRowLike,
    user: { name: string, account: string } | undefined,
    tags: PixivTag[],
): PixivIllust {
    return {
        illustId: row.illustId,
        title: row.title,
        type: row.type,
        caption: row.caption,
        userId: row.userId,
        userName: user?.name ?? '',
        userAccount: user?.account ?? '',
        pageCount: row.pageCount,
        width: row.width,
        height: row.height,
        xRestrict: row.xRestrict,
        sanityLevel: row.sanityLevel,
        illustAiType: row.illustAiType,
        createDate: toIso(row.createDate),
        totalView: row.totalView,
        totalBookmarks: row.totalBookmarks,
        tags,
        pages: parsePixivPages(row.pages, row.pageCount),
        ugoira: parseUgoira(row.ugoira),
    };
}

export function readPixivIllust(db: PixivDatabase, illustId: string): GlobalCachedIllust | null {
    const row = db
        .select()
        .from(illusts)
        .where(eq(illusts.illustId, illustId))
        .get();

    // 占位行只有 ID，视为没有缓存，交由补全流程处理
    if (!row || row.fetchedAt <= 0) {
        return null;
    }

    const user = row.userId === ''
        ? null
        : db.$client
            .prepare('SELECT name, account FROM users WHERE user_id = ?')
            .get(row.userId) as { name: string, account: string } | undefined;
    const tagRows = db
        .select({ name: pixivTags.name, translatedName: pixivTags.translatedName })
        .from(illustTags)
        .innerJoin(pixivTags, eq(illustTags.tagId, pixivTags.tagId))
        .where(eq(illustTags.illustId, illustId))
        .orderBy(illustTags.sortOrder)
        .all();
    const tags: PixivTag[] = tagRows.map(tag => ({
        name: tag.name,
        translatedName: tag.translatedName,
    }));

    return {
        illust: buildPixivIllust(row, user ?? undefined, tags),
        fetchedAt: row.fetchedAt,
        invalidAt: row.invalidAt,
    };
}

export function readGlobalPixivIllust(illustId: string): GlobalCachedIllust | null {
    try {
        return readPixivIllust(pixivDatabase(), illustId);
    }
    catch (error) {
        logger.warn({ err: error, illustId }, 'failed to read global pixiv cache');

        return null;
    }
}

/** 一次查出缓存期内的作品 ID，供后台补全批量预筛选，避免逐作品查询 */
export function listFreshPixivIllustIds(db: PixivDatabase, cutoffSeconds: number): Set<string> {
    return new Set(db
        .select({ illustId: illusts.illustId })
        .from(illusts)
        .where(gte(illusts.fetchedAt, cutoffSeconds))
        .all()
        .map(row => row.illustId));
}

export function listGlobalInvalidPixivIllustIds(): Set<string> {
    try {
        return listInvalidPixivIllustIds(pixivDatabase().$client);
    }
    catch (error) {
        logger.warn({ err: error }, 'failed to list invalid global pixiv works');

        return new Set();
    }
}

export function readGlobalPixivIllustInvalidAt(illustId: string): number {
    try {
        return readPixivIllustInvalidAt(pixivDatabase().$client, illustId);
    }
    catch {
        return 0;
    }
}

/** 记录全局库中已失效的作品；相册副本由调用方按需写 */
export function markGlobalPixivIllustInvalid(
    illustId: string,
    invalidAt: number = nowSeconds(),
): void {
    try {
        markPixivIllustInvalid(pixivDatabase().$client, illustId, invalidAt);
    }
    catch (error) {
        logger.warn({ err: error, illustId }, 'failed to mark global pixiv work invalid');
    }
}

export function listFreshGlobalPixivIllustIds(cutoffSeconds: number): Set<string> {
    try {
        return listFreshPixivIllustIds(pixivDatabase(), cutoffSeconds);
    }
    catch (error) {
        logger.warn({ err: error }, 'failed to list fresh global pixiv cache');

        return new Set();
    }
}

export function writeGlobalPixivIllust(illust: PixivIllust, fetchedAt = nowSeconds()): void {
    try {
        const client = pixivDatabase().$client;

        client.transaction(() => {
            writePixivIllustSnapshot(client, illust, fetchedAt);
        })();
    }
    catch (error) {
        logger.warn({ err: error, illustId: illust.illustId }, 'failed to write global pixiv cache');
    }
}
