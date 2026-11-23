import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logMain } from './log';
import { shellStrings } from './strings';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

/** 运行时用 PX_UPDATE_URL 指向 generic 更新目录（release 产物里的 latest.yml） */
export function setupAutoUpdates(): void {
    if (!app.isPackaged) {
        return;
    }

    const feedUrl = process.env.PX_UPDATE_URL?.trim();

    if (feedUrl) {
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    }

    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (error: Error) => {
        logMain(`update error: ${error.message}`);
    });
    autoUpdater.on('update-available', (info: { version: string }) => {
        const strings = shellStrings();
        const result = dialog.showMessageBoxSync({
            type: 'info',
            title: strings.updateAvailableTitle,
            message: strings.updateAvailableMessage.replace('{version}', info.version),
            buttons: [strings.updateDownload, strings.updateLater],
            defaultId: 0,
            cancelId: 1,
        });

        if (result === 0) {
            void autoUpdater.downloadUpdate();
        }
    });
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
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
    }
}
