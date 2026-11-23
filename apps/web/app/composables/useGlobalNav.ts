import {
    AppstoreFilled,
    AppstoreOutlined,
    CloudOutlined,
    PictureFilled,
    PictureOutlined,
    SettingFilled,
    SettingOutlined,
    SyncOutlined,
} from '@antdv-next/icons';

/** 全局主导航（相册 / 图库 / 任务 / 设置）：default 与 library 布局共用 */
export function useGlobalNav() {
    const { t } = useI18n();

    return computed(() => [
        { key: 'albums', to: '/', icon: PictureOutlined, activeIcon: PictureFilled, label: t('nav.albums') },
        { key: 'pixiv', to: '/pixiv', icon: CloudOutlined, activeIcon: CloudOutlined, label: t('nav.pixiv') },
        { key: 'library', to: '/library', icon: AppstoreOutlined, activeIcon: AppstoreFilled, label: t('nav.library') },
        { key: 'jobs', to: '/jobs', icon: SyncOutlined, activeIcon: SyncOutlined, label: t('nav.jobs') },
        { key: 'settings', to: '/settings', icon: SettingOutlined, activeIcon: SettingFilled, label: t('nav.settings') },
    ]);
}
