import { existsSync } from 'node:fs';
import { listAlbumSummaries } from '../album/album-store';
import { pixivDatabase } from '../database/pixiv';
import { logger } from '../logger';
import { schedulePixivDatabaseSync } from '../pixiv/database-sync';
import { schedulePixivLinkBackfill } from '../pixiv/link-backfill';
import { getSettings } from '../settings/setting-store';
import { describeDataDirectories } from '../utils/data-dir';

/** 启动后把启用 Pixiv 的相册汇总进 <dataDir>/data/pixiv.db；写入路径也会按需合并触发 */
export default defineNitroPlugin(() => {
    if (process.env.NODE_ENV === 'test' && process.env.PX_TEST_PIXIV_DB_SYNC !== '1') {
        return;
    }

    const enabled = listAlbumSummaries(getSettings())
        .filter(album => !album.missing && !album.corrupt && album.settings.pixivEnabled);

    const hasDatabase = existsSync(describeDataDirectories().pixivDbPath);

    if (enabled.length === 0 && !hasDatabase) {
        return;
    }

    const timer = setTimeout(() => {
        // 打开一次即完成旧 pixiv.db 布局迁移；没有启用相册时也要做
        pixivDatabase();

        if (enabled.length > 0) {
            schedulePixivLinkBackfill();
        }
        schedulePixivDatabaseSync(0);
    }, 20_000);

    timer.unref?.();
    logger.info({ albums: enabled.length }, 'pixiv database sync scheduled');
});
