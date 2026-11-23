import { Worker } from 'node:worker_threads';
import { shaPoolSize } from './concurrency';
import { sha256File } from './hash';

/**
 * SHA-256 文件哈希池。
 * Node/OpenSSL 的单次哈希会自动使用 SHA-NI/ARM Crypto 扩展，但 `hash.update` 在
 * 主线程执行；扫描并发时多个流会把哈希压到同一个事件循环上。这里用 worker_threads
 * 把读取+哈希分摊到多核，主线程继续做解码/缩略图/写库。
 */

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');

parentPort.on('message', ({ id, path }) => {
    const hash = createHash('sha256');
    let settled = false;
    const finish = (payload) => {
        if (settled) return;
        settled = true;
        parentPort.postMessage({ id, ...payload });
    };
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => finish({ error: error.message }));
    stream.on('end', () => finish({ hash: hash.digest('hex') }));
});
`;

interface HashJob {
    path: string
    resolve: (hash: string) => void
    reject: (error: Error) => void
    timer?: ReturnType<typeof setTimeout>
}

interface Slot {
    worker: Worker
    job: HashJob | null
}

const queue: HashJob[] = [];
const slots: Slot[] = [];
let disabled = false;

/** 网络盘/坏文件可能让 worker 永久卡住，超时后回退主线程 */
const JOB_TIMEOUT_MS = 120_000;

function settle(job: HashJob): void {
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = undefined;
    }
}

function createSlot(): Slot {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    const slot: Slot = { worker, job: null };

    worker.unref();
    worker.on('message', (message: { id?: number, hash?: string, error?: string }) => {
        const job = slot.job;

        if (!job) {
            return;
        }

        slot.job = null;

        if (typeof message.hash === 'string') {
            settle(job);
            job.resolve(message.hash);
        }
        else {
            settle(job);
            job.reject(new Error(message.error ?? 'hash worker failed'));
        }

        dispatch();
    });
    worker.on('error', () => {
        const job = slot.job;

        slot.job = null;
        removeSlot(slot);

        if (job) {
            // worker 挂了就退回单线程，文件本身仍然能导入；其它 worker 继续工作
            settle(job);
            sha256File(job.path).then(job.resolve, job.reject);
        }

        dispatch();
    });
    worker.on('exit', () => {
        if (!slots.includes(slot)) {
            return;
        }

        const job = slot.job;

        slot.job = null;
        removeSlot(slot);

        if (job) {
            settle(job);
            sha256File(job.path).then(job.resolve, job.reject);
        }

        dispatch();
    });

    return slot;
}

function removeSlot(slot: Slot): void {
    const index = slots.indexOf(slot);

    if (index >= 0) {
        slots.splice(index, 1);
    }
}

function dispatch(): void {
    while (queue.length > 0) {
        let slot = slots.find(item => item.job === null);

        if (!slot) {
            if (slots.length >= shaPoolSize()) {
                return;
            }

            try {
                slot = createSlot();
                slots.push(slot);
            }
            catch {
                disabled = true;

                const job = queue.shift();

                if (job) {
                    sha256File(job.path).then(job.resolve, job.reject);
                }

                continue;
            }
        }

        const job = queue.shift();

        if (!job) {
            return;
        }

        slot.job = job;
        job.timer = setTimeout(() => {
            if (slot.job !== job) {
                return;
            }

            slot.job = null;
            removeSlot(slot);
            void slot.worker.terminate().catch(() => undefined);
            settle(job);
            sha256File(job.path).then(job.resolve, job.reject);
            dispatch();
        }, JOB_TIMEOUT_MS);
        job.timer.unref?.();
        slot.worker.postMessage({ id: 0, path: job.path });
    }
}

/** 多核并行 SHA-256；池不可用时透明回退到单线程 */
export function sha256FileAccelerated(path: string): Promise<string> {
    if (disabled || shaPoolSize() <= 1) {
        return sha256File(path);
    }

    return new Promise<string>((resolve, reject) => {
        queue.push({ path, resolve, reject });
        dispatch();
    });
}
