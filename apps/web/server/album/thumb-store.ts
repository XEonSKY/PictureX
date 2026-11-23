import { and, eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { ThumbnailDatabase } from '../database/album';
import { thumbnailFailures } from '../database/schemas/thumbnails';
import { nowSeconds } from '../utils/time';
import { ensureThumbnailTable, listThumbnailSizes, recalcTotalBytes, thumbnailTable } from './thumb-tables';

export interface ThumbnailInput {
    assetId: string
    size: number
    mime: string
    blob: Buffer
    width: number
    height: number
}

export interface ThumbnailValue {
    blob: Buffer
    mime: string
    width: number
    height: number
    createdAt: number
}

const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const EVICT_RATIO = 0.9;
const EVICT_BATCH = 256;

/**
 * 缩略图 BLOB 存储（所有相册共用一个 `<dataDir>/data/thumbnails.db`，按 album_id 隔离）。
 *
 * BLOB 按尺寸分表存放（`thumbnails_s256` 等，见 thumb-tables.ts）：读写只碰目标尺寸的表，
 * LRU 与损坏行清理也按表进行，避免在一张百万行大表上跨尺寸扫描。
 * - 按 (albumId, assetId) 覆盖写；
 * - 读取时刷新 lastAccessedAt（每小时最多一次，避免高频写）；
 * - 累计字节由各分表的触发器增量维护在 thumb_meta，禁止每次写入全表 sum；
 * - 超过上限时按相册 LRU 淘汰到 90%，并清理损坏行。
 */
export interface ThumbOptimizeResult {
    removed: number
    vacuumed: boolean
    bytesBefore: number
    bytesAfter: number
}

export interface ThumbClearResult {
    removed: number
    bytesBefore: number
    bytesAfter: number
}

export interface ThumbStats {
    count: number
    totalBytes: number
    fileBytes: number
    maxBytes: number
}

export interface ThumbSizeUsage {
    size: number
    count: number
    bytes: number
}

interface ThumbnailRow {
    mime: string
    blob: Buffer
    width: number | null
    height: number | null
    created_at: number
    last_accessed_at: number
}

export class ThumbStore {
    private readonly client: Database.Database;
    private known: number[] | null = null;

    constructor(
        private readonly db: ThumbnailDatabase,
        private readonly albumId: string,
        private readonly maxBytes: number,
    ) {
        this.client = db.$client;
    }

    /**
     * 已存在的分表尺寸。
     * 缓存只在实例生命周期内有效（每个请求/每轮维护各建一个 store）；
     * 还没看到任何分表时每次重新扫描，因为别的服务可能刚刚才建出第一张表。
     */
    private sizes(): number[] {
        if (this.known === null || this.known.length === 0) {
            this.known = listThumbnailSizes(this.client);
        }

        return this.known;
    }

    private hasSize(size: number): boolean {
        if (this.sizes().includes(size)) {
            return true;
        }

        this.known = listThumbnailSizes(this.client);

        return this.known.includes(size);
    }

    private rememberSize(size: number): void {
        const sizes = this.sizes();

        if (!sizes.includes(size)) {
            this.known = [...sizes, size].sort((left, right) => left - right);
        }
    }

    put(input: ThumbnailInput): void {
        const now = nowSeconds();
        const sizeBytes = input.blob.byteLength;

        ensureThumbnailTable(this.client, input.size);
        this.rememberSize(input.size);

        this.client.prepare(`
            INSERT INTO ${thumbnailTable(input.size)} (
                album_id, asset_id, mime, blob, width, height, size_bytes, created_at, last_accessed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(album_id, asset_id) DO UPDATE SET
                mime = excluded.mime,
                blob = excluded.blob,
                width = excluded.width,
                height = excluded.height,
                size_bytes = excluded.size_bytes,
                created_at = excluded.created_at,
                last_accessed_at = excluded.last_accessed_at
        `).run(
            this.albumId,
            input.assetId,
            input.mime,
            input.blob,
            input.width,
            input.height,
            sizeBytes,
            now,
            now,
        );

        // 累计字节由分表触发器增量维护，这里只读一次计数
        if (this.maxBytes > 0 && this.readTotal() > this.maxBytes) {
            this.sweep();
        }
    }

    get(assetId: string, size: number): ThumbnailValue | null {
        if (!this.hasSize(size)) {
            return null;
        }

        const table = thumbnailTable(size);
        const row = this.client.prepare(`
            SELECT mime, blob, width, height, created_at, last_accessed_at
            FROM ${table}
            WHERE album_id = ? AND asset_id = ?
        `).get(this.albumId, assetId) as ThumbnailRow | undefined;

        if (!row) {
            return null;
        }

        const lastAccess = row.last_accessed_at * 1000;

        if (!Number.isFinite(lastAccess) || Date.now() - lastAccess > TOUCH_INTERVAL_MS) {
            this.client.prepare(`
                UPDATE ${table} SET last_accessed_at = ?
                WHERE album_id = ? AND asset_id = ?
            `).run(nowSeconds(), this.albumId, assetId);
        }

        // better-sqlite3 已经把 BLOB 复制进独立的 Buffer；再次 Buffer.from 会为每张
        // 缩略图多复制一份字节（几百 KB），网格首屏就是几十 MB 的纯拷贝开销。
        return {
            blob: row.blob,
            mime: row.mime,
            width: row.width ?? 0,
            height: row.height ?? 0,
            createdAt: row.created_at,
        };
    }

    /** 同一资产 + 同一套生成参数的失败标记；带 TTL，成功前也会到期后重试 */
    hasFailure(assetId: string, fingerprint: string): boolean {
        const row = this.db
            .select({ failedAt: thumbnailFailures.failedAt })
            .from(thumbnailFailures)
            .where(and(
                eq(thumbnailFailures.albumId, this.albumId),
                eq(thumbnailFailures.assetId, assetId),
                eq(thumbnailFailures.fingerprint, fingerprint),
            ))
            .get();

        if (!row) {
            return false;
        }

        const failedAt = row.failedAt * 1000;

        if (!Number.isFinite(failedAt) || Date.now() - failedAt > FAILURE_TTL_MS) {
            // 过期：删除，下次允许重新解码
            this.db
                .delete(thumbnailFailures)
                .where(and(
                    eq(thumbnailFailures.albumId, this.albumId),
                    eq(thumbnailFailures.assetId, assetId),
                    eq(thumbnailFailures.fingerprint, fingerprint),
                ))
                .run();

            return false;
        }

        return true;
    }

    markFailure(assetId: string, fingerprint: string): void {
        const now = nowSeconds();

        this.db
            .insert(thumbnailFailures)
            .values({ albumId: this.albumId, assetId, fingerprint, failedAt: now })
            .onConflictDoUpdate({
                target: [thumbnailFailures.albumId, thumbnailFailures.assetId, thumbnailFailures.fingerprint],
                set: { failedAt: now },
            })
            .run();
    }

    clearFailure(assetId: string): void {
        this.db
            .delete(thumbnailFailures)
            .where(and(
                eq(thumbnailFailures.albumId, this.albumId),
                eq(thumbnailFailures.assetId, assetId),
            ))
            .run();
    }

    /**
     * 取最接近请求尺寸的缩略图：优先不超过请求值的最大尺寸，
     * 没有时退到最小的大尺寸，避免用户调整 sizes 后网格/封面 404。
     * 分表后这里只是按尺寸顺序点查各表主键，不再扫跨尺寸的大表。
     */
    getClosest(assetId: string, size: number): { value: ThumbnailValue, size: number } | null {
        const sizes = this.sizes().filter(candidate => this.hasSize(candidate));
        // 直接按优先顺序取图：每档一次点查，命中即返回；
        // 旧实现先 has() 逐个探测再 get()，同一档位要查两次。
        const ordered = [
            ...sizes.filter(candidate => candidate <= size).reverse(),
            ...sizes.filter(candidate => candidate > size),
        ];

        for (const candidate of ordered) {
            const value = this.get(assetId, candidate);

            if (value) {
                return { value, size: candidate };
            }
        }

        return null;
    }

    has(assetId: string, size: number): boolean {
        if (!this.hasSize(size)) {
            return false;
        }

        const row = this.client.prepare(`
            SELECT 1 FROM ${thumbnailTable(size)} WHERE album_id = ? AND asset_id = ?
        `).get(this.albumId, assetId);

        return row !== undefined;
    }

    deleteAsset(assetId: string): void {
        for (const size of this.sizes()) {
            this.client.prepare(`
                DELETE FROM ${thumbnailTable(size)} WHERE album_id = ? AND asset_id = ?
            `).run(this.albumId, assetId);
        }

        this.db.delete(thumbnailFailures).where(and(
            eq(thumbnailFailures.albumId, this.albumId),
            eq(thumbnailFailures.assetId, assetId),
        )).run();
    }

    totalBytes(): number {
        return this.readTotal();
    }

    count(): number {
        let total = 0;

        for (const size of this.sizes()) {
            const row = this.client.prepare(`
                SELECT count(*) AS n FROM ${thumbnailTable(size)} WHERE album_id = ?
            `).get(this.albumId) as { n: number };

            total += Number(row.n);
        }

        return total;
    }

    stats(): ThumbStats {
        return {
            count: this.count(),
            totalBytes: this.readTotal(),
            fileBytes: this.fileBytes(),
            maxBytes: this.maxBytes,
        };
    }

    /** 本相册某资产已缓存的尺寸档位（按分表逐个点查） */
    assetSizes(assetId: string): number[] {
        return this.sizes().filter(size => this.has(assetId, size));
    }

    /** 各尺寸分表在本相册的行数与字节，供相册设置页按尺寸展示占用 */
    sizeBreakdown(): ThumbSizeUsage[] {
        return this.sizes().map((size) => {
            const row = this.client.prepare(`
                SELECT count(*) AS n, coalesce(sum(size_bytes), 0) AS bytes
                FROM ${thumbnailTable(size)} WHERE album_id = ?
            `).get(this.albumId) as { n: number, bytes: number };

            return { size, count: Number(row.n), bytes: Number(row.bytes) };
        }).filter(usage => usage.count > 0);
    }

    private pageSize(): number {
        return Number(this.db.$client.pragma('page_size', { simple: true }) ?? 0);
    }

    /** SQLite 主文件大小；不含 WAL（单库时所有相册共享同一文件） */
    private fileBytes(): number {
        const pages = Number(this.db.$client.pragma('page_count', { simple: true }) ?? 0);

        return pages * this.pageSize();
    }

    /**
     * 自动维护：本相册超限 LRU 淘汰、清理损坏行、截断 WAL，并在碎片/文件明显偏大时 VACUUM。
     * 运行在空闲连接或定时维护里，避免拖慢在线请求。
     */
    optimize(): ThumbOptimizeResult {
        const client = this.db.$client;
        const bytesBefore = this.fileBytes();
        let removed = 0;
        let vacuumed = false;

        if (this.maxBytes > 0 && this.readTotal() > this.maxBytes) {
            removed += this.sweep();
        }

        removed += this.cleanupCorrupted();
        client.pragma('wal_checkpoint(TRUNCATE)');

        const pageSize = this.pageSize();
        const liveBytes = this.readTotal();
        const freeBytes = Number(client.pragma('freelist_count', { simple: true }) ?? 0) * pageSize;
        const shouldVacuum = freeBytes > 4 * 1024 * 1024
          || bytesBefore > liveBytes * 1.5 + 8 * 1024 * 1024
          || (this.maxBytes > 0 && bytesBefore > this.maxBytes)
          || (liveBytes === 0 && bytesBefore > 1024 * 1024);

        if (shouldVacuum) {
            vacuumed = this.vacuum();
        }

        // 文件仍超过上限：按 90% → 50% 逐级淘汰最久未访问的缩略图并压缩；
        // 如果数据量本来就不高（纯碎片），sweep 不会删任何行，避免误清空
        if (this.maxBytes > 0 && this.fileBytes() > this.maxBytes && this.count() > 0) {
            for (const ratio of [EVICT_RATIO, 0.5]) {
                if (this.fileBytes() <= this.maxBytes || this.count() === 0) {
                    break;
                }

                const before = this.readTotal();

                removed += this.sweep(ratio);

                if (this.readTotal() === before) {
                    break;
                }
                if (this.vacuum()) {
                    vacuumed = true;
                }
            }
        }

        client.pragma('optimize');
        client.pragma('wal_checkpoint(TRUNCATE)');

        return {
            removed,
            vacuumed,
            bytesBefore,
            bytesAfter: this.fileBytes(),
        };
    }

    /** 清空本相册全部缩略图与负缓存，并压缩数据库；之后浏览时按需重新生成 */
    clear(): ThumbClearResult {
        const client = this.db.$client;
        const bytesBefore = this.fileBytes();
        const removed = this.count();

        for (const size of this.sizes()) {
            client.prepare(`DELETE FROM ${thumbnailTable(size)} WHERE album_id = ?`).run(this.albumId);
        }

        this.db.delete(thumbnailFailures).where(eq(thumbnailFailures.albumId, this.albumId)).run();
        this.resyncTotal();
        client.pragma('wal_checkpoint(TRUNCATE)');
        this.vacuum();
        client.pragma('wal_checkpoint(TRUNCATE)');

        return {
            removed,
            bytesBefore,
            bytesAfter: this.fileBytes(),
        };
    }

    private vacuum(): boolean {
        try {
            this.db.$client.exec('VACUUM');

            return true;
        }
        catch {
            // 数据库忙或只读时跳过，下次维护再试
            return false;
        }
    }

    private readTotal(): number {
        const row = this.db.$client
            .prepare('SELECT value FROM thumb_meta WHERE album_id = ? AND key = ?')
            .get(this.albumId, 'total_bytes') as { value?: string } | undefined;

        return Number(row?.value ?? 0);
    }

    /** 重新计算所有相册的累计字节（触发器缺失或旧库升级后使用） */
    private resyncTotal(): void {
        recalcTotalBytes(this.db.$client);
    }

    /** LRU 淘汰到上限的 ratio（默认 90%），返回删除条数；按分表分别从最久未访问的行开始 */
    sweep(ratio: number = EVICT_RATIO): number {
        if (this.maxBytes <= 0) {
            return 0;
        }

        const target = Math.floor(this.maxBytes * ratio);
        let removed = 0;

        for (const size of this.sizes()) {
            if (this.readTotal() <= target) {
                break;
            }

            const table = thumbnailTable(size);
            const removeBatch = this.db.$client.prepare(`
                DELETE FROM ${table} WHERE rowid IN (
                    SELECT rowid FROM ${table}
                    WHERE album_id = ?
                    ORDER BY last_accessed_at ASC, asset_id ASC
                    LIMIT ${EVICT_BATCH}
                )
            `);

            while (this.readTotal() > target) {
                const result = removeBatch.run(this.albumId);
                const changes = Number(result.changes ?? 0);

                if (changes === 0) {
                    break;
                }

                removed += changes;
            }
        }

        return removed;
    }

    /** 清理本相册 BLOB 长度与 sizeBytes 不一致的损坏行 */
    cleanupCorrupted(): number {
        let removed = 0;

        for (const size of this.sizes()) {
            const result = this.db.$client
                .prepare(`DELETE FROM ${thumbnailTable(size)} WHERE album_id = ? AND length(blob) <> size_bytes`)
                .run(this.albumId);

            removed += Number(result.changes ?? 0);
        }

        this.resyncTotal();

        return removed;
    }
}

export function createThumbStore(db: ThumbnailDatabase, dbMaxSizeMb: number, albumId: string): ThumbStore {
    return new ThumbStore(db, albumId, Math.max(0, dbMaxSizeMb) * 1024 * 1024);
}
