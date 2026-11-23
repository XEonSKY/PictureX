import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger';
import { describeDataDirectories } from '../utils/data-dir';
import { taskRelations } from './schemas/task';
import { openSqliteDatabase } from './sqlite';

/**
 * 任务库唯一入口（<dataDir>/data/task.db）。
 * 导入与 AI 任务原先各自躺在相册 picture.db 里，全局「任务」页要逐个打开相册库才能聚合；
 * 集中到这里后，任务列表与 SSE 只读一个库，相册也可以不带任务历史地搬移。
 */

export type TaskDatabase = BetterSQLite3Database<typeof taskRelations> & {
    $client: Database.Database
};

const TASK_DDL = `
CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    album_id TEXT NOT NULL,
    root_path TEXT NOT NULL,
    status TEXT NOT NULL,
    cursor TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS import_jobs_album_idx ON import_jobs (album_id, started_at);
CREATE INDEX IF NOT EXISTS import_jobs_resume_idx ON import_jobs (album_id, root_path, status);
CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    album_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ai_jobs_album_idx ON ai_jobs (album_id, started_at);
`;

const TASK_SCHEMA_VERSION = 1;

function openClient(path: string): Database.Database {
    return openSqliteDatabase(path, { cacheKb: 8192 });
}

function applySchema(client: Database.Database): void {
    if (Number(client.pragma('user_version', { simple: true })) >= TASK_SCHEMA_VERSION) {
        return;
    }

    client.exec(TASK_DDL);
    client.pragma(`user_version = ${TASK_SCHEMA_VERSION}`);
}

let handle: { db: TaskDatabase, path: string } | null = null;

export function taskDatabase(): TaskDatabase {
    const path = describeDataDirectories().taskDbPath;

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

    const db = drizzle({ client, relations: taskRelations });

    handle = { db, path };

    logger.debug({ path }, 'task database opened');

    return db;
}

export function closeTaskDatabase(): void {
    if (handle === null) {
        return;
    }

    handle.db.$client.close();
    handle = null;
}
