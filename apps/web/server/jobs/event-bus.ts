import { EventEmitter } from 'node:events';

export type JobStatus = 'queued' | 'running' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface ImportJobEvent {
    type: 'import'
    albumId: string
    jobId: string
    status: JobStatus
    total: number
    processed: number
    added: number
    duplicates: number
    skipped: number
    errors: number
    updatedAt: string
}

export interface DownloadJobEvent {
    type: 'download'
    modelId: string
    status: JobStatus
    bytesDone: number
    totalBytes: number
    speedBps: number
    updatedAt: string
}

export interface AiJobEvent {
    type: 'ai'
    albumId: string
    jobId: string
    status: JobStatus
    total: number
    processed: number
    errors: number
    updatedAt: string
}

export type JobEvent = ImportJobEvent | DownloadJobEvent | AiJobEvent;

/** 进程内任务事件总线：SSE 路由订阅，业务模块 publish */
class JobsBus {
    private readonly emitter = new EventEmitter();

    constructor() {
        this.emitter.setMaxListeners(1_000);
    }

    publish(event: JobEvent): void {
        this.emitter.emit('event', event);
        this.emitter.emit(`event:${event.type}`, event);
    }

    subscribe(listener: (event: JobEvent) => void): () => void {
        this.emitter.on('event', listener);

        return () => this.emitter.off('event', listener);
    }
}

export const jobsBus = new JobsBus();
