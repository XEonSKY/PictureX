import { basename, extname } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { allocateSequence } from '../album/album-meta';
import type { AlbumDatabase } from '../database/album';
import { ensureGlobalPixivIllustPlaceholder } from '../database/pixiv';
import { assets } from '../database/schemas/album';
import { logger } from '../logger';
import { parsePixivFilename } from '../pixiv/filename';
import { findAssetBySha, linkPixivAsset } from '../pixiv/store';
import { clearLocalPixivPageCache } from '../pixiv/local-assets';
import type { Settings } from '../settings/setting-schema';
import { storageForAlbum } from '../storage/registry';
import type { StoredObject } from '../storage/types';
import { extractMetadata, livePhotoSidecarPath } from './extractors';
import { KeyedMutex } from '../utils/keyed-mutex';
import { nowSeconds, toSeconds } from '../utils/time';

// 导入与 Pixiv 分P下载共用入库函数；两条路径各自先查重后插入，
// 跨路径并发仍可能同时通过检查，因此在内容哈希上再串行一次。
const storeLocks = new KeyedMutex();

export interface StoreNewAssetInput {
    settings: Settings
    albumDir: string
    db: AlbumDatabase
    filePath: string
    sha256: string
    size: number
    /** 入库文件名；默认取源文件 basename */
    filename?: string
    /** 追加到 assets.meta 的领域字段（如 pixiv 分P信息） */
    meta?: Record<string, unknown>
    /** 单次读取路径已写好的存储副本；提供时跳过 storage.put */
    stored?: StoredObject
}

export interface StoreNewAssetResult {
    assetId: string | null
    /** 不支持的格式：合法跳过，不计入错误 */
    skipped: boolean
}

/**
 * 把磁盘上的单个文件写入相册库（导入管道与 Pixiv 分P下载共用）。
 * 调用方负责重复检查与索引对账；这里只做元数据提取、序列分配、存储复制与行插入。
 */
export async function storeNewAsset(input: StoreNewAssetInput): Promise<StoreNewAssetResult> {
    return storeLocks.run(input.sha256, () => storeNewAssetLocked(input));
}

async function storeNewAssetLocked(input: StoreNewAssetInput): Promise<StoreNewAssetResult> {
    const storage = storageForAlbum(input.albumDir, input.settings);
    const existing = findAssetBySha(input.db, input.sha256);

    if (existing) {
        if (input.stored) {
            await storage.delete(input.stored.key).catch(() => undefined);
        }

        return { assetId: existing.id, skipped: true };
    }

    const metadata = await extractMetadata(input.filePath, input.settings);

    if (!metadata) {
        // 单次读取路径已经写好了副本：跳过入库时必须删掉，避免留下孤儿文件
        if (input.stored) {
            await storage.delete(input.stored.key).catch(() => undefined);
        }

        return { assetId: null, skipped: true };
    }

    const assetId = uuidv7();
    const ext = extname(input.filePath).slice(1).toLowerCase();
    const filename = input.filename ?? basename(input.filePath);
    // 导入时就记录 Pixiv 身份：后续 AI 打标据此排除，不依赖详情页是否打开过
    const pixivRef = parsePixivFilename(filename);
    const stored = input.stored ?? await storage.put({
        sequence: allocateSequence(input.db),
        ext,
        sourcePath: input.filePath,
    });
    let liveKey: string | null = null;
    let previewKey: string | null = null;

    try {
        if (metadata.preview) {
            const previewSequence = allocateSequence(input.db);
            const storedPreview = await storage.put({
                sequence: previewSequence,
                ext: 'jpg',
                data: metadata.preview,
            });

            previewKey = storedPreview.key;
            metadata.meta.preview = {
                storageKey: storedPreview.key,
                mime: 'image/jpeg',
                size: storedPreview.size,
            };
        }

        if (metadata.kind === 'dynamic') {
            const sidecar = livePhotoSidecarPath(input.filePath);

            if (sidecar) {
                try {
                    const liveExt = extname(sidecar).slice(1).toLowerCase();
                    const liveSequence = allocateSequence(input.db);
                    const liveStored = await storage.put({
                        sequence: liveSequence,
                        ext: liveExt,
                        sourcePath: sidecar,
                    });

                    liveKey = liveStored.key;
                    metadata.meta.live = {
                        storageKey: liveStored.key,
                        mime: liveExt === 'mov' ? 'video/quicktime' : 'video/mp4',
                        size: liveStored.size,
                    };
                }
                catch (error) {
                    logger.warn({ err: error, file: input.filePath }, 'failed to store live photo sidecar');
                    metadata.kind = 'image';
                }
            }
            else {
                metadata.kind = 'image';
            }
        }

        const now = nowSeconds();

        // pHash 不在入库热路径里算，交给后台相似度索引补齐
        input.db.insert(assets).values({
            id: assetId,
            storageKey: stored.key,
            filename,
            ext,
            mime: metadata.mime,
            kind: metadata.kind,
            size: input.size,
            width: metadata.width,
            height: metadata.height,
            durationMs: metadata.durationMs,
            sha256: input.sha256,
            phash: null,
            takenAt: toSeconds(metadata.takenAt),
            addedAt: now,
            meta: JSON.stringify({
                ...metadata.meta,
                ...(pixivRef ? { pixiv: pixivRef } : {}),
                ...input.meta,
            }),
        }).run();

        // 文件名已经给出 illustId/分P：先落相册映射；全局库只建作品占位行，
        // 详情由后台补全/汇总覆盖为最终数据
        if (pixivRef) {
            linkPixivAsset(input.db, pixivRef.illustId, pixivRef.pageIndex, assetId);
            ensureGlobalPixivIllustPlaceholder(pixivRef.illustId);
            clearLocalPixivPageCache();
        }

        return { assetId, skipped: false };
    }
    catch (error) {
        input.db.delete(assets).where(eq(assets.id, assetId)).run();
        await storage.delete(stored.key).catch(() => undefined);

        if (liveKey) {
            await storage.delete(liveKey).catch(() => undefined);
        }
        if (previewKey) {
            await storage.delete(previewKey).catch(() => undefined);
        }

        throw error;
    }
}
