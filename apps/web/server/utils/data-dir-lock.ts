import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * 数据目录单写者锁。
 * 桌面端与 CLI 共用 ~/.xeonsky/picturex；两个进程同时写 SQLite/JSON 会出现
 * 最后写入覆盖与重复下载。锁文件记录 pid + 主机名，崩溃残留通过 pid 探测回收。
 */

const LOCK_NAME = '.picturex.lock';
const HOST = hostname();

interface LockInfo {
    pid: number
    host: string
    startedAt: string
}

let heldDir: string | null = null;

function lockPath(dataDir: string): string {
    return join(dataDir, LOCK_NAME);
}

function readLock(path: string): LockInfo | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));

        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const record = parsed as Partial<LockInfo>;

        return typeof record.pid === 'number' && typeof record.host === 'string'
            ? { pid: record.pid, host: record.host, startedAt: String(record.startedAt ?? '') }
            : null;
    }
    catch {
        return null;
    }
}

function processAlive(pid: number): boolean {
    if (pid === process.pid) {
        return true;
    }

    try {
        process.kill(pid, 0);

        return true;
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function writeLock(path: string): boolean {
    try {
        const fd = openSync(path, 'wx');

        try {
            writeFileSync(fd, `${JSON.stringify({
                pid: process.pid,
                host: HOST,
                startedAt: new Date().toISOString(),
            } satisfies LockInfo)}\n`);
        }
        finally {
            closeSync(fd);
        }

        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }

        return false;
    }
}

export function acquireDataDirLock(dataDir: string): void {
    if (heldDir === dataDir || process.env.PX_NO_LOCK === '1') {
        return;
    }

    const path = lockPath(dataDir);

    if (writeLock(path)) {
        heldDir = dataDir;

        return;
    }

    const current = readLock(path);
    const activeHere = current?.host === HOST && processAlive(current.pid);

    if (activeHere) {
        throw new Error(
            `数据目录已被另一个 PictureX 进程占用（pid ${current.pid}）：${dataDir}。`
            + ' 请先退出另一个 CLI/桌面端实例，或换一个数据目录。',
        );
    }

    // 崩溃残留或跨主机共享目录：删除后重试一次，仍失败则说明有并发竞争者
    try {
        unlinkSync(path);
    }
    catch {
        // 删除失败时下面的写入会给出真实错误
    }

    if (writeLock(path)) {
        heldDir = dataDir;

        return;
    }

    throw new Error(`无法获取数据目录锁：${path}`);
}

export function releaseDataDirLock(): void {
    if (heldDir === null) {
        return;
    }

    try {
        unlinkSync(lockPath(heldDir));
    }
    catch {
        // 退出阶段尽力而为
    }

    heldDir = null;
}
