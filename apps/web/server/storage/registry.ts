import type { Settings } from '../settings/setting-schema';
import { LocalStorageAdapter } from './local';
import { FtpStorageAdapter, OssStorageAdapter, QuarkStorageAdapter } from './stubs';
import type { StorageAdapter, StorageBackend } from './types';

const adapters = new Map<string, StorageAdapter>();

export function createStorageAdapter(
    kind: StorageBackend,
    albumDir: string,
    partitionSize: number,
): StorageAdapter {
    switch (kind) {
        case 'local':
            return new LocalStorageAdapter(albumDir, partitionSize);
        case 'quark':
            return new QuarkStorageAdapter();
        case 'oss':
            return new OssStorageAdapter();
        case 'ftp':
            return new FtpStorageAdapter();
    }
}

/** 同一相册 + 后端复用一个实例 */
export function storageForAlbum(albumDir: string, settings: Settings): StorageAdapter {
    const kind = settings.storage.default;
    const cacheKey = `${kind}:${settings.storage.partitionSize}:${albumDir}`;
    const cached = adapters.get(cacheKey);

    if (cached) {
        return cached;
    }

    const adapter = createStorageAdapter(kind, albumDir, settings.storage.partitionSize);

    adapters.set(cacheKey, adapter);

    return adapter;
}
