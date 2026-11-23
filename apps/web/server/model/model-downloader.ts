import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { ApiError } from '../hono/problem';
import { getSettings } from '../settings/setting-store';
import type { Settings } from '../settings/setting-schema';
import { readJsonFileSafe, writeJsonAtomic } from '../utils/atomic-json';
import { describeDataDirectories } from '../utils/data-dir';
import { sha256File } from '../utils/hash';
import { KeyedMutex } from '../utils/keyed-mutex';
import { downloadTaskStore, type DownloadTaskStore } from './download-task-store';
import { assertWithinRoot, isValidModelId, modelRegistry, type ModelRegistry } from './model-registry';
import type {
    DownloadFileState,
    DownloadTask,
    FileSession,
    InstalledFile,
    ModelEntry,
    ShardState,
} from './types';

const SHARD_SIZE = 4 * 1024 * 1024;
const MAX_SHARDS = 32;
const PROGRESS_INTERVAL_MS = 500;
const SESSION_INTERVAL_MS = 2000;
const PAUSE_GRACE_MS = 5000;

interface ActiveDownload {
    controller: AbortController
    stopRequested: boolean
    promise: Promise<void>
}

interface ProbeResult {
    size: number
    acceptRanges: boolean
    etag: string
    lastModified: string
}

class RangeRestartError extends Error {}
class PauseSignal extends Error {}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'));
}

const FETCH_ATTEMPTS = 6;

function retryDelay(attempt: number): number {
    return Math.min(15_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/**
 * undici 的连接超时固定在 10s 且不可配置，镜像站点冷启动握手经常超过它；
 * 因此对网络错误与 5xx/429 做指数退避重试，而不是调大超时。
 */
async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let lastError = '';

    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(url, { ...init, signal });

            if (response.status < 500 && response.status !== 429) {
                return response;
            }

            await response.body?.cancel();
            lastError = `remote returned ${response.status}`;
        }
        catch (error) {
            if (isAbortError(error)) {
                throw error;
            }

            lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempt < FETCH_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
        }
    }

    throw new Error(`request failed after ${FETCH_ATTEMPTS} attempts: ${lastError}`);
}

function planShards(size: number): ShardState[] {
    if (size <= 0) {
        return [{ index: 0, start: 0, end: -1, downloaded: 0 }];
    }

    const shardSize = Math.max(SHARD_SIZE, Math.ceil(size / MAX_SHARDS));
    const count = Math.max(1, Math.ceil(size / shardSize));
    const shards: ShardState[] = [];

    for (let index = 0; index < count; index += 1) {
        const start = index * shardSize;
        const end = Math.min(size - 1, start + shardSize - 1);

        shards.push({ index, start, end, downloaded: 0 });
    }

    return shards;
}

function taskDirFor(downloadDir: string, modelId: string): string {
    // 下载清单是本地可编辑 JSON：递归删除前必须再断言一次路径不越界
    return assertWithinRoot(downloadDir, join(downloadDir, modelId));
}

function partPathFor(taskDir: string, file: DownloadFileState): string {
    return join(taskDir, `${file.path}.part`);
}

function sessionPathFor(taskDir: string, file: DownloadFileState): string {
    return join(taskDir, `${file.path}.session.json`);
}

/**
 * 断点续传模型下载器：
 * - HTTP Range 分片并发（p-limit）
 * - .part + .session.json 断点续传；If-Range 处理服务端文件变更
 * - 暂停等待在飞分片收尾；取消立即中止并清理
 * - 安装走「复制 → 校验 → 删除」，跨盘（EXDEV）安全
 */
export class ModelDownloader {
    private readonly registry: ModelRegistry;
    private readonly store: DownloadTaskStore;
    private readonly downloadDir: string;
    private readonly settings: Settings;
    private readonly active = new Map<string, ActiveDownload>();
    private readonly startLock = new KeyedMutex();

    constructor(options: {
        settings?: Settings
        downloadDir?: string
        registry?: ModelRegistry
        store?: DownloadTaskStore
    } = {}) {
        const settings = options.settings ?? getSettings();

        this.settings = settings;
        this.downloadDir = options.downloadDir ?? describeDataDirectories().downloadDir;
        this.registry = options.registry ?? modelRegistry(settings);
        this.store = options.store ?? downloadTaskStore(this.downloadDir);
    }

    hasActiveDownloads(): boolean {
        return this.active.size > 0;
    }

    listTasks(): DownloadTask[] {
        return this.store.list();
    }

    /** 只移除已结束的下载记录；运行/暂停中的任务必须先暂停或取消 */
    removeTask(modelId: string): boolean {
        const task = this.store.get(modelId);

        if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) {
            return false;
        }

        this.store.remove(modelId);

        return true;
    }

    subscribe(listener: (tasks: DownloadTask[]) => void): () => void {
        return this.store.subscribe(listener);
    }

    getTask(modelId: string): DownloadTask | undefined {
        return this.store.get(modelId);
    }

    async start(modelId: string): Promise<DownloadTask> {
        // 同一 modelId 串行启动：否则两个并发 POST 都在 await verify 时看到 active 为空，
        // 双双通过、各起一个下载。
        return this.startLock.run(modelId, () => this.startInner(modelId));
    }

    private async startInner(modelId: string): Promise<DownloadTask> {
        const running = this.active.get(modelId);

        if (running) {
            return this.store.get(modelId) ?? this.createTask(this.registry.get(modelId));
        }

        const entry = this.registry.get(modelId);

        if (entry.broken) {
            throw new ApiError(409, 'model_unsupported', 'This model build is incompatible with the bundled ONNX Runtime.');
        }

        if (entry.status === 'installed') {
            const verified = await this.registry.verify(modelId);

            if (verified.status === 'installed') {
                throw new ApiError(409, 'model_already_installed', 'The model is already installed.');
            }
        }

        let task = this.store.get(modelId);

        if (!task || task.status === 'completed' || task.status === 'cancelled') {
            task = this.store.create(this.createTask(entry));
        }
        else {
            // 恢复前同步清单（URL/SHA 可能已更新）；size=0 表示未知，保留已探测值
            for (const spec of entry.files) {
                const target = task.files.find(item => item.path === spec.path);

                if (target) {
                    target.url = spec.url;

                    if (spec.size > 0) {
                        target.size = spec.size;
                    }

                    target.sha256 = spec.sha256;
                }
                else {
                    // 清单新增的文件必须补进旧任务，否则安装时 copyFile 会 ENOENT
                    task.files.push({
                        path: spec.path,
                        url: spec.url,
                        size: spec.size,
                        sha256: spec.sha256,
                        bytesDone: 0,
                        status: 'pending',
                        etag: '',
                        lastModified: '',
                        shards: [],
                    });
                }
            }

            task.totalBytes = task.files.reduce((sum, item) => sum + item.size, 0);
        }

        this.store.update(modelId, (current) => {
            current.status = 'downloading';
            current.error = null;
            current.speedBps = 0;
        });

        const active: ActiveDownload = {
            controller: new AbortController(),
            stopRequested: false,
            promise: Promise.resolve(),
        };

        this.active.set(modelId, active);
        active.promise = this.run(task, active)
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);

                try {
                    this.store.update(modelId, (current) => {
                        current.status = 'failed';
                        current.speedBps = 0;
                        current.error = message;
                    }, true);
                }
                catch {
                    // 任务记录已被移除时忽略
                }
            })
            .finally(() => {
                this.active.delete(modelId);
                this.store.persist();
            });

        return task;
    }

    async pause(modelId: string): Promise<DownloadTask> {
        const task = this.store.get(modelId);

        if (!task) {
            throw new ApiError(404, 'download_not_found', 'The download task does not exist.');
        }

        const active = this.active.get(modelId);

        if (active) {
            active.stopRequested = true;

            const grace = setTimeout(() => active.controller.abort(), PAUSE_GRACE_MS);
            grace.unref?.();

            await active.promise;
            clearTimeout(grace);
        }

        if (task.status === 'downloading') {
            this.store.update(modelId, (current) => {
                current.status = 'paused';
                current.speedBps = 0;
            });
        }

        return task;
    }

    async resume(modelId: string): Promise<DownloadTask> {
        const task = this.store.get(modelId);

        if (!task) {
            throw new ApiError(404, 'download_not_found', 'The download task does not exist.');
        }

        return this.start(modelId);
    }

    async cancel(modelId: string): Promise<DownloadTask> {
        if (!isValidModelId(modelId)) {
            throw new ApiError(404, 'download_not_found', 'The download task does not exist.');
        }

        const task = this.store.get(modelId);

        if (!task) {
            throw new ApiError(404, 'download_not_found', 'The download task does not exist.');
        }

        if (task.status !== 'queued' && task.status !== 'downloading' && task.status !== 'paused') {
            throw new ApiError(409, 'download_not_running', 'The download task is not running.');
        }

        const active = this.active.get(modelId);

        if (active) {
            active.stopRequested = true;
            active.controller.abort();
            await active.promise;
        }

        await rm(taskDirFor(this.downloadDir, modelId), { recursive: true, force: true });
        this.store.update(modelId, (current) => {
            current.status = 'cancelled';
            current.speedBps = 0;
            current.error = null;
        });

        return task;
    }

    async shutdown(): Promise<void> {
        const pauses: Promise<DownloadTask>[] = [];

        for (const modelId of this.active.keys()) {
            pauses.push(this.pause(modelId));
        }

        await Promise.allSettled(pauses);
        this.store.persist();
    }

    private createTask(entry: ModelEntry): DownloadTask {
        const now = new Date().toISOString();
        const files: DownloadFileState[] = entry.files.map(file => ({
            path: file.path,
            url: file.url,
            size: file.size,
            sha256: file.sha256,
            bytesDone: 0,
            status: 'pending',
            etag: '',
            lastModified: '',
            shards: [],
        }));

        return {
            modelId: entry.id,
            status: 'downloading',
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            bytesDone: 0,
            speedBps: 0,
            files,
            createdAt: now,
            updatedAt: now,
            error: null,
        };
    }

    private async run(task: DownloadTask, active: ActiveDownload): Promise<void> {
        const concurrency = Math.max(1, Math.min(16, this.settings.ai.downloadConcurrency));
        const taskDir = taskDirFor(this.downloadDir, task.modelId);

        let lastTime = Date.now();
        let lastBytes = task.bytesDone;

        const ticker = setInterval(() => {
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;

            if (elapsed <= 0) {
                return;
            }

            const speed = Math.max(0, Math.round((task.bytesDone - lastBytes) / elapsed));

            lastTime = now;
            lastBytes = task.bytesDone;
            this.store.touch(task.modelId, active.stopRequested ? 0 : speed);
        }, PROGRESS_INTERVAL_MS);

        ticker.unref?.();

        try {
            await mkdir(taskDir, { recursive: true });

            for (const file of task.files) {
                if (active.stopRequested) {
                    break;
                }
                if (file.status === 'completed') {
                    continue;
                }

                this.store.update(task.modelId, (current) => {
                    const target = current.files.find(item => item.path === file.path);

                    if (target) {
                        target.status = 'downloading';
                    }
                }, false);

                await this.downloadFile(task, file, taskDir, active, concurrency);

                this.store.update(task.modelId, (current) => {
                    const target = current.files.find(item => item.path === file.path);

                    if (target) {
                        target.status = 'completed';
                        target.bytesDone = target.size;
                    }
                });
            }

            if (active.stopRequested) {
                throw new PauseSignal();
            }

            await this.install(task, taskDir);
            const verified = await this.registry.verify(task.modelId);

            if (verified.status !== 'installed') {
                throw new Error(verified.error ?? 'model verification failed');
            }

            await rm(taskDir, { recursive: true, force: true });
            this.store.update(task.modelId, (current) => {
                current.status = 'completed';
                current.speedBps = 0;
                current.bytesDone = current.totalBytes;
                current.error = null;
            }, true);
        }
        catch (error) {
            if (active.stopRequested || error instanceof PauseSignal || isAbortError(error)) {
                this.store.update(task.modelId, (current) => {
                    current.status = 'paused';
                    current.speedBps = 0;
                }, true);

                return;
            }

            const message = error instanceof Error ? error.message : String(error);

            this.store.update(task.modelId, (current) => {
                current.status = 'failed';
                current.speedBps = 0;
                current.error = message;
            }, true);
        }
        finally {
            clearInterval(ticker);
            this.store.touch(task.modelId, 0);
            this.store.persist();
        }
    }

    /**
     * 只用一次 Range GET 完成探测：HEAD 的 content-length 可能是传输编码（gzip）后的长度，
     * 且镜像站握手慢，少一次请求就少一次超时机会。
     */
    private async probe(url: string, signal: AbortSignal): Promise<ProbeResult> {
        const res = await fetchWithRetry(url, { headers: { Range: 'bytes=0-0' } }, signal);
        const contentRange = res.headers.get('content-range');
        // Range 探测的 content-length 是这 1 个字节的长度，不能当文件总长；
        // 只有 206 + content-range 才是权威长度，否则回退整段下载。
        const total = contentRange ? Number(contentRange.split('/')[1]) : 0;
        const authoritativeSize = Number.isFinite(total) && total > 0 ? total : 0;

        await res.body?.cancel();

        return {
            size: authoritativeSize,
            acceptRanges: res.status === 206 && authoritativeSize > 0,
            etag: res.headers.get('etag') ?? '',
            lastModified: res.headers.get('last-modified') ?? '',
        };
    }

    private async downloadFile(
        task: DownloadTask,
        file: DownloadFileState,
        taskDir: string,
        active: ActiveDownload,
        concurrency: number,
    ): Promise<void> {
        const finalPath = join(taskDir, file.path);
        const partPath = partPathFor(taskDir, file);
        const sessionPath = sessionPathFor(taskDir, file);

        await mkdir(dirname(finalPath), { recursive: true });

        const probe = await this.probe(file.url, active.controller.signal);
        // 只有服务端真的支持 Range 时，探测到的长度才可信：镜像对小文件用 gzip 传输，
        // HEAD 的 content-length 是压缩后的字节数，与落盘大小无关。
        const authoritative = probe.acceptRanges && probe.size > 0;

        if (authoritative && file.size !== probe.size) {
            task.bytesDone -= file.bytesDone;
            file.bytesDone = 0;
            file.size = probe.size;
            task.totalBytes = task.files.reduce((sum, item) => sum + item.size, 0);
        }

        if (!authoritative && file.size !== 0) {
            task.totalBytes -= file.size;
            file.size = 0;
        }

        if (!authoritative) {
            await this.downloadWhole(task, file, partPath, active);

            return;
        }

        const session = readJsonFileSafe<FileSession>(sessionPath);
        const hasPart = existsSync(partPath);
        const validSession = Boolean(
            session
            && hasPart
            && session.url === file.url
            && session.size === probe.size
            && (probe.etag === '' || session.etag === probe.etag)
            && (probe.lastModified === '' || session.lastModified === probe.lastModified),
        );

        const shards: ShardState[] = validSession && session
            ? session.shards.map(shard => ({
                ...shard,
                downloaded: Math.max(0, Math.min(shard.downloaded, shard.end - shard.start + 1)),
            }))
            : planShards(probe.size);

        if (!validSession) {
            task.bytesDone -= file.bytesDone;
            file.bytesDone = 0;
            await rm(partPath, { force: true });
        }

        file.etag = probe.etag;
        file.lastModified = probe.lastModified;

        try {
            await this.runShards(task, file, partPath, sessionPath, probe, shards, active, concurrency);
        }
        catch (error) {
            if (error instanceof RangeRestartError) {
                await this.downloadWhole(task, file, partPath, active);

                return;
            }

            throw error;
        }

        await rm(finalPath, { force: true });
        await rename(partPath, finalPath);
        await rm(sessionPath, { force: true });
        await this.verifyFile(finalPath, file);
    }

    private async runShards(
        task: DownloadTask,
        file: DownloadFileState,
        partPath: string,
        sessionPath: string,
        probe: ProbeResult,
        shards: ShardState[],
        active: ActiveDownload,
        concurrency: number,
    ): Promise<void> {
        const handle = await open(partPath, existsSync(partPath) ? 'r+' : 'w+');
        let lastSessionWrite = Date.now();

        try {
            const limit = pLimit(concurrency);

            const persistSession = async (): Promise<void> => {
                const session: FileSession = {
                    url: file.url,
                    etag: probe.etag,
                    lastModified: probe.lastModified,
                    size: probe.size,
                    shards,
                };

                writeJsonAtomic(sessionPath, session);
            };

            try {
                await Promise.all(shards.map(shard => limit(async () => {
                    await this.downloadShard(task, file, handle, shard, probe, active, async () => {
                        if (Date.now() - lastSessionWrite > SESSION_INTERVAL_MS) {
                            lastSessionWrite = Date.now();
                            await persistSession();
                        }
                    });
                })));
            }
            catch (error) {
                await persistSession();
                throw error;
            }

            await persistSession();
        }
        finally {
            await handle.close();
        }
    }

    private async downloadShard(
        task: DownloadTask,
        file: DownloadFileState,
        handle: Awaited<ReturnType<typeof open>>,
        shard: ShardState,
        probe: ProbeResult,
        active: ActiveDownload,
        onProgress: () => Promise<void>,
    ): Promise<void> {
        const length = shard.end - shard.start + 1;
        let remaining = length - shard.downloaded;

        if (remaining <= 0) {
            return;
        }

        let position = shard.start + shard.downloaded;

        while (remaining > 0 && !active.stopRequested) {
            const headers: Record<string, string> = {
                Range: `bytes=${position}-${shard.end}`,
            };

            if (position > shard.start) {
                const validator = probe.etag || probe.lastModified;

                if (validator) {
                    headers['If-Range'] = validator;
                }
            }

            const res = await fetchWithRetry(file.url, { headers }, active.controller.signal);

            if (res.status === 416 && remaining === 0) {
                return;
            }

            if (res.status === 200 && position > 0) {
                await res.body?.cancel();
                throw new RangeRestartError('server ignored Range');
            }

            if (!res.ok || !res.body) {
                throw new Error(`HTTP ${res.status} for ${file.path}`);
            }

            const reader = res.body.getReader();

            while (remaining > 0) {
                if (active.stopRequested) {
                    await reader.cancel();
                    throw new PauseSignal();
                }

                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                if (!value || value.byteLength === 0) {
                    continue;
                }

                const chunk = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, remaining));

                await handle.write(chunk, 0, chunk.byteLength, position);

                position += chunk.byteLength;
                shard.downloaded += chunk.byteLength;
                file.bytesDone += chunk.byteLength;
                remaining -= chunk.byteLength;
                task.bytesDone += chunk.byteLength;
                await onProgress();
            }
        }

        if (remaining > 0 && !active.stopRequested) {
            throw new Error(`incomplete shard for ${file.path}`);
        }
    }

    private async downloadWhole(
        task: DownloadTask,
        file: DownloadFileState,
        partPath: string,
        active: ActiveDownload,
    ): Promise<void> {
        // 服务端不支持 Range 时总长只能在下载过程中确定，进度按已写字节实时累加
        const unknownSize = file.size === 0;

        task.totalBytes -= unknownSize ? file.bytesDone : 0;
        task.bytesDone -= file.bytesDone;
        file.bytesDone = 0;

        const res = await fetchWithRetry(file.url, {}, active.controller.signal);

        if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status} for ${file.path}`);
        }

        const target = createWriteStream(partPath);
        const reader = res.body.getReader();

        try {
            while (true) {
                if (active.stopRequested) {
                    await reader.cancel();
                    throw new PauseSignal();
                }

                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                if (!value || value.byteLength === 0) {
                    continue;
                }

                const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);

                file.bytesDone += chunk.byteLength;
                task.bytesDone += chunk.byteLength;

                if (unknownSize) {
                    task.totalBytes += chunk.byteLength;
                }

                if (!target.write(chunk)) {
                    await new Promise<void>(resolve => target.once('drain', () => resolve()));
                }
            }

            await new Promise<void>((resolve, reject) => {
                target.end(() => resolve());
                target.once('error', reject);
            });
        }
        catch (error) {
            target.destroy();
            throw error;
        }

        if (unknownSize) {
            file.size = file.bytesDone;
        }

        const finalPath = partPath.replace(/\.part$/u, '');

        await rm(finalPath, { force: true });
        await rename(partPath, finalPath);
        await this.verifyFile(finalPath, file);
    }

    private async verifyFile(path: string, file: DownloadFileState): Promise<void> {
        const info = await stat(path);

        if (file.size > 0 && info.size !== file.size) {
            await rm(path, { force: true });
            throw new Error(`size mismatch for ${file.path}`);
        }

        if (file.sha256) {
            const hash = await sha256File(path);

            if (hash !== file.sha256) {
                await rm(path, { force: true });
                throw new Error(`checksum mismatch for ${file.path}`);
            }
        }
    }

    private async install(task: DownloadTask, taskDir: string): Promise<void> {
        const modelDir = this.registry.dirFor(task.modelId);

        await mkdir(modelDir, { recursive: true });

        const installed: InstalledFile[] = [];
        // 源文件先不删：若后期某个文件复制/校验失败，前面已安装的源仍在下载目录，
        // 重试时能重新复制。否则 completed 文件被跳过、源又被删，第二次 install 直接 ENOENT 死循环。
        const sources: string[] = [];

        for (const file of task.files) {
            const source = join(taskDir, file.path);
            const target = join(modelDir, file.path);
            const staging = `${target}.tmp-${process.pid}`;

            await mkdir(dirname(target), { recursive: true });
            // 跨盘不能 rename（EXDEV）：复制到同目录临时文件，校验通过后再原子替换
            await copyFile(source, staging);

            try {
                const info = await stat(staging);
                const size = info.size;
                let sha256 = '';

                if (file.size > 0 && size !== file.size) {
                    throw new Error(`size mismatch for ${file.path}`);
                }

                if (file.sha256) {
                    sha256 = await sha256File(staging);

                    if (sha256 !== file.sha256) {
                        throw new Error(`checksum mismatch for ${file.path}`);
                    }
                }

                await rename(staging, target);
                installed.push({ path: file.path, size, sha256 });
            }
            catch (error) {
                await rm(staging, { force: true });
                throw error;
            }

            sources.push(source);
        }

        this.registry.markInstalled(task.modelId, installed);

        // 全部复制、校验、登记成功后，才清理下载目录里的源文件
        for (const source of sources) {
            await unlink(source).catch(() => undefined);
        }
    }
}

let singleton: ModelDownloader | null = null;

export function modelDownloader(): ModelDownloader {
    singleton ??= new ModelDownloader();

    return singleton;
}

export function resetModelDownloader(): void {
    singleton = null;
}
