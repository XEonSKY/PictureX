import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AlbumDatabase } from '../database/album';
import { albumMeta } from '../database/schemas/album';

/**
 * album_meta 键值表：next_seq 是存储分区序列的唯一事实源。
 * 分区规则：storage/<4 位分区号>/<uuidv7>.<ext>，每 partitionSize 个文件换一个分区。
 */

export const META_NEXT_SEQ = 'next_seq';

export function readMeta(db: AlbumDatabase, key: string): string | null {
    const row = db.select().from(albumMeta).where(eq(albumMeta.key, key)).get();

    return row?.value ?? null;
}

export function writeMeta(db: AlbumDatabase, key: string, value: string): void {
    const existing = db.select().from(albumMeta).where(eq(albumMeta.key, key)).get();

    if (existing) {
        db.update(albumMeta).set({ value }).where(eq(albumMeta.key, key)).run();
    }
    else {
        db.insert(albumMeta).values({ key, value }).run();
    }
}

/** 原子分配下一个序列号（better-sqlite3 同步事务） */
export function allocateSequence(db: AlbumDatabase): number {
    return db.transaction((tx) => {
        const row = tx.select().from(albumMeta).where(eq(albumMeta.key, META_NEXT_SEQ)).get();
        const parsed = Number.parseInt(row?.value ?? '0', 10);
        const current = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

        if (row) {
            tx.update(albumMeta).set({ value: String(current + 1) }).where(eq(albumMeta.key, META_NEXT_SEQ)).run();
        }
        else {
            tx.insert(albumMeta).values({ key: META_NEXT_SEQ, value: String(current + 1) }).run();
        }

        return current;
    });
}

export function partitionForSequence(sequence: number, partitionSize: number): number {
    if (!Number.isFinite(sequence) || sequence < 0) {
        throw new Error(`sequence 非法: ${sequence}`);
    }
    if (!Number.isFinite(partitionSize) || partitionSize < 1) {
        throw new Error(`partitionSize 非法: ${partitionSize}`);
    }

    return Math.floor(sequence / partitionSize) + 1;
}

export function partitionName(sequence: number, partitionSize: number): string {
    return String(partitionForSequence(sequence, partitionSize)).padStart(4, '0');
}

export function normalizeExtension(ext: string): string {
    const cleaned = ext.replace(/^\./u, '').trim().toLowerCase();

    return /^[a-z0-9]{1,12}$/u.test(cleaned) ? cleaned : 'bin';
}

/** 生成相对相册目录的 storage key（正斜杠，跨平台一致） */
export function storageKeyFor(
    sequence: number,
    partitionSize: number,
    ext: string,
    assetId: string = uuidv7(),
): string {
    const folder = partitionName(sequence, partitionSize);

    return `storage/${folder}/${assetId}.${normalizeExtension(ext)}`;
}
