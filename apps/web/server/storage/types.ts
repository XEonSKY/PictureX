import type { Readable } from 'node:stream';

export type StorageBackend = 'local' | 'quark' | 'oss' | 'ftp';

export interface StoragePutInput {
    /** 已分配的序列号，决定分区 */
    sequence: number
    ext: string
    /** 复制来源；与 data 二选一 */
    sourcePath?: string
    /** 内存写入；与 sourcePath 二选一 */
    data?: Buffer
}

export interface StoredObject {
    key: string
    size: number
}

export interface StorageHashPutInput {
    sequence: number
    ext: string
    sourcePath: string
}

export interface StorageStat {
    size: number
    mtimeMs: number
}

/**
 * 可插拔存储后端。
 * local 完整实现；quark / oss / ftp 为 stub，调用即抛 storage_backend_not_implemented。
 */
export interface StorageAdapter {
    readonly kind: StorageBackend
    put(input: StoragePutInput): Promise<StoredObject>
    /**
     * 可选：复制来源的同时计算 SHA-256（只读一次源文件）。
     * 不支持的后端省略此方法，调用方回退到「先哈希再 put」。
     */
    putWithHash?(input: StorageHashPutInput): Promise<StoredObject & { sha256: string }>
    open(key: string): Promise<Readable>
    stat(key: string): Promise<StorageStat>
    exists(key: string): Promise<boolean>
    delete(key: string): Promise<void>
    /** local 专用：Range 请求直接用文件路径；远端后端返回 null */
    localPath(key: string): string | null
}
