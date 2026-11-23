import { eq } from 'drizzle-orm';
import { getAlbum } from '../album/album-store';
import { duplicateFiles } from '../database/schemas/album';
import type { Settings } from '../settings/setting-schema';

/**
 * 重复文件只是导入时发现的「相册外还有相同内容」的记录。
 * 相册与扫描目录解耦：这里只清除记录，绝不读取、移动或删除相册目录以外的文件。
 * 需要释放磁盘空间时由用户在文件管理器中自行处理。
 */

export interface DuplicateCleanupResult {
    groups: number
    cleared: number
}

export function cleanupDuplicateFiles(settings: Settings, albumId: string): DuplicateCleanupResult {
    const context = getAlbum(settings, albumId);
    const db = context.db.album;
    const rows = db.select({ sha256: duplicateFiles.sha256 }).from(duplicateFiles).all();
    const groups = new Set(rows.map(row => row.sha256)).size;

    if (groups === 0) {
        return { groups: 0, cleared: 0 };
    }

    const result = db.delete(duplicateFiles).run();

    return { groups, cleared: Number(result.changes ?? 0) };
}

/** 移除单条重复记录（不触碰源文件） */
export function clearDuplicateRecord(settings: Settings, albumId: string, duplicateId: string): boolean {
    const context = getAlbum(settings, albumId);
    const db = context.db.album;
    const row = db
        .select({ id: duplicateFiles.id })
        .from(duplicateFiles)
        .where(eq(duplicateFiles.id, duplicateId))
        .get();

    if (!row) {
        return false;
    }

    db.delete(duplicateFiles).where(eq(duplicateFiles.id, duplicateId)).run();

    return true;
}
