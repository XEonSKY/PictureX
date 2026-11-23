import { getSettings } from '../settings/setting-store';
import { logger } from '../logger';

/** 启动即校验 setting.json：缺失字段补默认并原子回写，非法 partitionMode 直接报错 */
export default defineNitroPlugin(() => {
    const settings = getSettings();

    logger.debug(
        {
            albumsRoot: settings.albumsRoot,
            modelsRoot: settings.modelsRoot,
            theme: settings.theme.preset,
            locale: settings.i18n.defaultLocale,
        },
        'settings ready',
    );
});
