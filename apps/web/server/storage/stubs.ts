import type { Readable } from 'node:stream';
import { ApiError } from '../hono/problem';
import type { StorageAdapter, StorageBackend, StoragePutInput, StorageStat, StoredObject } from './types';

/** 远端存储占位实现：接口完整，行为统一报 501，便于后续替换 */
abstract class StubStorageAdapter implements StorageAdapter {
    abstract readonly kind: StorageBackend;

    private unsupported(): never {
        throw new ApiError(501, 'storage_backend_not_implemented', `The "${this.kind}" storage backend is not implemented yet.`);
    }

    put(_input: StoragePutInput): Promise<StoredObject> {
        return this.unsupported();
    }

    open(_key: string): Promise<Readable> {
        return this.unsupported();
    }

    stat(_key: string): Promise<StorageStat> {
        return this.unsupported();
    }

    exists(_key: string): Promise<boolean> {
        return this.unsupported();
    }

    delete(_key: string): Promise<void> {
        return this.unsupported();
    }

    localPath(_key: string): string | null {
        return null;
    }
}

export class QuarkStorageAdapter extends StubStorageAdapter {
    readonly kind = 'quark' as const;
}

export class OssStorageAdapter extends StubStorageAdapter {
    readonly kind = 'oss' as const;
}

export class FtpStorageAdapter extends StubStorageAdapter {
    readonly kind = 'ftp' as const;
}
