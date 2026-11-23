import { listAlbumSummaries } from '../album/album-store';
import { logger } from '../logger';
import { schedulePixivAutoFetch } from '../pixiv/auto-fetch';
import { getSettings } from '../settings/setting-store';

/** 启动后为所有启用 Pixiv 的相册排队后台补全；单线程串行 + 100–1000ms 随机间隔 */
export default defineNitroPlugin(() => {
    if (process.env.NODE_ENV === 'test') {
        return;
    }

    const settings = getSettings();

    // 用户上次手动暂停：重启后保持暂停，直到在设置页点“继续”
    if (settings.pixiv.autoFetchPaused) {
        logger.info('pixiv auto fetch stays paused by user setting');
        return;
    }

    const enabled = listAlbumSummaries(settings)
        .filter(album => !album.missing && !album.corrupt && album.settings.pixivEnabled);

    if (enabled.length === 0) {
        return;
    }

    // 延迟到首屏请求稳定后再开始，避免与页面加载争抢
    const timer = setTimeout(() => {
        for (const album of enabled) {
            schedulePixivAutoFetch(album.id);
        }
    }, 15_000);

    timer.unref?.();
    logger.info({ albums: enabled.length }, 'pixiv auto fetch scheduled');
});
