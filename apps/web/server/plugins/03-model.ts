import { closeAllAlbumDatabases } from '../database/album';
import { closeCloudDatabase } from '../database/cloud';
import { closeGlobalDatabase } from '../database/global';
import { closePixivDatabase } from '../database/pixiv';
import { closeTaskDatabase } from '../database/task';
import { logger } from '../logger';
import { modelDownloader } from '../model/model-downloader';
import { getSettings } from '../settings/setting-store';

/** 模型下载生命周期：可选自动续传；进程退出前暂停并落盘 */
export default defineNitroPlugin((nitroApp) => {
    const settings = getSettings();
    const downloader = modelDownloader();

    if (settings.ai.autoResumeDownload) {
        for (const task of downloader.listTasks()) {
            if (task.status === 'paused') {
                downloader.resume(task.modelId).catch((error: unknown) => {
                    logger.warn({ err: error, modelId: task.modelId }, 'failed to resume model download');
                });
            }
        }
    }

    nitroApp.hooks.hook('close', async () => {
        await downloader.shutdown();
        // 给在途长任务（导入/AI/相似度）一个短收尾窗口，让当前分批写入尽量推进到检查点；
        // better-sqlite3 事务是同步的，钩子在事件循环上运行，此时不会有半开事务
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 进程即将退出：强制关闭所有相册库（含持租约的），退出时正常 checkpoint WAL；
        // 全局图库 <dataDir>/data/picture.db / tag.db 此前从未关闭
        try {
            closeAllAlbumDatabases();
        }
        catch (error) {
            logger.warn({ err: error }, 'failed to close album databases on shutdown');
        }
        try {
            closeGlobalDatabase();
        }
        catch (error) {
            logger.warn({ err: error }, 'failed to close global database on shutdown');
        }
        try {
            closePixivDatabase();
        }
        catch (error) {
            logger.warn({ err: error }, 'failed to close pixiv database on shutdown');
        }
        try {
            closeCloudDatabase();
        }
        catch (error) {
            logger.warn({ err: error }, 'failed to close cloud database on shutdown');
        }
        // 相册打开时可能顺手迁移了任务历史，所以任务库必须最后关
        try {
            closeTaskDatabase();
        }
        catch (error) {
            logger.warn({ err: error }, 'failed to close task database on shutdown');
        }
    });
});
