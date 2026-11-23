import { ensureDataDirectories } from '../utils/data-dir';
import { acquireDataDirLock, releaseDataDirLock } from '../utils/data-dir-lock';
import { logger } from '../logger';

/**
 * 数据目录：开发期 <workspace>/.dev/data，生产 <home>/.xeonsky/picturex，
 * 可用 -dataDir 命令行参数或 NUXT_DATA_DIR 覆盖。
 * 启动即创建目录并抢占单写者锁，退出时释放。
 */
export default defineNitroPlugin((nitroApp) => {
    const directories = ensureDataDirectories();

    acquireDataDirLock(directories.dataDir);
    nitroApp.hooks.hook('close', () => {
        releaseDataDirLock();
    });

    logger.debug({ dataDir: directories.dataDir }, 'data directory ready');
});
