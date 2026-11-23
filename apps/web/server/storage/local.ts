import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { v7 as uuidv7 } from 'uuid';
import { storageKeyFor } from '../album/album-meta';
import type { StorageAdapter, StorageHashPutInput, StoragePutInput, StorageStat, StoredObject } from './types';

/**
 * 本地磁盘后端：storage/<4 位分区>/<uuidv7>.<ext>。
 * key 使用正斜杠，落盘时转成平台路径；所有路径必须落在相册目录内。
 */
export class LocalStorageAdapter implements StorageAdapter {
    readonly kind = 'local' as const;

    constructor(
        private readonly albumDir: string,
        private readonly partitionSize: number,
    ) {}

    private resolveKey(key: string): string {
        // 存储键一律是 storage/<分区>/<uuid>.<ext>：要求前缀，杜绝把相册根目录本身
        // 或 index.json / picture.db 等元数据当成媒体对象读写
        if (!/^storage\/[A-Za-z0-9._/-]+$/u.test(key) || key.includes('..')) {
            throw new Error(`storage key 越界: ${key}`);
        }

        const root = resolve(this.albumDir);
        const target = resolve(root, key);
        const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;

        if (!target.startsWith(normalizedRoot)) {
            throw new Error(`storage key 越界: ${key}`);
        }

        return target;
    }

    async put(input: StoragePutInput): Promise<StoredObject> {
        const key = storageKeyFor(input.sequence, this.partitionSize, input.ext, uuidv7());
        const target = this.resolveKey(key);

        await mkdir(dirname(target), { recursive: true });

        if (input.sourcePath) {
            await copyFile(input.sourcePath, target);
        }
        else if (input.data) {
            await writeFile(target, input.data);
        }
        else {
            throw new Error('put 需要 sourcePath 或 data');
        }

        const info = await stat(target);

        return { key, size: info.size };
    }

    async open(key: string): Promise<Readable> {
        return createReadStream(this.resolveKey(key));
    }

    /** 单次读取：边复制边算 SHA-256，避免大文件为哈希再读一遍源文件 */
    async putWithHash(input: StorageHashPutInput): Promise<StoredObject & { sha256: string }> {
        const key = storageKeyFor(input.sequence, this.partitionSize, input.ext, uuidv7());
        const target = this.resolveKey(key);

        await mkdir(dirname(target), { recursive: true });

        const hash = createHash('sha256');

        try {
            await pipeline(
                createReadStream(input.sourcePath),
                new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        hash.update(chunk);
                        callback(null, chunk);
                    },
                }),
                createWriteStream(target),
            );
        }
        catch (error) {
            // 半写文件没有任何行引用，直接清掉
            await rm(target, { force: true }).catch(() => undefined);

            throw error;
        }

        const info = await stat(target);

        return { key, size: info.size, sha256: hash.digest('hex') };
    }

    async stat(key: string): Promise<StorageStat> {
        const info = await stat(this.resolveKey(key));

        return { size: info.size, mtimeMs: info.mtimeMs };
    }

    async exists(key: string): Promise<boolean> {
        try {
            await stat(this.resolveKey(key));

            return true;
        }
        catch {
            return false;
        }
    }

    async delete(key: string): Promise<void> {
        await rm(this.resolveKey(key), { force: true });
    }

    localPath(key: string): string | null {
        return this.resolveKey(key);
    }
}
