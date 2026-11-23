import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import pLimit from 'p-limit';
import { getAlbum, reconcileAlbum, type AlbumContext } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import { assets } from '../database/schemas/album';
import { markPixivIllustInvalid, readPixivIllustInvalidAt } from '../database/pixiv';
import { getAssetRow, parseMeta } from '../domain/asset-query';
import { ApiError } from '../hono/problem';
import { storeNewAsset } from '../ingest/store-asset';
import type { Settings } from '../settings/setting-schema';
import { describeDataDirectories } from '../utils/data-dir';
import { sha256FileAccelerated } from '../utils/hash-pool';
import { KeyedMutex } from '../utils/keyed-mutex';
import { fetchPixivIllust, PixivRateLimitError } from './api';
import { markGlobalPixivIllustInvalid, readGlobalPixivIllust, readGlobalPixivIllustInvalidAt, writeGlobalPixivIllust } from './global-cache';
import { assertPixivImageUrl, pixivDownloadToFile } from './http';
import {
    collectLocalPages,
    findAssetBySha,
    getCachedIllust,
    linkPixivAsset,
    pixivRefForAsset,
    upsertIllust,
} from './store';
import type {
    AssetPixivContextDto,
    PixivIllust,
    PixivLocalPage,
    PixivPage,
} from './types';

export const PIXIV_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = 2;
const syncLocks = new KeyedMutex();
const ugoiraLocks = new KeyedMutex();

function cacheRoot(): string {
    return join(describeDataDirectories().cacheDir, 'pixiv');
}

function assertEnabled(context: AlbumContext): void {
    if (!context.index.settings.pixivEnabled) {
        throw new ApiError(409, 'pixiv_disabled', 'Pixiv support is disabled for this album.');
    }
}

/** 把作品标题写进本地分P的 meta.pixiv，照片列表/查看器即可显示原名 */
function stampPixivTitles(db: AlbumDatabase, illust: PixivIllust, pages: PixivLocalPage[]): void {
    for (const page of pages) {
        const row = db
            .select({ meta: assets.meta })
            .from(assets)
            .where(eq(assets.id, page.assetId))
            .get();

        if (!row) {
            continue;
        }

        const meta = parseMeta(row.meta);
        const current = meta.pixiv && typeof meta.pixiv === 'object' && !Array.isArray(meta.pixiv)
            ? meta.pixiv as Record<string, unknown>
            : {};

        if (
            current.title === illust.title
            && current.pageCount === illust.pageCount
            && current.illustId === illust.illustId
            && current.pageIndex === page.index
        ) {
            continue;
        }

        meta.pixiv = {
            ...current,
            illustId: illust.illustId,
            pageIndex: page.index,
            title: illust.title,
            pageCount: illust.pageCount,
        };
        db.update(assets).set({ meta: JSON.stringify(meta) }).where(eq(assets.id, page.assetId)).run();
    }
}

function missingFor(illust: PixivIllust | null, localPages: PixivLocalPage[]): number[] {
    if (!illust) {
        return [];
    }

    const local = new Set(localPages.map(page => page.index));
    const indices = illust.pages.length > 0
        ? illust.pages.map(page => page.index)
        : Array.from({ length: Math.max(1, illust.pageCount) }, (_, index) => index);

    return indices.filter(index => !local.has(index)).sort((left, right) => left - right);
}

function pageUrl(illust: PixivIllust, pageIndex: number, quality: Settings['pixiv']['imageQuality']): string {
    const page = illust.pages.find(item => item.index === pageIndex);

    if (!page) {
        return '';
    }

    const urls = page.urls;
    const candidates = quality === 'original'
        ? [urls.original, urls.large, urls.medium]
        : quality === 'large'
            ? [urls.large, urls.original, urls.medium]
            : [urls.medium, urls.large, urls.original];

    return candidates.find(url => url !== '') ?? '';
}

function extensionFor(url: string): string {
    try {
        const ext = extname(new URL(url).pathname).slice(1).toLowerCase();

        return /^[a-z0-9]{2,5}$/u.test(ext) ? ext : 'jpg';
    }
    catch {
        return 'jpg';
    }
}

async function downloadPage(
    settings: Settings,
    context: AlbumContext,
    db: AlbumDatabase,
    illust: PixivIllust,
    page: PixivPage,
    dir: string,
): Promise<{ assetId: string | null }> {
    const url = pageUrl(illust, page.index, settings.pixiv.imageQuality);

    if (url === '') {
        return { assetId: null };
    }

    const ext = extensionFor(url);
    const filename = `${illust.illustId}_p${page.index}.${ext}`;
    const target = join(dir, filename);

    assertPixivImageUrl(url);
    mkdirSync(dir, { recursive: true });

    if (existsSync(target)) {
        await unlink(target).catch(() => undefined);
    }

    try {
        await pixivDownloadToFile(url, target);
    }
    catch (error) {
        // 原图不存在时回退到下一档（large → medium）
        const fallback = [page.urls.large, page.urls.medium]
            .filter(candidate => candidate !== '' && candidate !== url);

        for (const candidate of fallback) {
            try {
                assertPixivImageUrl(candidate);
                await pixivDownloadToFile(candidate, target);
                break;
            }
            catch {
                // 继续尝试下一档
            }
        }

        if (!existsSync(target)) {
            throw error;
        }
    }

    try {
        const size = statSync(target).size;
        const sha256 = await sha256FileAccelerated(target);
        const existing = findAssetBySha(db, sha256);

        if (existing) {
            if (existing.deletedAt !== null) {
                await unlink(target).catch(() => undefined);

                return { assetId: null };
            }

            // 该资产已绑定到本作品其它分P（两页字节相同）：无法再建第二条映射，
            // 如实报告该页失败，避免 UI 认为已补齐、下次又重复下载。
            const linked = linkPixivAsset(db, illust.illustId, page.index, existing.id);

            await unlink(target).catch(() => undefined);

            return { assetId: linked ? existing.id : null };
        }

        const stored = await storeNewAsset({
            settings,
            albumDir: context.dir,
            db,
            filePath: target,
            sha256,
            size,
            filename,
            meta: {
                pixiv: {
                    illustId: illust.illustId,
                    pageIndex: page.index,
                },
            },
        });

        if (!stored.assetId) {
            await unlink(target).catch(() => undefined);

            return { assetId: null };
        }

        linkPixivAsset(db, illust.illustId, page.index, stored.assetId);
        await unlink(target).catch(() => undefined);

        return { assetId: stored.assetId };
    }
    catch (error) {
        // 保留失败文件便于排查？这里直接清掉，避免缓存目录无限增长
        await unlink(target).catch(() => undefined);

        throw error;
    }
}

async function downloadMissingPages(
    settings: Settings,
    context: AlbumContext,
    db: AlbumDatabase,
    illust: PixivIllust,
    missing: number[],
): Promise<{ downloadedPages: number[], downloadErrors: number[] }> {
    const pages = illust.pages.filter(page => missing.includes(page.index));
    const dir = join(cacheRoot(), 'downloads', illust.illustId);
    const limit = pLimit(DOWNLOAD_CONCURRENCY);
    const downloadedPages: number[] = [];
    // 只有作品详情里带 URL 的分P 才能下载；占位详情（pages 为空）必须计入失败，
    // 否则 POST sync 会报成功但一个文件都没下载。
    const known = new Set(pages.map(page => page.index));
    const downloadErrors: number[] = missing.filter(index => !known.has(index));

    await Promise.all(pages.map(page => limit(async () => {
        try {
            const result = await downloadPage(settings, context, db, illust, page, dir);

            if (result.assetId) {
                downloadedPages.push(page.index);
            }
            else {
                downloadErrors.push(page.index);
            }
        }
        catch {
            downloadErrors.push(page.index);
        }
    })));

    try {
        reconcileAlbum(settings, context);
    }
    catch {
        // 对账失败不影响已下载的分P
    }

    return {
        downloadedPages: downloadedPages.sort((left, right) => left - right),
        downloadErrors: downloadErrors.sort((left, right) => left - right),
    };
}

export interface PixivContextOptions {
    /** 显式同步时允许下载缺失分P；GET 不传 */
    download?: boolean
    /** 忽略 7 天缓存 */
    force?: boolean
}

async function buildContext(
    settings: Settings,
    context: AlbumContext,
    assetId: string,
    options: PixivContextOptions,
): Promise<AssetPixivContextDto> {
    assertEnabled(context);

    const db = context.db.album;
    const asset = getAssetRow(db, assetId);
    const ref = pixivRefForAsset(db, asset);

    if (!ref) {
        return { pixiv: false };
    }

    let cached = getCachedIllust(context.db.pixiv, ref.illustId);
    const globalCached = readGlobalPixivIllust(ref.illustId);
    let illust = cached?.illust ?? globalCached?.illust ?? null;
    let authRequired = settings.pixiv.refreshToken === '';
    let stale = false;
    let loadedFromRemote = false;
    let invalid = Math.max(
        readPixivIllustInvalidAt(context.db.pixiv.$client, ref.illustId),
        readGlobalPixivIllustInvalidAt(ref.illustId),
    ) > 0;
    const fresh = cached !== null
      && cached.fetchedAt > 0
      && Date.now() - cached.fetchedAt * 1000 < PIXIV_CACHE_TTL_MS;
    const globalFresh = globalCached !== null
      && globalCached.fetchedAt > 0
      && Date.now() - globalCached.fetchedAt * 1000 < PIXIV_CACHE_TTL_MS;

    if (!options.force && !fresh && globalFresh && globalCached) {
        // 其它相册已拉取过：复用全局缓存，并回填本相册
        illust = globalCached.illust;
        upsertIllust(context.db.pixiv, illust);
    }
    else if ((!fresh || options.force === true) && !authRequired && !invalid) {
        try {
            illust = await fetchPixivIllust(ref.illustId);
            upsertIllust(context.db.pixiv, illust);
            writeGlobalPixivIllust(illust);
            cached = getCachedIllust(context.db.pixiv, ref.illustId);
            loadedFromRemote = true;
            invalid = false;
        }
        catch (error) {
            // 429 必须交给自动补全暂停并自动续跑；旧缓存不能把限流伪装成成功
            if (error instanceof PixivRateLimitError) {
                throw error;
            }

            if (error instanceof ApiError && error.code === 'pixiv_illust_not_found') {
                // 作品删除/不可见：记录到相册副本与全局库，后续请求不再自动联网
                const invalidAt = Math.floor(Date.now() / 1000);
                markPixivIllustInvalid(context.db.pixiv.$client, ref.illustId, invalidAt);
                markGlobalPixivIllustInvalid(ref.illustId, invalidAt);
                invalid = true;
                stale = cached !== null || globalCached !== null;
            }
            else if (error instanceof ApiError && (error.code === 'pixiv_auth_required' || error.code === 'pixiv_auth_failed')) {
                authRequired = true;
                stale = cached !== null || globalCached !== null;
            }
            else if (cached || globalCached) {
                stale = true;
            }
            else {
                throw error;
            }
        }
    }
    else if (fresh && cached && !globalFresh) {
        // 旧相册已有有效缓存，顺手补一份全局副本
        writeGlobalPixivIllust(cached.illust);
    }

    if (!loadedFromRemote && illust && !fresh && !globalFresh && !stale) {
        stale = true;
    }

    let localPages = collectLocalPages(db, ref.illustId);
    let downloadedPages: number[] = [];
    let downloadErrors: number[] = [];

    if (illust) {
        stampPixivTitles(db, illust, localPages);
    }

    if (options.download === true && illust && !authRequired && !invalid) {
        const missing = missingFor(illust, localPages);

        if (missing.length > 0) {
            const result = await downloadMissingPages(settings, context, db, illust, missing);

            downloadedPages = result.downloadedPages;
            downloadErrors = result.downloadErrors;
            localPages = collectLocalPages(db, ref.illustId);

            if (illust) {
                stampPixivTitles(db, illust, localPages);
            }
        }
    }

    return {
        pixiv: true,
        illustId: ref.illustId,
        pageIndex: ref.pageIndex,
        illust,
        localPages,
        missingPages: missingFor(illust, localPages),
        authRequired,
        invalid,
        stale,
        downloadedPages,
        downloadErrors,
    };
}

export async function getAssetPixivContext(
    settings: Settings,
    albumId: string,
    assetId: string,
    options: PixivContextOptions = {},
): Promise<AssetPixivContextDto> {
    const context = getAlbum(settings, albumId);

    assertEnabled(context);

    const db = context.db.album;
    const asset = getAssetRow(db, assetId);
    const ref = pixivRefForAsset(db, asset);

    if (!ref) {
        return { pixiv: false };
    }

    const lease = leaseAlbumDatabase(context.dir);

    try {
        const dto = options.download === true
            ? await syncLocks.run(ref.illustId, () => (
                // 临时目录/ugoira 缓存按 illustId 全局共享，跨相册也必须串行
                buildContext(settings, context, assetId, options)
            ))
            : await buildContext(settings, context, assetId, options);

        // 远端拉取的详情已直接写入全局 pixiv.db；这里不再触发整相册汇总，
        // 否则后台补全每处理一个作品都会重放数万行（标签页/打开相册时仍会合并汇总）。
        return dto;
    }
    finally {
        lease.release();
    }
}

function isZip(path: string): boolean {
    try {
        const fd = openSync(path, 'r');
        const head = Buffer.alloc(4);

        try {
            readSync(fd, head, 0, 4, 0);

            return head[0] === 0x50 && head[1] === 0x4b;
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return false;
    }
}

/** 确保 ugoira zip 在本地缓存；已缓存时即使未登录也直接复用。 */
export async function ensureUgoiraArchive(
    settings: Settings,
    albumId: string,
    assetId: string,
): Promise<{ path: string }> {
    const context = await getAssetPixivContext(settings, albumId, assetId);

    if (!context.pixiv) {
        throw new ApiError(404, 'pixiv_ugoira_unavailable', 'This asset is not a Pixiv illustration.');
    }
    if (!context.illust?.ugoira) {
        if (context.authRequired) {
            throw new ApiError(401, 'pixiv_auth_required', 'Pixiv login is required to load this ugoira.');
        }

        throw new ApiError(404, 'pixiv_ugoira_unavailable', 'This illustration has no ugoira archive.');
    }

    const target = join(cacheRoot(), 'ugoira', `${context.illustId}.zip`);
    const ugoira = context.illust.ugoira;

    // 同一作品只下载一次，避免两个查看器窗口共用 target.part 互相覆盖
    return ugoiraLocks.run(String(context.illustId), async () => {
        if (existsSync(target) && statSync(target).size > 4 && isZip(target)) {
            return { path: target };
        }

        mkdirSync(join(cacheRoot(), 'ugoira'), { recursive: true });
        await pixivDownloadToFile(ugoira.zipUrl, target);

        if (!isZip(target)) {
            await unlink(target).catch(() => undefined);

            throw new ApiError(502, 'pixiv_ugoira_unavailable', 'Pixiv returned an invalid ugoira archive.');
        }

        return { path: target };
    });
}
