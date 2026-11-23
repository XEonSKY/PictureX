import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFileSafe, writeJsonAtomic } from '../utils/atomic-json';
import type { DownloadIndexFile, DownloadTask } from './types';

const PERSIST_DELAY_MS = 800;

type Listener = (tasks: DownloadTask[]) => void;

/**
 * 下载任务清单 <downloadDir>/index.json。
 * 高频进度只更新内存并通知订阅者；落盘去掉 shards（分片进度在 *.session.json），
 * 并以 800ms 节流写入，避免频繁 IO。
 */
export class DownloadTaskStore {
    private data: DownloadIndexFile;
    private listeners = new Set<Listener>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly downloadDir: string) {
        mkdirSync(downloadDir, { recursive: true });
        this.data = this.load();
    }

    private load(): DownloadIndexFile {
        const raw = readJsonFileSafe<DownloadIndexFile>(join(this.downloadDir, 'index.json'));

        if (!raw || !Array.isArray(raw.tasks)) {
            return { schemaVersion: 1, tasks: [] };
        }

        for (const task of raw.tasks) {
            if (task.status === 'downloading' || task.status === 'queued') {
                task.status = 'paused';
                task.speedBps = 0;
            }

            for (const file of task.files) {
                file.shards = [];
            }
        }

        return raw;
    }

    private serialize(): DownloadIndexFile {
        return {
            schemaVersion: 1,
            tasks: this.data.tasks.map(task => ({
                ...task,
                files: task.files.map(file => ({ ...file, shards: [] })),
            })),
        };
    }

    private schedulePersist(): void {
        if (this.timer) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.persist();
        }, PERSIST_DELAY_MS);
        this.timer.unref?.();
    }

    persist(): void {
        writeJsonAtomic(join(this.downloadDir, 'index.json'), this.serialize());
    }

    index(): DownloadIndexFile {
        return this.data;
    }

    list(): DownloadTask[] {
        return this.data.tasks;
    }

    get(modelId: string): DownloadTask | undefined {
        return this.data.tasks.find(task => task.modelId === modelId);
    }

    create(task: DownloadTask): DownloadTask {
        this.data.tasks = this.data.tasks.filter(existing => existing.modelId !== task.modelId);
        this.data.tasks.push(task);
        this.emit();
        this.persist();

        return task;
    }

    update(modelId: string, mutator: (task: DownloadTask) => void, immediate = true): DownloadTask {
        const task = this.get(modelId);

        if (!task) {
            throw new Error(`download task not found: ${modelId}`);
        }

        mutator(task);
        task.updatedAt = new Date().toISOString();
        this.emit();

        if (immediate) {
            this.persist();
        }
        else {
            this.schedulePersist();
        }

        return task;
    }

    /** 高频进度：只通知 + 节流落盘 */
    touch(modelId: string, speedBps: number): void {
        const task = this.get(modelId);

        if (!task) {
            return;
        }

        task.speedBps = speedBps;
        task.updatedAt = new Date().toISOString();
        this.emit();
        this.schedulePersist();
    }

    remove(modelId: string): void {
        this.data.tasks = this.data.tasks.filter(task => task.modelId !== modelId);
        this.emit();
        this.persist();
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        const snapshot = this.data.tasks;

        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}

const stores = new Map<string, DownloadTaskStore>();

export function downloadTaskStore(downloadDir: string): DownloadTaskStore {
    const cached = stores.get(downloadDir);

    if (cached) {
        return cached;
    }

    const store = new DownloadTaskStore(downloadDir);

    stores.set(downloadDir, store);

    return store;
}
