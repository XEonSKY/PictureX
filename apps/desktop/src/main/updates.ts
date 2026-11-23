import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logMain } from './log';
import { shellStrings } from './strings';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 站点上的更新目录：正式版 latest、预发行版 pre */
const DEFAULT_FEED_BASE = 'https://picturex.xeonsky.com/update/';

/** 预发行版（版本号带 -rc/-beta/-alpha）走 pre，其余走 latest；PX_UPDATE_URL 可整体覆盖。 */
function resolveFeedUrl(): string {
    const override = process.env.PX_UPDATE_URL?.trim();

    if (override) {
        return override;
    }

    const channel = app.getVersion().includes('-') ? 'pre' : 'latest';

    return `${DEFAULT_FEED_BASE}${channel}/`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;
let manualCheck = false;
/** 已提示过安装的版本；周期性静默检查不再重复弹窗 */
let downloadedVersion: string | null = null;

/**
 * 自动更新：启动即检查，发现新版本后在后台**静默预下载**，
 * 下载完成才询问用户是否立即重启安装（不确认就绝不安装）。
 * 运行时用 PX_UPDATE_URL 指向 generic 更新目录（release 产物里的 latest.yml）。
 */
export function setupAutoUpdates(): void {
    if (!app.isPackaged) {
        return;
    }

    // GitHub 资产下载会重定向，多段 Range 容易卡住，改为单段
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: resolveFeedUrl(),
        useMultipleRangeRequest: false,
    });

    // 预下载：发现更新后直接后台下载，不打断用户
    autoUpdater.autoDownload = true;
    // 必须由用户确认后才安装，退出应用时不静默安装
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('error', (error: Error) => {
        logMain(`update error: ${error.message}`);
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
        logMain(`update available: ${info.version}; downloading in background`);
    });

    autoUpdater.on('update-not-available', (info: { version: string }) => {
        if (!manualCheck) {
            return;
        }

        const strings = shellStrings();
        dialog.showMessageBoxSync({
            type: 'info',
            title: strings.checkUpdates,
            message: strings.updateUpToDate.replace('{version}', info.version),
            buttons: ['OK'],
        });
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
        const repeated = downloadedVersion === info.version;

        downloadedVersion = info.version;

        // 后台检查对同一版本只提示一次；手动检查允许再次唤起安装确认
        if (repeated && !manualCheck) {
            return;
        }

        const strings = shellStrings();

        void dialog.showMessageBox({
            type: 'info',
            title: strings.updateReadyTitle,
            message: strings.updateReadyMessage.replace('{version}', info.version),
            buttons: [strings.updateRestart, strings.updateLater],
            defaultId: 0,
            cancelId: 1,
        }).then((result) => {
            if (result.response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    void checkForUpdates(false);
    timer = setInterval(() => {
        void checkForUpdates(false);
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
}

export function stopAutoUpdates(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export async function checkForUpdates(manual = true): Promise<void> {
    const strings = shellStrings();

    if (!app.isPackaged) {
        if (manual) {
            dialog.showMessageBoxSync({
                type: 'info',
                title: strings.checkUpdates,
                message: strings.updateNotPackaged,
                buttons: ['OK'],
            });
        }

        return;
    }

    if (checking) {
        return;
    }

    checking = true;
    manualCheck = manual;

    try {
        const result = await autoUpdater.checkForUpdates();

        logMain(`update check finished: ${result?.updateInfo.version ?? 'no update'}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logMain(`update check failed: ${message}`);

        if (manual) {
            dialog.showMessageBoxSync({
                type: 'warning',
                title: strings.checkUpdates,
                message: strings.updateFailed.replace('{message}', message),
                buttons: ['OK'],
            });
        }
    }
    finally {
        checking = false;
        manualCheck = false;
    }
}
