import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger';
import { albumDatabaseDir, albumPictureDbPath, albumPixivDbPath, albumTagDbPath, describeDataDirectories } from '../utils/data-dir';
import { THUMBNAIL_REGISTRY_DDL, deleteAlbumThumbnailRows } from '../album/thumb-tables';
import { createAlbumPixivDatabase, type AlbumPixivDatabase } from './album-pixiv';
import { albumRelations } from './schemas/album';
import { thumbnailsRelations } from './schemas/thumbnails';
import { createInMemoryTagDatabase, openTagDatabase, type TagDatabase } from './tags';
import { openSqliteDatabase } from './sqlite';

/**
 * 相册级数据库唯一入口（PictureX 无全局业务 db）。
 * - <album>/data/picture.db：媒体索引、标签关联、Pixiv 映射与相似分组
 * - <album>/data/tag.db：标签主数据
 * - <album>/data/pixiv.db：本相册作品副本
 * - 缩略图 BLOB 统一放在 <dataDir>/data/thumbnails.db（按 album_id 隔离）
 *
 * rc 驱动签名：传入既有连接必须写 drizzle({ client, relations })，否则会静默新开连接。
 * 每条连接都必须显式开启 WAL / busy_timeout / synchronous / foreign_keys。
 */

export type AlbumDatabase = BetterSQLite3Database<typeof albumRelations> & {
    $client: Database.Database
};

export type ThumbnailDatabase = BetterSQLite3Database<typeof thumbnailsRelations> & {
    $client: Database.Database
};

export interface AlbumDbHandle {
    album: AlbumDatabase
    thumbnails: ThumbnailDatabase
    tags: TagDatabase
    /** 本相册用到的作品详情副本（<album>/data/pixiv.db，与全局库同构） */
    pixiv: AlbumPixivDatabase
    /** 相册库连接是否已 ATTACH pixiv.db（跨库筛选/搜索用；内存库为 false） */
    pixivAttached: boolean
    close: () => void
}

const ALBUM_DDL = `
CREATE TABLE IF NOT EXISTS album_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    sha256 TEXT NOT NULL,
    phash TEXT,
    taken_at INTEGER,
    added_at INTEGER NOT NULL,
    deleted_at INTEGER,
    favorite INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL,
    pixiv_illust_id TEXT GENERATED ALWAYS AS (json_extract(meta, '$.pixiv.illustId')) VIRTUAL,
    pixiv_illust_num INTEGER GENERATED ALWAYS AS (
        coalesce(cast(json_extract(meta, '$.pixiv.illustId') as integer), 0)
    ) VIRTUAL
);
CREATE INDEX IF NOT EXISTS assets_sha256_idx ON assets (sha256);
CREATE INDEX IF NOT EXISTS assets_phash_idx ON assets (phash);
CREATE INDEX IF NOT EXISTS assets_added_at_idx ON assets (added_at);
CREATE INDEX IF NOT EXISTS assets_taken_at_idx ON assets (taken_at);
CREATE INDEX IF NOT EXISTS assets_taken_sort_idx ON assets (coalesce(taken_at, added_at));
CREATE INDEX IF NOT EXISTS assets_filename_idx ON assets (filename);
CREATE TABLE IF NOT EXISTS asset_tags (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX IF NOT EXISTS asset_tags_tag_idx ON asset_tags (tag_id);
CREATE TABLE IF NOT EXISTS duplicate_files (
    id TEXT PRIMARY KEY NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    found_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS duplicate_files_sha_idx ON duplicate_files (sha256);
CREATE INDEX IF NOT EXISTS duplicate_files_asset_idx ON duplicate_files (asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS duplicate_files_path_idx ON duplicate_files (sha256, source_path);
CREATE TABLE IF NOT EXISTS similar_groups (
    id TEXT PRIMARY KEY NOT NULL,
    threshold INTEGER NOT NULL,
    representative_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    item_count INTEGER NOT NULL,
    max_distance INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS similar_groups_threshold_idx ON similar_groups (threshold, item_count);
CREATE TABLE IF NOT EXISTS similar_group_items (
    group_id TEXT NOT NULL REFERENCES similar_groups(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    distance INTEGER NOT NULL,
    PRIMARY KEY (group_id, asset_id)
);
CREATE INDEX IF NOT EXISTS similar_group_items_asset_idx ON similar_group_items (asset_id);
CREATE TABLE IF NOT EXISTS pixiv_asset_links (
    asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    illust_id TEXT NOT NULL,
    page_index INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pixiv_asset_links_page_idx ON pixiv_asset_links (illust_id, page_index);
CREATE INDEX IF NOT EXISTS pixiv_asset_links_illust_idx ON pixiv_asset_links (illust_id);
CREATE TABLE IF NOT EXISTS pixiv_fetch_marks (
    illust_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pixiv_fetch_marks_status_idx ON pixiv_fetch_marks (status, attempted_at);
INSERT OR IGNORE INTO album_meta (key, value) VALUES ('next_seq', '0');
`;

const THUMBNAIL_DDL = `
${THUMBNAIL_REGISTRY_DDL}CREATE TABLE IF NOT EXISTS thumb_meta (
    album_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (album_id, key)
);
CREATE TABLE IF NOT EXISTS thumbnail_failures (
    album_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    failed_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, asset_id, fingerprint)
);
`;

/**
 * 搜索索引：文件名 + AI 描述（trigram）。虚拟表不能 ALTER，删表重建时一次性回填。
 */
const ALBUM_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
    asset_id UNINDEXED,
    filename,
    caption,
    tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS assets_fts_ai AFTER INSERT ON assets BEGIN
    INSERT INTO assets_fts(asset_id, filename, caption)
    VALUES (new.id, new.filename, coalesce(json_extract(new.meta, '$.ai.caption'), ''));
END;
CREATE TRIGGER IF NOT EXISTS assets_fts_ad AFTER DELETE ON assets BEGIN
    DELETE FROM assets_fts WHERE asset_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS assets_fts_au AFTER UPDATE OF filename, meta ON assets BEGIN
    DELETE FROM assets_fts WHERE asset_id = old.id;
    INSERT INTO assets_fts(asset_id, filename, caption)
    VALUES (new.id, new.filename, coalesce(json_extract(new.meta, '$.ai.caption'), ''));
END;
`;

function ensureAssetSearch(client: Database.Database): void {
    const exists = client
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assets_fts'")
        .get();

    client.exec(ALBUM_FTS_DDL);

    if (exists) {
        return;
    }

    client.exec(`
        INSERT INTO assets_fts(asset_id, filename, caption)
        SELECT id, filename, coalesce(json_extract(meta, '$.ai.caption'), '') FROM assets
    `);
}

/** 列表默认 deleted_at IS NULL + (sort,id) keyset；首次创建后采样一次 */
function ensureAssetSortIndexes(client: Database.Database): void {
    const row = client.prepare(`
        SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'index' AND name IN (
            'assets_active_added_idx', 'assets_active_taken_idx', 'assets_active_filename_idx',
            'assets_active_favorite_idx', 'assets_active_pixiv_idx'
        )
    `).get() as { n: number };

    client.exec(`
        CREATE INDEX IF NOT EXISTS assets_pixiv_illust_idx ON assets (pixiv_illust_id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_deleted_at_idx ON assets (deleted_at);
        CREATE INDEX IF NOT EXISTS assets_favorite_idx ON assets (favorite, added_at);
        CREATE INDEX IF NOT EXISTS assets_active_added_idx ON assets (added_at, id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_active_taken_idx ON assets (coalesce(taken_at, added_at), id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_active_filename_idx ON assets (filename, id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_active_favorite_idx ON assets (favorite, added_at, id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS assets_active_pixiv_idx ON assets (pixiv_illust_num, id) WHERE deleted_at IS NULL;
    `);

    if (Number(row.n) < 5) {
        client.exec('ANALYZE assets');
    }
}

const ALBUM_STORAGE_KEY = /^[0-9A-Za-z_-]{1,64}$/u;

/** 所有相册共用数据根目录下的 thumbnails.db */
export function albumThumbnailDatabasePath(): string {
    return describeDataDirectories().thumbnailDbPath;
}

/** 解除相册关联时清理该相册在统一缩略图库中的行 */
export function removeAlbumThumbnailDatabase(albumId: string): void {
    if (!ALBUM_STORAGE_KEY.test(albumId)) {
        return;
    }

    const path = describeDataDirectories().thumbnailDbPath;

    if (!existsSync(path)) {
        return;
    }

    try {
        const client = new Database(path);

        client.pragma('busy_timeout = 5000');
        client.transaction(() => {
            deleteAlbumThumbnailRows(client, albumId);
            client.prepare('DELETE FROM thumbnail_failures WHERE album_id = ?').run(albumId);
            client.prepare('DELETE FROM thumb_meta WHERE album_id = ?').run(albumId);
        })();
        client.pragma('wal_checkpoint(TRUNCATE)');
        client.close();
    }
    catch (error) {
        logger.warn({ err: error, albumId }, 'album thumbnail rows could not be removed');
    }
}

interface OpenClientOptions {
    cacheKb?: number
    mmapBytes?: number
}

function openClient(path: string, options: OpenClientOptions = {}): Database.Database {
    return openSqliteDatabase(path, options);
}

const ALBUM_SCHEMA_VERSION = 7;
const THUMBNAIL_SCHEMA_VERSION = 6;

function prepareAlbumSchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) < ALBUM_SCHEMA_VERSION) {
        client.exec(ALBUM_DDL);
        client.pragma(`user_version = ${ALBUM_SCHEMA_VERSION}`);
    }

    ensureAssetSearch(client);
    ensureAssetSortIndexes(client);
}

function prepareThumbnailSchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) < THUMBNAIL_SCHEMA_VERSION) {
        client.exec(THUMBNAIL_DDL);
        client.pragma(`user_version = ${THUMBNAIL_SCHEMA_VERSION}`);
    }

    client.exec(THUMBNAIL_REGISTRY_DDL);
}

/** 相册三库固定在 <album>/data；缩略图库统一在数据根 */
function resolveAlbumDatabasePaths(albumDir: string): { picture: string, tags: string, thumbnails: string, pixiv: string } {
    mkdirSync(albumDatabaseDir(albumDir), { recursive: true });

    return {
        picture: albumPictureDbPath(albumDir),
        tags: albumTagDbPath(albumDir),
        pixiv: albumPixivDbPath(albumDir),
        thumbnails: describeDataDirectories().thumbnailDbPath,
    };
}

export function openAlbumDatabase(albumDir: string): AlbumDbHandle {
    const started = Date.now();

    mkdirSync(albumDir, { recursive: true });

    const paths = resolveAlbumDatabasePaths(albumDir);
    const albumClient = openClient(paths.picture, { cacheKb: 32768, mmapBytes: 268435456 });
    const thumbPath = paths.thumbnails;

    mkdirSync(dirname(thumbPath), { recursive: true });

    const thumbClient = openClient(thumbPath, { cacheKb: 16384, mmapBytes: 67108864 });

    prepareAlbumSchema(albumClient);
    prepareThumbnailSchema(thumbClient);

    const pixivClient = openClient(paths.pixiv, { cacheKb: 8192, mmapBytes: 33554432 });
    const pixiv = createAlbumPixivDatabase(pixivClient);

    let pixivAttached = false;

    try {
        // 同一相册的 pixiv.db 以 schema `pixiv` 附加到 picture.db 连接，
        // 让标签筛选/作品搜索可以用一条 SQL 完成，不必把上万个 illust_id 拉回 JS
        albumClient.prepare('ATTACH DATABASE ? AS pixiv').run(resolve(paths.pixiv));
        pixivAttached = true;
    }
    catch (error) {
        logger.warn({ err: error, albumDir }, 'album pixiv database could not be attached');
    }

    const album = drizzle({ client: albumClient, relations: albumRelations });
    const thumbnails = drizzle({ client: thumbClient, relations: thumbnailsRelations });
    const tagDb = openTagDatabase(paths.tags);
    const durationMs = Date.now() - started;

    if (durationMs >= 500) {
        logger.info({ albumDir, durationMs }, 'album database opened slowly');
    }
    else {
        logger.debug({ albumDir, durationMs }, 'album database opened');
    }

    return {
        album,
        thumbnails,
        tags: tagDb,
        pixiv,
        pixivAttached,
        close: () => {
            albumClient.close();
            thumbClient.close();
            tagDb.$client.close();
            pixivClient.close();
        },
    };
}

export interface AlbumDbLease {
    handle: AlbumDbHandle
    release: () => void
}

interface HandleEntry {
    handle: AlbumDbHandle
    lastUsedAt: number
    leases: number
    /** 请求级引用：普通请求在 await 期间也不能被删除相册/空闲巡检关掉连接 */
    requests: number
}

const handles = new Map<string, HandleEntry>();
const IDLE_CLOSE_MS = 15 * 60_000;
let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureIdleSweeper(): void {
    if (sweeper) {
        return;
    }

    sweeper = setInterval(() => {
        closeIdleAlbumDatabases();
    }, 60_000);
    sweeper.unref?.();
}

function entryFor(albumDir: string): HandleEntry {
    const cached = handles.get(albumDir);

    if (cached) {
        cached.lastUsedAt = Date.now();

        return cached;
    }

    const entry: HandleEntry = {
        handle: openAlbumDatabase(albumDir),
        lastUsedAt: Date.now(),
        leases: 0,
        requests: 0,
    };

    handles.set(albumDir, entry);
    ensureIdleSweeper();

    return entry;
}

/** 相册库按需打开：列表/启动流程不碰 SQLite，只有真正访问某个相册时才建连接 */
export function albumDatabase(albumDir: string): AlbumDbHandle {
    return entryFor(albumDir).handle;
}

/**
 * 长任务（扫描、AI 打标、相似度索引）必须持有租约：
 * 任务期间可能连续数分钟不调用 albumDatabase()，仅靠 lastUsedAt 会被空闲巡检关闭。
 */
export function leaseAlbumDatabase(albumDir: string): AlbumDbLease {
    const entry = entryFor(albumDir);
    entry.leases += 1;

    let released = false;

    return {
        handle: entry.handle,
        release: () => {
            if (released) {
                return;
            }

            released = true;
            entry.leases = Math.max(0, entry.leases - 1);
            entry.lastUsedAt = Date.now();
        },
    };
}

/**
 * 请求级短引用：路由在 await 期间（磁盘读取、外部请求）可能持有 handle，
 * 期间删除相册或空闲巡检不得关闭连接。返回幂等的 release。
 * 冷库必须先打开再计数，否则中间件永远看不到这个请求，
 * 并发删除相册会在请求中途关库甚至删目录。
 */
export function holdAlbumDatabase(albumDir: string): () => void {
    const entry = entryFor(albumDir);

    entry.requests += 1;
    entry.lastUsedAt = Date.now();

    let released = false;

    return () => {
        if (released) {
            return;
        }

        released = true;
        entry.requests = Math.max(0, entry.requests - 1);
        entry.lastUsedAt = Date.now();
    };
}

export type AlbumIdleHook = (albumDir: string, handle: AlbumDbHandle) => void;

const idleHooks = new Set<AlbumIdleHook>();

/** 注册空闲维护（例如缩略图库 optimize）；返回取消函数，测试可及时清理 */
export function registerAlbumIdleHook(hook: AlbumIdleHook): () => void {
    idleHooks.add(hook);

    return () => idleHooks.delete(hook);
}

function runIdleHooks(dir: string, handle: AlbumDbHandle): void {
    for (const hook of idleHooks) {
        try {
            hook(dir, handle);
        }
        catch {
            // 维护失败不影响连接管理
        }
    }
}

/** 对没有租约的连接执行一次空闲维护；定时器用它覆盖长期不关闭的活跃相册 */
export function optimizeAlbumDatabases(idleMs = 0): number {
    const now = Date.now();
    let maintained = 0;

    for (const [dir, entry] of handles) {
        if (entry.leases > 0 || entry.requests > 0 || now - entry.lastUsedAt < idleMs) {
            continue;
        }

        runIdleHooks(dir, entry.handle);
        maintained += 1;
    }

    return maintained;
}

/** 关闭空闲连接（默认 15 分钟未使用），关闭前执行一次维护，避免文件长期不收缩 */
export function closeIdleAlbumDatabases(idleMs = IDLE_CLOSE_MS): number {
    const now = Date.now();
    let closed = 0;

    for (const [dir, entry] of handles) {
        if (entry.leases > 0 || entry.requests > 0) {
            continue;
        }
        if (now - entry.lastUsedAt >= idleMs) {
            runIdleHooks(dir, entry.handle);
            entry.handle.close();
            handles.delete(dir);
            closed += 1;
        }
    }

    return closed;
}

/** 关闭连接；有租约或在途请求时返回 false，由调用方决定是否拒绝当前操作 */
export function closeAlbumDatabase(albumDir: string): boolean {
    const entry = handles.get(albumDir);

    if (!entry) {
        return true;
    }
    if (entry.leases > 0 || entry.requests > 0) {
        return false;
    }

    entry.handle.close();
    handles.delete(albumDir);

    return true;
}

export function closeAllAlbumDatabases(): void {
    for (const entry of handles.values()) {
        entry.handle.close();
    }

    handles.clear();
}

/** 仅测试用：内存库 */
export function createInMemoryAlbumDatabase(): {
    album: AlbumDatabase
    thumbnails: ThumbnailDatabase
    tags: TagDatabase
    pixiv: AlbumPixivDatabase
    pixivAttached: boolean
} {
    const albumClient = new Database(':memory:');
    const thumbClient = new Database(':memory:');
    const pixivClient = new Database(':memory:');

    for (const client of [albumClient, thumbClient, pixivClient]) {
        client.pragma('foreign_keys = ON');
        client.pragma('busy_timeout = 5000');
    }

    prepareAlbumSchema(albumClient);
    prepareThumbnailSchema(thumbClient);

    return {
        album: drizzle({ client: albumClient, relations: albumRelations }),
        thumbnails: drizzle({ client: thumbClient, relations: thumbnailsRelations }),
        tags: createInMemoryTagDatabase(),
        pixiv: createAlbumPixivDatabase(pixivClient),
        pixivAttached: false,
    };
}
