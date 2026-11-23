import Database from 'better-sqlite3';

/**
 * 所有运行期 SQLite 连接的统一 PRAGMA。
 * WAL / busy_timeout / synchronous / foreign_keys 是数据一致性的前提，
 * journal_size_limit 防止长期运行把 -wal 撑大；缓存按库的重要程度由调用方覆盖。
 */
export interface SqliteOpenOptions {
    /** 负值 = KiB，例如 32768 表示 32 MiB */
    cacheKb?: number
    mmapBytes?: number
}

function configureSqlite(client: Database.Database, options: SqliteOpenOptions = {}): void {
    client.pragma('journal_mode = WAL');
    client.pragma('busy_timeout = 5000');
    client.pragma('synchronous = NORMAL');
    client.pragma('foreign_keys = ON');
    client.pragma('journal_size_limit = 33554432');
    client.pragma('temp_store = MEMORY');

    if (options.cacheKb) {
        client.pragma(`cache_size = -${options.cacheKb}`);
    }
    if (options.mmapBytes) {
        client.pragma(`mmap_size = ${options.mmapBytes}`);
    }
}

export function openSqliteDatabase(path: string, options: SqliteOpenOptions = {}): Database.Database {
    const client = new Database(path);

    configureSqlite(client, options);

    return client;
}
