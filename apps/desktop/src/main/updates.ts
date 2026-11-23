import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logMain } from './log';
import { shellStrings } from './strings';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 站点上的更新目录：正式版 latest、预发行版 pre */
const DEFAULT_FEED_BASE = 'https://picturex.xeonsky.com/update/';

export type UpdateChannel = 'latest' | 'pre';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  | 'unsupported';

/** 设置页展示的更新状态；与原生弹窗共享同一份模块状态 */
export interface UpdateStatus {
    phase: UpdatePhase
    currentVersion: string
    channel: UpdateChannel
    /** 当前环境是否支持检查更新（仅安装版） */
    supported: boolean
    /** 检查到/下载中的版本 */
    version: string | null
    /** 下载进度 0–100，未知为 null */
    percent: number | null
    checkedAt: string | null
    error: string | null
}

export interface DesktopInfo {
    version: string
    packaged: boolean
    channel: UpdateChannel
    platform: NodeJS.Platform
}

export type UpdateStatusListener = (status: UpdateStatus) => void;

/** 预发行版（版本号带 -rc/-beta/-alpha）走 pre，其余走 latest。 */
export function updateChannel(version = app.getVersion()): UpdateChannel {
    return version.includes('-') ? 'pre' : 'latest';
}

const status: UpdateStatus = {
    phase: app.isPackaged ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    channel: updateChannel(),
    supported: app.isPackaged,
    version: null,
    percent: null,
    checkedAt: null,
    error: null,
};

const statusListeners = new Set<UpdateStatusListener>();

export function getUpdateStatus(): UpdateStatus {
    return { ...status };
}

export function getDesktopInfo(): DesktopInfo {
    return {
        version: app.getVersion(),
        packaged: app.isPackaged,
        channel: status.channel,
        platform: process.platform,
    };
}

/** 订阅状态变化；返回取消订阅函数 */
export function onUpdateStatus(listener: UpdateStatusListener): () => void {
    statusListeners.add(listener);

    return () => statusListeners.delete(listener);
}

function publish(patch: Partial<UpdateStatus>): void {
    Object.assign(status, patch);

    const snapshot = { ...status };

    for (const listener of statusListeners) {
        try {
            listener(snapshot);
        }
        catch {
            // 单个监听器异常不能影响更新流程
        }
    }
}

/** 预发行版（版本号带 -rc/-beta/-alpha）走 pre，其余走 latest；PX_UPDATE_URL 可整体覆盖。 */
function resolveFeedUrl(): string {
    const override = process.env.PX_UPDATE_URL?.trim();

    if (override) {
        return override;
    }

    return `${DEFAULT_FEED_BASE}${status.channel}/`;
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
        publish({ phase: 'error', error: error.message, percent: null });
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
        logMain(`update available: ${info.version}; downloading in background`);
        publish({ phase: 'downloading', version: info.version, percent: 0, error: null });
    });

    autoUpdater.on('download-progress', (progress: { percent: number }) => {
        publish({
            phase: 'downloading',
            percent: Number.isFinite(progress.percent) ? Math.min(100, Math.round(progress.percent)) : null,
        });
    });

    autoUpdater.on('update-not-available', (info: { version: string }) => {
        publish({
            phase: 'up-to-date',
            version: info.version,
            percent: null,
            error: null,
            checkedAt: new Date().toISOString(),
        });

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
        publish({
            phase: 'ready',
            version: info.version,
            percent: 100,
            error: null,
            checkedAt: new Date().toISOString(),
        });

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
        publish({ phase: 'unsupported', supported: false });

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
    publish({ phase: 'checking', error: null, percent: null });

    try {
        const result = await autoUpdater.checkForUpdates();

        logMain(`update check finished: ${result?.updateInfo.version ?? 'no update'}`);
        publish({ checkedAt: new Date().toISOString() });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        logMain(`update check failed: ${message}`);
        publish({ phase: 'error', error: message, percent: null, checkedAt: new Date().toISOString() });

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

/** 设置页「检查更新」：不弹原生对话框，结果通过状态返回/推送 */
export async function checkForUpdatesForUi(): Promise<UpdateStatus> {
    await checkForUpdates(false);

    return getUpdateStatus();
}

/** 设置页「立即重启安装」；只在已下载完成时生效 */
export function installDownloadedUpdate(): boolean {
    if (status.phase !== 'ready') {
        return false;
    }

    autoUpdater.quitAndInstall();

    return true;
}
