import { availableParallelism } from 'node:os';

/**
 * 并行度按机器核数计算，而不是写死常量。
 * 扫描同时做解码/缩略图/复制，属于 CPU+IO 混合负载，保留 1 个核给主线程与 SQLite。
 */
export function importConcurrency(): number {
    return Math.max(2, Math.min(8, availableParallelism() - 1));
}

/** 后台 pHash 与缩略图解码同源，上限略低，避免和扫描抢满 CPU */
export function phashConcurrency(): number {
    return Math.max(2, Math.min(6, availableParallelism() - 1));
}

/** SHA-256 worker 池：只做流式哈希，2–4 个足够，避免与解码争核 */
export function shaPoolSize(): number {
    return Math.max(1, Math.min(4, availableParallelism() - 2));
}
