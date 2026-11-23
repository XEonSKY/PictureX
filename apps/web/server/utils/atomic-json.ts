import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * JSON 文件的原子读写：tmp + rename。
 * setting.json、相册 index/tag、模型与下载清单都走这里，避免半写文件。
 */

function fsyncPath(path: string): void {
    try {
        const fd = openSync(path, 'r');

        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        // Windows 上部分文件系统不支持对目录/句柄 fsync，忽略即可
    }
}

export function readJsonFile<T>(path: string): T | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    }
    catch {
        return undefined;
    }
}

export type JsonFileResult<T>
    = | { state: 'ok', value: T }
      | { state: 'missing' }
      | { state: 'corrupt' };

/**
 * 区分“文件不存在”与“文件存在但不是合法 JSON”。
 * 相册的 index.json / tag.json 必须保留这个区别：损坏不能被当成空数据，
 * 否则下一次写入会把旧内容清空。
 */
export function readJsonFileState<T>(path: string): JsonFileResult<T> {
    if (!existsSync(path)) {
        return { state: 'missing' };
    }

    try {
        return { state: 'ok', value: JSON.parse(readFileSync(path, 'utf8')) as T };
    }
    catch {
        return { state: 'corrupt' };
    }
}

export function writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });

    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(value, null, 4)}\n`;

    writeFileSync(tempPath, payload, 'utf8');
    // 先落盘再 rename，掉电后不会留下 0 字节的正式文件
    fsyncPath(tempPath);

    try {
        renameSync(tempPath, path);
        fsyncPath(dirname(path));
    }
    catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
}

/** 读取并保留损坏文件副本，返回 undefined 让调用方回退默认值 */
export function readJsonFileSafe<T>(path: string): T | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    }
    catch {
        const backup = `${path}.corrupt-${Date.now()}`;

        try {
            renameSync(path, backup);
        }
        catch {
            // 备份失败不阻塞启动
        }

        return undefined;
    }
}
