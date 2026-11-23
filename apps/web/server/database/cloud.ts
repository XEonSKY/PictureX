import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { describeDataDirectories } from '../utils/data-dir';
import { cloudRelations } from './schemas/cloud';
import { openSqliteDatabase } from './sqlite';

/**
 * Pixiv 云端图片缓存唯一入口（<dataDir>/data/cloud.db）。
 * 只存从 Pixiv 拉取的原始图片；相册本地图像仍留在各自 storage，不复制进来。
 * 全局只有一份、按需懒打开，进程退出时关闭。
 */

export type CloudDatabase = BetterSQLite3Database<typeof cloudRelations> & {
    $client: Database.Database
};

const CLOUD_DDL = `
CREATE TABLE IF NOT EXISTS pixiv_locals (
    illust_id TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    blob BLOB NOT NULL,
    fetched_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    PRIMARY KEY (illust_id, page_index)
);
CREATE INDEX IF NOT EXISTS pixiv_locals_accessed_idx ON pixiv_locals (last_accessed_at);
CREATE INDEX IF NOT EXISTS pixiv_locals_size_idx ON pixiv_locals (size_bytes);
`;

/** v2：补 size_bytes 覆盖索引，让缓存总量统计不扫 BLOB 页 */
const CLOUD_SCHEMA_VERSION = 2;

function applySchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) >= CLOUD_SCHEMA_VERSION) {
        return;
    }

    client.exec(CLOUD_DDL);
    client.pragma(`user_version = ${CLOUD_SCHEMA_VERSION}`);
}

let handle: { db: CloudDatabase, path: string } | null = null;

export function cloudDatabase(): CloudDatabase {
    const path = describeDataDirectories().cloudDbPath;

    if (handle !== null && handle.path === path) {
        return handle.db;
    }

    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }

    mkdirSync(dirname(path), { recursive: true });
    const client = openSqliteDatabase(path, { cacheKb: 16384, mmapBytes: 268435456 });

    applySchema(client);

    const db = drizzle({ client, relations: cloudRelations });

    handle = { db, path };

    return db;
}

export function closeCloudDatabase(): void {
    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }
}
