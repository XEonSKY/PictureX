/**
 * 按 key 串化的异步互斥锁。
 *
 * 用于把「同一资源的并发异步操作」排成一条队列（如按 modelId 串行 verify），
 * 避免读-改-写跨越 await 边界时被另一路覆盖。不同 key 之间互不影响。
 */
export class KeyedMutex {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();

        let release: () => void = () => undefined;
        const settled = new Promise<void>((resolve) => {
            release = resolve;
        });

        const tail = previous.then(() => settled);

        this.tails.set(key, tail);

        // 等前一个任务结束（无论成败）再执行本任务
        await previous.catch(() => undefined);

        try {
            return await task();
        }
        finally {
            release();
            // 队列排空且没有新的等待者时删除 key，避免 Map 随模型数无限增长
            tail.then(() => {
                if (this.tails.get(key) === tail) {
                    this.tails.delete(key);
                }
            });
        }
    }
}
