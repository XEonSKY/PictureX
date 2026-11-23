import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { describeDataDirectories } from '../utils/data-dir';
import { openSqliteDatabase } from './sqlite';
import { globalRelations } from './schemas/global';
import { openTagDatabase, type TagDatabase } from './tags';

/**
 * 查看器全局库唯一入口（<dataDir>/data/picture.db，独立于相册）。
 *
 * rc 驱动签名：传入既有连接必须写 drizzle({ client, relations })，否则会静默新开连接。
 * 连接显式开启 WAL / busy_timeout / synchronous / foreign_keys。
 * 全局库只有一份、写入极轻，故首次访问时懒打开并常驻，进程退出时关闭；不做相册库那样的空闲回收。
 */

export type GlobalDatabase = BetterSQLite3Database<typeof globalRelations> & {
    $client: Database.Database
};

const GLOBAL_DDL = `
CREATE TABLE IF NOT EXISTS viewer_media (
    sha256 TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    filename TEXT NOT NULL,
    last_path TEXT,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS viewer_media_added_idx ON viewer_media (added_at, sha256);
CREATE TABLE IF NOT EXISTS viewer_media_tags (
    sha256 TEXT NOT NULL REFERENCES viewer_media (sha256) ON DELETE CASCADE,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (sha256, tag_id)
);
CREATE INDEX IF NOT EXISTS viewer_media_tags_tag_idx ON viewer_media_tags (tag_id);
`;

function openClient(path: string): Database.Database {
    return openSqliteDatabase(path, { cacheKb: 16384 });
}

const GLOBAL_SCHEMA_VERSION = 4;

function applySchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) >= GLOBAL_SCHEMA_VERSION) {
        return;
    }

    client.exec(GLOBAL_DDL);
    client.pragma(`user_version = ${GLOBAL_SCHEMA_VERSION}`);
}

let handle: { db: GlobalDatabase, path: string } | null = null;
let tagHandle: { db: TagDatabase, path: string } | null = null;

/** 全局标签主数据 <dataDir>/data/tag.db */
export function globalTagDatabase(): TagDatabase {
    const path = describeDataDirectories().globalTagDbPath;

    if (tagHandle !== null && tagHandle.path === path) {
        return tagHandle.db;
    }

    if (tagHandle !== null) {
        tagHandle.db.$client.close();
        tagHandle = null;
    }

    const db = openTagDatabase(path);

    tagHandle = { db, path };

    return db;
}

export function globalDatabase(): GlobalDatabase {
    const path = describeDataDirectories().pictureDbPath;

    if (handle !== null && handle.path === path) {
        return handle.db;
    }

    // 数据目录迁移（换 PX_DATA_DIR / 测试注入）时丢弃旧连接重开
    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }

    mkdirSync(dirname(path), { recursive: true });
    const client = openClient(path);

    applySchema(client);

    const db = drizzle({ client, relations: globalRelations });

    handle = { db, path };

    return db;
}

export function closeGlobalDatabase(): void {
    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }

    if (tagHandle !== null) {
        tagHandle.db.$client.close();
        tagHandle = null;
    }
}

export function createInMemoryGlobalDatabase(): GlobalDatabase {
    const client = new Database(':memory:');

    client.pragma('foreign_keys = ON');
    client.pragma('busy_timeout = 5000');
    applySchema(client);

    return drizzle({ client, relations: globalRelations });
}
