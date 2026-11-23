import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ApiError } from '../hono/problem';
import { logger } from '../logger';
import { tagRelations } from './schemas/tags';
import { openSqliteDatabase } from './sqlite';

/**
 * 标签主数据库（相册 <album>/data/tag.db 与全局 <dataDir>/data/tag.db）唯一入口。
 *
 * 0.1.0 基线只认 tag.db：没有旧 tag.json、没有 source/updated_at 列。
 * 数据库本身不可用时回退到内存库并标记 corrupt：仍可浏览，但所有写操作被拒绝，
 * 绝不静默写内存。
 */

export type TagDatabase = BetterSQLite3Database<typeof tagRelations> & {
    $client: Database.Database
};

const TAG_DDL = `
CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_key_idx ON tags (name_key);
CREATE TABLE IF NOT EXISTS tag_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
`;

const TAG_SCHEMA_VERSION = 4;
const CORRUPT_KEY = 'corrupt';

function openClient(path: string): Database.Database {
    return openSqliteDatabase(path, { cacheKb: 8192 });
}

export function getTagMeta(db: { $client: Database.Database }, key: string): string | null {
    const row = db.$client
        .prepare('SELECT value FROM tag_meta WHERE key = ?')
        .get(key) as { value?: string } | undefined;

    return row?.value ?? null;
}

export function setTagMeta(db: { $client: Database.Database }, key: string, value: string): void {
    db.$client
        .prepare(`
            INSERT INTO tag_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `)
        .run(key, value);
}

export function isTagDatabaseCorrupt(db: { $client: Database.Database }): boolean {
    return getTagMeta(db, CORRUPT_KEY) === '1';
}

/** 写路径必须调用：数据库不可用时拒绝写入，避免把内存回退当成主数据 */
export function assertTagMasterReadable(db: { $client: Database.Database }): void {
    if (isTagDatabaseCorrupt(db)) {
        throw new ApiError(
            500,
            'tag_file_corrupt',
            'The tag database is unavailable. Restore it from a backup before editing tags.',
        );
    }
}

function createClient(path: string): Database.Database {
    const client = openClient(path);

    if (Number(client.pragma('user_version', { simple: true })) < TAG_SCHEMA_VERSION) {
        client.exec(TAG_DDL);
        client.pragma(`user_version = ${TAG_SCHEMA_VERSION}`);
    }

    return client;
}

export function openTagDatabase(path: string): TagDatabase {
    let client: Database.Database | null = null;

    try {
        mkdirSync(dirname(path), { recursive: true });
        client = createClient(path);
    }
    catch (error) {
        logger.error({ err: error, path }, 'tag database is unusable; falling back to memory');

        try {
            client?.close();
        }
        catch {
            // 忽略关闭失败
        }

        client = createClient(':memory:');
        setTagMeta({ $client: client }, CORRUPT_KEY, '1');
    }

    if (!client) {
        throw new Error('tag database could not be opened');
    }

    return drizzle({ client, relations: tagRelations });
}

export function createInMemoryTagDatabase(): TagDatabase {
    return drizzle({ client: createClient(':memory:'), relations: tagRelations });
}
