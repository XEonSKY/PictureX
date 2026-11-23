import { logger } from '../logger';
import { KeyedMutex } from '../utils/keyed-mutex';
import { readCloudPixivImage, writeCloudPixivImage, type CloudPixivImage } from './cloud-cache';
import { assertPixivImageUrl, pixivImageHeaders, pixivRequestBuffer } from './http';

/**
 * 资料库图片的云端兜底：本地相册没有时下载 Pixiv 原图并写入 cloud.db。
 * 同一分P并发只下载一次；失败返回 null，由路由回退到现有的流式代理。
 */

const MAX_ORIGINAL_BYTES = 200 * 1024 * 1024;
const locks = new KeyedMutex();

function lockKey(illustId: string, pageIndex: number): string {
    return `${illustId}:${pageIndex}`;
}

export async function ensureCloudPixivImage(
    illustId: string,
    pageIndex: number,
    originalUrl: string,
): Promise<CloudPixivImage | null> {
    const existing = readCloudPixivImage(illustId, pageIndex);

    if (existing) {
        return existing;
    }

    return locks.run(lockKey(illustId, pageIndex), async () => {
        const cached = readCloudPixivImage(illustId, pageIndex);

        if (cached) {
            return cached;
        }

        try {
            assertPixivImageUrl(originalUrl);

            const response = await pixivRequestBuffer(originalUrl, {
                headers: pixivImageHeaders(),
                maxBytes: MAX_ORIGINAL_BYTES,
                timeoutMs: 60_000,
            });

            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Pixiv image returned ${response.status}`);
            }

            const mime = typeof response.headers['content-type'] === 'string'
                ? response.headers['content-type'].split(';')[0]?.trim() || 'image/jpeg'
                : 'image/jpeg';

            writeCloudPixivImage(illustId, pageIndex, mime, response.body);

            return {
                mime,
                blob: response.body,
                sizeBytes: response.body.byteLength,
                fetchedAt: Math.floor(Date.now() / 1000),
            };
        }
        catch (error) {
            logger.warn({ err: error, illustId, pageIndex }, 'failed to cache pixiv original');

            return null;
        }
    });
}
