import type Database from 'better-sqlite3';

/**
 * 缩略图按尺寸分表。
 *
 * 单表存所有尺寸时，一次浏览会同时命中 128/256/512/1024/2048/4096 各种行，
 * LRU 扫描、损坏行清理和「这张图有没有更小档位」的 SWR 判断都要在同一张百万行表里做；
 * 拆成 thumbnails_s<size> 后，每个尺寸的读写只碰自己的表，索引更小、局部性更好，
 * 淘汰与统计也能按尺寸分别进行。
 *
 * 表名由整数尺寸拼接，因此必须先校验尺寸：绝不把未校验输入拼进 SQL 标识符。
 */

export const THUMBNAIL_TABLE_PREFIX = 'thumbnails_s';

export const MIN_THUMBNAIL_SIZE = 16;
export const MAX_THUMBNAIL_SIZE = 8192;

export function thumbnailTable(size: number): string {
    if (!Number.isInteger(size) || size < MIN_THUMBNAIL_SIZE || size > MAX_THUMBNAIL_SIZE) {
        throw new Error(`invalid thumbnail size: ${String(size)}`);
    }

    return `${THUMBNAIL_TABLE_PREFIX}${size}`;
}

export const THUMBNAIL_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS thumbnail_sizes (
    size INTEGER PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
);
`;

/** 分表 + 该表的增量字节触发器（累计值仍写 thumb_meta，保持「每次写入不全表 sum」的约束） */
export function thumbnailTableDdl(size: number): string {
    const table = thumbnailTable(size);

    return `
CREATE TABLE IF NOT EXISTS ${table} (
    album_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    blob BLOB NOT NULL,
    width INTEGER,
    height INTEGER,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ${table}_lru_idx ON ${table} (album_id, last_accessed_at);
CREATE TRIGGER IF NOT EXISTS ${table}_total_after_insert AFTER INSERT ON ${table} BEGIN
    INSERT INTO thumb_meta (album_id, key, value)
    VALUES (NEW.album_id, 'total_bytes', CAST(NEW.size_bytes AS TEXT))
    ON CONFLICT(album_id, key) DO UPDATE SET
        value = CAST(CAST(value AS INTEGER) + NEW.size_bytes AS TEXT);
END;
CREATE TRIGGER IF NOT EXISTS ${table}_total_after_delete AFTER DELETE ON ${table} BEGIN
    UPDATE thumb_meta SET value = CAST(MAX(0, CAST(value AS INTEGER) - OLD.size_bytes) AS TEXT)
    WHERE album_id = OLD.album_id AND key = 'total_bytes';
END;
CREATE TRIGGER IF NOT EXISTS ${table}_total_after_update AFTER UPDATE OF size_bytes ON ${table} BEGIN
    UPDATE thumb_meta SET value = CAST(MAX(0, CAST(value AS INTEGER) + NEW.size_bytes - OLD.size_bytes) AS TEXT)
    WHERE album_id = NEW.album_id AND key = 'total_bytes';
END;
`;
}

/** 建表并登记；返回是否新建（已存在时零副作用） */
export function ensureThumbnailTable(client: Database.Database, size: number): boolean {
    const table = thumbnailTable(size);
    const known = client.prepare('SELECT 1 FROM thumbnail_sizes WHERE size = ?').get(size);

    if (known && tableExists(client, table)) {
        return false;
    }

    client.exec(thumbnailTableDdl(size));
    client.prepare(`
        INSERT INTO thumbnail_sizes (size, created_at)
        VALUES (?, strftime('%s', 'now'))
        ON CONFLICT(size) DO NOTHING
    `).run(size);

    return true;
}

/** 已存在的分表尺寸，升序；直接扫 sqlite_master，注册表缺失也不会漏 */
export function listThumbnailSizes(client: Database.Database): number[] {
    const rows = client
        .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ?')
        .all('table', `${THUMBNAIL_TABLE_PREFIX}%`) as { name: string }[];

    return rows
        .map(row => Number(row.name.slice(THUMBNAIL_TABLE_PREFIX.length)))
        .filter(size => Number.isInteger(size) && size > 0)
        .sort((left, right) => left - right);
}

/** 按分表实际内容重写每个相册的 total_bytes（只在整理/清空时调用，不进写路径） */
export function recalcTotalBytes(client: Database.Database): void {
    const sizes = listThumbnailSizes(client);

    if (sizes.length === 0) {
        client.prepare("DELETE FROM thumb_meta WHERE key = 'total_bytes'").run();

        return;
    }

    const union = sizes
        .map(size => `SELECT album_id, size_bytes FROM ${thumbnailTable(size)}`)
        .join(' UNION ALL ');

    client.prepare(`
        INSERT INTO thumb_meta (album_id, key, value)
        SELECT album_id, 'total_bytes', CAST(coalesce(sum(size_bytes), 0) AS TEXT)
        FROM (${union})
        GROUP BY album_id
        ON CONFLICT(album_id, key) DO UPDATE SET value = excluded.value
    `).run();

    // 已没有行的相册清零，避免残留的旧累计值继续触发淘汰
    client.prepare(`
        UPDATE thumb_meta SET value = '0'
        WHERE key = 'total_bytes'
          AND album_id NOT IN (
              ${sizes.map(size => `SELECT album_id FROM ${thumbnailTable(size)}`).join(' UNION ALL ')}
          )
    `).run();
}

/** 相册解除关联：删掉它在所有分表里的行 */
export function deleteAlbumThumbnailRows(client: Database.Database, albumId: string): void {
    for (const size of listThumbnailSizes(client)) {
        client.prepare(`DELETE FROM ${thumbnailTable(size)} WHERE album_id = ?`).run(albumId);
    }
}

function tableExists(client: Database.Database, name: string): boolean {
    return client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
