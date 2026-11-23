import { join } from 'node:path';
import { createThumbStore } from '../album/thumb-store';
import { optimizeAlbumDatabases, registerAlbumIdleHook } from '../database/album';
import { logger } from '../logger';
import { getSettings } from '../settings/setting-store';
import { readJsonFile } from '../utils/atomic-json';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 数据根目录缩略图库自动维护：
 * - 连接空闲关闭前执行一次（LRU、损坏行、WAL 截断、按碎片率 VACUUM）
 * - 长期活跃的相册每小时维护一次（跳过有导入/AI/相似度租约的连接）
 */
export default defineNitroPlugin((nitroApp) => {
    const unregister = registerAlbumIdleHook((albumDir, handle) => {
        const settings = getSettings();

        if (!settings.thumbnails.autoOptimize) {
            return;
        }

        const albumId = readJsonFile<{ id?: unknown }>(join(albumDir, 'index.json'))?.id;

        if (typeof albumId !== 'string' || albumId.trim() === '') {
            return;
        }

        const result = createThumbStore(handle.thumbnails, settings.thumbnails.dbMaxSizeMb, albumId.trim()).optimize();

        if (result.removed > 0 || result.vacuumed) {
            logger.debug({
                albumDir,
                removed: result.removed,
                vacuumed: result.vacuumed,
                bytesBefore: result.bytesBefore,
                bytesAfter: result.bytesAfter,
            }, 'thumbnail database optimized');
        }
    });
    const timer = setInterval(() => {
        optimizeAlbumDatabases();
    }, MAINTENANCE_INTERVAL_MS);

    timer.unref?.();

    nitroApp.hooks.hook('close', () => {
        clearInterval(timer);
        unregister();
    });
});
