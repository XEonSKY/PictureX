import { app } from 'electron';

export interface ShellStrings {
    file: string;
    view: string;
    help: string;
    quit: string;
    showMainWindow: string;
    hideMainWindow: string;
    reload: string;
    toggleDevTools: string;
    openDataDir: string;
    openLogs: string;
    about: string;
    serverFailedTitle: string;
    runtimeMissingTitle: string;
    runtimeMissingDetail: string;
    logFolder: string;
    checkUpdates: string;
    updateAvailableTitle: string;
    updateAvailableMessage: string;
    updateDownload: string;
    updateLater: string;
    updateReadyTitle: string;
    updateReadyMessage: string;
    updateRestart: string;
    updateNotPackaged: string;
    updateFailed: string;
}

const ZH: ShellStrings = {
    file: '文件',
    view: '视图',
    help: '帮助',
    quit: '退出',
    showMainWindow: '显示 PictureX',
    hideMainWindow: '隐藏窗口',
    reload: '重新加载',
    toggleDevTools: '开发者工具',
    openDataDir: '打开数据目录',
    openLogs: '打开日志目录',
    about: '关于 PictureX',
    serverFailedTitle: 'PictureX 服务启动失败',
    runtimeMissingTitle: '缺少桌面运行时',
    runtimeMissingDetail: '请先在仓库根目录执行 pnpm build:npm，再运行 pnpm desktop:dev；打包版请重新安装。',
    logFolder: '日志目录',
    checkUpdates: '检查更新',
    updateAvailableTitle: '发现新版本',
    updateAvailableMessage: 'PictureX {version} 已发布，是否下载？',
    updateDownload: '下载',
    updateLater: '稍后',
    updateReadyTitle: '更新已就绪',
    updateReadyMessage: 'PictureX {version} 已下载，重启后安装。',
    updateRestart: '立即重启',
    updateNotPackaged: '开发模式不检查更新，请在安装版中试用。',
    updateFailed: '检查更新失败：{message}',
};

const EN: ShellStrings = {
    file: 'File',
    view: 'View',
    help: 'Help',
    quit: 'Quit',
    showMainWindow: 'Show PictureX',
    hideMainWindow: 'Hide Window',
    reload: 'Reload',
    toggleDevTools: 'Developer Tools',
    openDataDir: 'Open Data Folder',
    openLogs: 'Open Logs Folder',
    about: 'About PictureX',
    serverFailedTitle: 'PictureX failed to start',
    runtimeMissingTitle: 'Desktop runtime is missing',
    runtimeMissingDetail: 'Run pnpm build:npm in the repository root, then pnpm desktop:dev. Reinstall the packaged app if this persists.',
    logFolder: 'Log folder',
    checkUpdates: 'Check for Updates',
    updateAvailableTitle: 'Update Available',
    updateAvailableMessage: 'PictureX {version} is available. Download it now?',
    updateDownload: 'Download',
    updateLater: 'Later',
    updateReadyTitle: 'Update Ready',
    updateReadyMessage: 'PictureX {version} has been downloaded and will install after restart.',
    updateRestart: 'Restart Now',
    updateNotPackaged: 'Update checks are disabled in development mode.',
    updateFailed: 'Update check failed: {message}',
};

export function shellStrings(): ShellStrings {
    return app.getLocale().toLowerCase().startsWith('zh') ? ZH : EN;
}
