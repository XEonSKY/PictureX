import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger';
import { packPixivPages } from '../pixiv/pages';
import type { PixivIllust } from '../pixiv/types';
import { describeDataDirectories } from '../utils/data-dir';
import { toSeconds } from '../utils/time';
import { pixivRelations } from './schemas/pixiv';
import { openSqliteDatabase } from './sqlite';

/**
 * 全局 Pixiv 库唯一入口（<dataDir>/data/pixiv.db，独立于相册）。
 *
 * - illusts/meta：所有作品详情与迁移/同步状态；
 * - users/tags/illust_tags：画师与 Pixiv 标签的规范化存储；
 * - asset ↔ illust/page 映射只在各相册的 picture.db，本库不存映射；
 * - 仅凭文件名识别到的作品先建占位行（fetched_at = 0），详情同步后覆盖。
 */

export type PixivDatabase = BetterSQLite3Database<typeof pixivRelations> & {
    $client: Database.Database
};

/** 全局库与「按相册裁剪副本」共用同一套表结构，因此 DDL 也只有一份 */
export const PIXIV_DDL = `
CREATE TABLE IF NOT EXISTS illusts (
    illust_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'illust',
    caption TEXT NOT NULL DEFAULT '',
    page_count INTEGER NOT NULL DEFAULT 1,
    width INTEGER,
    height INTEGER,
    x_restrict INTEGER NOT NULL DEFAULT 0,
    sanity_level INTEGER NOT NULL DEFAULT 0,
    illust_ai_type INTEGER NOT NULL DEFAULT 0,
    create_date INTEGER,
    total_view INTEGER NOT NULL DEFAULT 0,
    total_bookmarks INTEGER NOT NULL DEFAULT 0,
    pages TEXT NOT NULL DEFAULT '[]',
    ugoira TEXT,
    fetched_at INTEGER NOT NULL DEFAULT 0,
    invalid_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS illusts_fetched_idx ON illusts (fetched_at);
CREATE INDEX IF NOT EXISTS illusts_user_idx ON illusts (user_id);
CREATE INDEX IF NOT EXISTS illusts_create_idx ON illusts (create_date);
CREATE INDEX IF NOT EXISTS illusts_bookmarks_idx ON illusts (total_bookmarks);
CREATE INDEX IF NOT EXISTS illusts_view_idx ON illusts (total_view);
CREATE INDEX IF NOT EXISTS illusts_type_idx ON illusts (type);
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags (
    tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    translated_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_key_idx ON tags (name_key);
CREATE TABLE IF NOT EXISTS illust_tags (
    illust_id TEXT NOT NULL REFERENCES illusts(illust_id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (illust_id, tag_id)
);
CREATE INDEX IF NOT EXISTS illust_tags_tag_idx ON illust_tags (tag_id);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
`;

function openClient(path: string): Database.Database {
    return openSqliteDatabase(path, { cacheKb: 16384 });
}

function tagKey(name: string): string {
    return name.trim().toLocaleLowerCase();
}

/**
 * 写入一份完整作品详情（占位行会被覆盖，旧详情不会被更旧的 fetchedAt 覆盖）。
 * 调用方负责事务；数据库同步会把整个相册的写入放进一个事务。
 */
export function writePixivIllustSnapshot(
    client: Database.Database,
    illust: PixivIllust,
    fetchedAt: number = Math.floor(Date.now() / 1000),
): void {
    const written = client.prepare(`
        INSERT INTO illusts (
            illust_id, user_id, title, type, caption, page_count, width, height,
            x_restrict, sanity_level, illust_ai_type, create_date,
            total_view, total_bookmarks, pages, ugoira, fetched_at, invalid_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(illust_id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            type = excluded.type,
            caption = excluded.caption,
            page_count = excluded.page_count,
            width = excluded.width,
            height = excluded.height,
            x_restrict = excluded.x_restrict,
            sanity_level = excluded.sanity_level,
            illust_ai_type = excluded.illust_ai_type,
            create_date = excluded.create_date,
            total_view = excluded.total_view,
            total_bookmarks = excluded.total_bookmarks,
            pages = excluded.pages,
            ugoira = excluded.ugoira,
            fetched_at = excluded.fetched_at,
            invalid_at = 0
        WHERE excluded.fetched_at >= illusts.fetched_at
    `).run(
        illust.illustId,
        illust.userId,
        illust.title,
        illust.type,
        illust.caption,
        illust.pageCount,
        illust.width,
        illust.height,
        illust.xRestrict,
        illust.sanityLevel,
        illust.illustAiType,
        toSeconds(illust.createDate),
        illust.totalView,
        illust.totalBookmarks,
        packPixivPages(illust.pages),
        illust.ugoira ? JSON.stringify(illust.ugoira) : null,
        fetchedAt,
    );

    // 更旧的快照不覆盖详情，也不应改写用户/标签关系
    if (Number(written.changes ?? 0) === 0) {
        return;
    }

    if (illust.userId !== '') {
        client.prepare(`
            INSERT INTO users (user_id, name, account, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                name = excluded.name,
                account = excluded.account,
                updated_at = excluded.updated_at
            WHERE excluded.updated_at >= users.updated_at
        `).run(illust.userId, illust.userName, illust.userAccount, fetchedAt);
    }

    client.prepare('DELETE FROM illust_tags WHERE illust_id = ?').run(illust.illustId);

    const upsertTag = client.prepare(`
        INSERT INTO tags (name, name_key, translated_name) VALUES (?, ?, ?)
        ON CONFLICT(name_key) DO UPDATE SET
            translated_name = coalesce(excluded.translated_name, tags.translated_name)
        RETURNING tag_id
    `);
    const linkTag = client.prepare(
        'INSERT OR IGNORE INTO illust_tags (illust_id, tag_id, sort_order) VALUES (?, ?, ?)',
    );
    const seen = new Set<number>();

    illust.tags.forEach((tag, index) => {
        const key = tagKey(tag.name);

        if (key === '') {
            return;
        }

        const row = upsertTag.get(tag.name.trim(), key, tag.translatedName) as { tag_id: number } | undefined;

        if (!row || seen.has(row.tag_id)) {
            return;
        }

        seen.add(row.tag_id);
        linkTag.run(illust.illustId, row.tag_id, index);
    });
}

const PIXIV_SCHEMA_VERSION = 6;

function applySchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) >= PIXIV_SCHEMA_VERSION) {
        return;
    }

    client.exec(PIXIV_DDL);
    client.pragma(`user_version = ${PIXIV_SCHEMA_VERSION}`);
}

let handle: { db: PixivDatabase, path: string } | null = null;

export function pixivDatabase(): PixivDatabase {
    const path = describeDataDirectories().pixivDbPath;

    if (handle !== null && handle.path === path) {
        return handle.db;
    }

    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }

    mkdirSync(dirname(path), { recursive: true });
    const client = openClient(path);

    applySchema(client);

    const db = drizzle({ client, relations: pixivRelations });

    handle = { db, path };

    return db;
}

/** 记录 Pixiv 已返回 404 的作品；比作品详情更新的快照不会被旧失效标记覆盖 */
export function markPixivIllustInvalid(
    client: Database.Database,
    illustId: string,
    invalidAt: number = Math.floor(Date.now() / 1000),
): void {
    client.prepare(`
        INSERT INTO illusts (illust_id, fetched_at, invalid_at) VALUES (?, 0, ?)
        ON CONFLICT(illust_id) DO UPDATE SET invalid_at = excluded.invalid_at
        WHERE illusts.fetched_at <= excluded.invalid_at
    `).run(illustId, invalidAt);
}

export function listInvalidPixivIllustIds(client: Database.Database): Set<string> {
    return new Set(
        (client.prepare('SELECT illust_id FROM illusts WHERE invalid_at > 0').all() as { illust_id: string }[])
            .map(row => row.illust_id),
    );
}

export function readPixivIllustInvalidAt(client: Database.Database, illustId: string): number {
    const row = client.prepare('SELECT invalid_at FROM illusts WHERE illust_id = ?').get(illustId) as
      | { invalid_at?: number }
      | undefined;

    return Number(row?.invalid_at ?? 0);
}

/** 按作品 ID 建占位行；已有详情时保持原样。失败只记警告，绝不阻断入库。 */
export function ensureGlobalPixivIllustPlaceholder(illustId: string): void {
    try {
        pixivDatabase()
            .$client
            .prepare('INSERT OR IGNORE INTO illusts (illust_id, fetched_at) VALUES (?, 0)')
            .run(illustId);
    }
    catch (error) {
        logger.warn({ err: error, illustId }, 'failed to create global pixiv placeholder');
    }
}

export function closePixivDatabase(): void {
    if (handle !== null) {
        handle.db.$client.close();
        handle = null;
    }
}
