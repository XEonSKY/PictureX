export type ModelTask = 'zero-shot' | 'captioning';

export type ModelStatus = 'available' | 'installed' | 'corrupted';

export interface ModelFileSpec {
    /** 相对 model 目录的路径，保留子目录 */
    path: string
    url: string
    /** 0 表示未知（首次下载后回填） */
    size: number
    /** 可选；存在则做 SHA-256 校验 */
    sha256: string
}

export interface InstalledFile {
    path: string
    size: number
    sha256: string
}

export interface ModelEntry {
    id: string
    name: string
    task: ModelTask
    description: string
    status: ModelStatus
    totalBytes: number
    files: ModelFileSpec[]
    installedFiles: InstalledFile[]
    installedAt: string | null
    updatedAt: string
    error: string | null
    /** 已知与当前 onnxruntime-node 不兼容，不能下载也不能选为推理模型 */
    broken?: boolean
}

export interface ModelIndexFile {
    schemaVersion: 1
    models: ModelEntry[]
}

export interface ModelDefinition {
    id: string
    name: string
    task: ModelTask
    description: string
    files: ModelFileSpec[]
    /** 已知与当前 onnxruntime-node 不兼容，禁止下载与选择 */
    broken?: boolean
}

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ShardState {
    index: number
    start: number
    end: number
    downloaded: number
}

export interface DownloadFileState {
    path: string
    url: string
    size: number
    sha256: string
    bytesDone: number
    status: 'pending' | 'downloading' | 'completed' | 'failed'
    etag: string
    lastModified: string
    shards: ShardState[]
}

export interface DownloadTask {
    modelId: string
    status: DownloadStatus
    totalBytes: number
    bytesDone: number
    speedBps: number
    files: DownloadFileState[]
    createdAt: string
    updatedAt: string
    error: string | null
}

export interface DownloadIndexFile {
    schemaVersion: 1
    tasks: DownloadTask[]
}

export interface FileSession {
    url: string
    etag: string
    lastModified: string
    size: number
    shards: ShardState[]
}
