import { and, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import pLimit from 'p-limit';
import { getAlbum, type AlbumContext } from '../album/album-store';
import { leaseAlbumDatabase, type AlbumDatabase } from '../database/album';
import { readMeta, writeMeta } from '../album/album-meta';
import {
    assets,
    similarGroupItems,
    similarGroups,
} from '../database/schemas/album';
import { logger } from '../logger';
import type { Settings } from '../settings/setting-schema';
import { getSettings } from '../settings/setting-store';
import { previewMeta } from '../domain/asset-query';
import { storageForAlbum } from '../storage/registry';
import { phashConcurrency } from '../utils/concurrency';
import { computePhash } from './phash';
import { groupSimilar, hammingDistance } from './similarity';

/**
 * 相似度索引：扫描只负责去重入库，pHash 与相似分组在这里后台补齐并落库。
 * `GET /albums/:albumId/groups/similar` 因此只读持久化分组，不再每次请求重算全库。
 */

export const META_SIMILARITY_INDEX = 'similarity_index';
const UNHASHABLE_KIND = 'video';

export interface SimilarityIndexMeta {
    threshold: number
    /** 参与分组的资产数（已有 phash） */
    phashedCount: number
    /** 相册资产总数，用于判断索引是否过期 */
    assetCount: number
    groups: number
    updatedAt: string
}

const inFlight = new Map<string, Promise<SimilarityIndexMeta>>();

function parseMeta(raw: string | null): SimilarityIndexMeta | null {
    if (!raw) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const record = parsed as Record<string, unknown>;

        return typeof record.threshold === 'number'
          && typeof record.phashedCount === 'number'
          && typeof record.assetCount === 'number'
            ? {
                threshold: record.threshold,
                phashedCount: record.phashedCount,
                assetCount: record.assetCount,
                groups: Number(record.groups ?? 0),
                updatedAt: String(record.updatedAt ?? ''),
            }
            : null;
    }
    catch {
        return null;
    }
}

export function readSimilarityIndexMeta(db: AlbumDatabase): SimilarityIndexMeta | null {
    return parseMeta(readMeta(db, META_SIMILARITY_INDEX));
}

function phashedCount(db: AlbumDatabase): number {
    return Number(
        db
            .select({ value: count() })
            .from(assets)
            .where(and(isNotNull(assets.phash), ne(assets.phash, ''), isNull(assets.deletedAt)))
            .get()?.value ?? 0,
    );
}

function totalAssets(db: AlbumDatabase): number {
    return Number(
        db.select({ value: count() }).from(assets).where(isNull(assets.deletedAt)).get()?.value ?? 0,
    );
}

function hashableAssets(db: AlbumDatabase): number {
    return Number(
        db
            .select({ value: count() })
            .from(assets)
            .where(and(ne(assets.kind, UNHASHABLE_KIND), isNull(assets.deletedAt)))
            .get()?.value ?? 0,
    );
}

/** 索引进度：已算 pHash 的资产 / 可计算 pHash 的资产总数（视频不参与，避免永远停在 <100%） */
export function similarityProgress(db: AlbumDatabase): { indexed: number, total: number } {
    return { indexed: phashedCount(db), total: hashableAssets(db) };
}

/** 还没算过 pHash 的资产；视频等无法抽帧的类型写空串占位，避免每次扫描都重复挑出来 */
export function pendingPhashCount(db: AlbumDatabase): number {
    return Number(
        db
            .select({ value: count() })
            .from(assets)
            .where(and(isNull(assets.phash), ne(assets.kind, UNHASHABLE_KIND), isNull(assets.deletedAt)))
            .get()?.value ?? 0,
    );
}

export function isSimilarityIndexFresh(db: AlbumDatabase, threshold: number): boolean {
    const meta = readSimilarityIndexMeta(db);

    if (!meta) {
        return false;
    }

    // 分组表与 meta 的组数不一致，说明上次写入在删除/分批插入之间中断，必须重建
    const groups = Number(
        db.select({ value: count() }).from(similarGroups).get()?.value ?? 0,
    );

    return meta.threshold === threshold
      && meta.assetCount === totalAssets(db)
      && meta.phashedCount === phashedCount(db)
      && meta.groups === groups;
}

async function fillPhashes(context: AlbumContext, settings: Settings): Promise<number> {
    const db = context.db.album;
    const storage = storageForAlbum(context.dir, settings);
    const limit = pLimit(phashConcurrency());
    // 按 rowid 分页，避免 10 万资产一次性读入内存；临时失败的行不会被本次重复尝试
    const selectBatch = db.$client.prepare(`
        SELECT rowid AS rid, id, storage_key AS storageKey, kind, meta
        FROM assets
        WHERE phash IS NULL AND deleted_at IS NULL AND rowid > ?
        ORDER BY rowid
        LIMIT 1000
    `);
    let lastRowid = 0;
    let computed = 0;

    for (;;) {
        const targets = selectBatch.all(lastRowid) as {
            rid: number
            id: string
            storageKey: string
            kind: string
            meta: string
        }[];

        if (targets.length === 0) {
            return computed;
        }

        lastRowid = targets[targets.length - 1]!.rid;

        await Promise.all(targets.map(target => limit(async () => {
            if (target.kind === UNHASHABLE_KIND) {
                // 视频不参与 pHash 分组，占位写空串，避免每次重建都挑出来
                db.update(assets).set({ phash: '' }).where(eq(assets.id, target.id)).run();

                return;
            }

            // HEIC/RAW 原图 sharp 不可读：优先使用导入时生成的 JPEG 预览
            const preview = previewMeta(target);
            const path = storage.localPath(preview?.storageKey ?? target.storageKey);

            if (!path) {
                db.update(assets).set({ phash: '' }).where(eq(assets.id, target.id)).run();

                return;
            }

            let phash: string | null = null;

            try {
                phash = (await computePhash(path)) ?? null;
            }
            catch (error) {
                logger.warn({ err: error, assetId: target.id }, 'failed to compute phash');
            }

            // 临时失败保持 null，下次重建会重试；写成空串会让该资产永不重算
            if (phash !== null) {
                db.update(assets).set({ phash }).where(eq(assets.id, target.id)).run();
                computed += 1;
            }
        })));
    }
}

function persistGroups(db: AlbumDatabase, threshold: number): number {
    const rows = db
        .select({ id: assets.id, phash: assets.phash })
        .from(assets)
        .where(and(
            isNotNull(assets.phash),
            sql`length(${assets.phash}) = 16`,
            isNull(assets.deletedAt),
        ))
        .all();
    const items = rows.flatMap(row => (row.phash ? [{ id: row.id, phash: row.phash }] : []));
    const groups = groupSimilar(items, threshold);
    const phashById = new Map(items.map(item => [item.id, item.phash]));

    const groupRows = groups.map(group => ({
        id: uuidv7(),
        threshold,
        representativeId: group.representativeId,
        itemCount: group.items.length,
        maxDistance: group.maxDistance,
    }));
    // 每组连同它的成员打包，便于按组分批提交，把单次写锁时长压短
    const plans = groups.map((group, index) => {
        const row = groupRows[index]!;
        const representative = phashById.get(group.representativeId) ?? '';

        const items = group.items.map(item => ({
            groupId: row.id,
            assetId: item.id,
            distance: representative === '' ? group.maxDistance : hammingDistance(item.phash, representative),
        }));

        return { row, items };
    });

    // 先让旧 meta 失效：删除与分批插入之间若进程崩溃，下一次读取会重建索引，
    // 而不是把“表已清空但旧 meta 计数仍匹配”误判为新鲜
    writeMeta(db, META_SIMILARITY_INDEX, '');

    // 删除旧索引单独一个短事务（外键级联清 similar_group_items）；
    // 插入按组分批提交，避免 10 万级成员挤在一个长事务里持写锁、撞 busy_timeout
    db.transaction(tx => tx.delete(similarGroups).run());

    const GROUP_BATCH = 200;
    const ITEM_BATCH = 4000; // 每行 3 个绑定参数，留足 SQLite 变量上限余量
    let chunk: typeof plans = [];
    let chunkItems = 0;

    const flush = (): void => {
        if (chunk.length === 0) {
            return;
        }

        db.transaction((tx) => {
            tx.insert(similarGroups).values(chunk.map(plan => plan.row)).run();

            const itemRows = chunk.flatMap(plan => plan.items);

            if (itemRows.length > 0) {
                tx.insert(similarGroupItems).values(itemRows).run();
            }
        });

        chunk = [];
        chunkItems = 0;
    };

    for (const plan of plans) {
        // 单组成员可能上千，不能只按组数分批，否则一条 INSERT 会超过变量上限
        if (chunk.length >= GROUP_BATCH || (chunk.length > 0 && chunkItems + plan.items.length > ITEM_BATCH)) {
            flush();
        }

        chunk.push(plan);
        chunkItems += plan.items.length;
    }

    flush();

    return groups.length;
}

async function buildIndex(albumId: string, threshold: number): Promise<SimilarityIndexMeta> {
    const settings = getSettings();
    const context = getAlbum(settings, albumId);
    // pHash 补齐与分组可能持续数分钟，持租约避免空闲巡检关闭连接
    const lease = leaseAlbumDatabase(context.dir);

    try {
        const db = lease.handle.album;
        const started = Date.now();
        const filled = await fillPhashes(context, settings);
        const groups = persistGroups(db, threshold);
        const meta: SimilarityIndexMeta = {
            threshold,
            phashedCount: phashedCount(db),
            assetCount: totalAssets(db),
            groups,
            updatedAt: new Date().toISOString(),
        };

        writeMeta(db, META_SIMILARITY_INDEX, JSON.stringify(meta));
        logger.info({
            albumId,
            threshold,
            filled,
            groups,
            ms: Date.now() - started,
        }, 'similarity index rebuilt');

        return meta;
    }
    finally {
        lease.release();
    }
}

/**
 * 取索引：过期（阈值变了或有新资产）就重建。
 * 同一相册的重建串行复用，避免并发请求重复算同一份索引。
 */
export async function ensureSimilarityIndex(albumId: string, threshold: number): Promise<SimilarityIndexMeta> {
    const key = `${albumId}:${threshold}`;
    const running = inFlight.get(key);

    if (running) {
        return running;
    }

    const settings = getSettings();
    const db = getAlbum(settings, albumId).db.album;

    if (isSimilarityIndexFresh(db, threshold)) {
        const meta = readSimilarityIndexMeta(db);

        if (meta) {
            return meta;
        }
    }

    const pass = buildIndex(albumId, threshold).finally(() => {
        inFlight.delete(key);
    });

    inFlight.set(key, pass);

    return pass;
}

/** 当前正在算 pHash / 重建相似分组的相册（去重，纯内存，不打开相册库） */
export function buildingSimilarityAlbums(): string[] {
    return [...new Set([...inFlight.keys()].map(key => key.slice(0, key.indexOf(':'))))];
}

/** 扫描/删除资产后的后台预热；不阻塞调用方，也不阻塞首次查看 */
export function warmSimilarityIndex(albumId: string, threshold?: number): void {
    const settings = getSettings();

    if (!settings.similarity.enabled) {
        return;
    }

    const albumThreshold = getAlbum(settings, albumId).index.settings.similarityThreshold;
    const effectiveThreshold = threshold ?? albumThreshold ?? settings.similarity.hammingThreshold;

    void ensureSimilarityIndex(albumId, effectiveThreshold).catch((error: unknown) => {
        logger.warn({ err: error, albumId }, 'similarity index warm-up failed');
    });
}

/** 读取持久化分组：表里只保留一份快照，因此直接按分组大小读取 */
/** 组内顺序：代表图（distance 0）在前，其余按距离升序，供查看器在组内翻页 */
export function readSimilarityGroupAssets(
    db: AlbumDatabase,
    groupId: string,
): { assetId: string, distance: number }[] {
    return db
        .select({ assetId: similarGroupItems.assetId, distance: similarGroupItems.distance })
        .from(similarGroupItems)
        .innerJoin(assets, eq(assets.id, similarGroupItems.assetId))
        .where(and(eq(similarGroupItems.groupId, groupId), isNull(assets.deletedAt)))
        .all()
        .sort((a, b) => a.distance - b.distance || a.assetId.localeCompare(b.assetId));
}

export function readSimilarityGroups(
    db: AlbumDatabase,
    limit: number,
): {
    groupId: string
    representativeId: string
    itemCount: number
    maxDistance: number
    items: { assetId: string, distance: number }[]
}[] {
    const rows = db
        .select()
        .from(similarGroups)
        .orderBy(sql`${similarGroups.itemCount} DESC`, sql`${similarGroups.maxDistance} ASC`)
        .limit(limit)
        .all();

    if (rows.length === 0) {
        return [];
    }

    const items = db
        .select()
        .from(similarGroupItems)
        .where(inArray(similarGroupItems.groupId, rows.map(row => row.id)))
        .all();
    const byGroup = new Map<string, { assetId: string, distance: number }[]>();

    for (const item of items) {
        const bucket = byGroup.get(item.groupId) ?? [];

        bucket.push({ assetId: item.assetId, distance: item.distance });
        byGroup.set(item.groupId, bucket);
    }

    return rows.map(row => ({
        groupId: row.id,
        representativeId: row.representativeId,
        itemCount: row.itemCount,
        maxDistance: row.maxDistance,
        items: (byGroup.get(row.id) ?? []).sort((a, b) => a.distance - b.distance),
    }));
}
