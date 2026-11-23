import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    checkForUpdatesForUi,
    getDesktopInfo,
    getUpdateStatus,
    installDownloadedUpdate,
} from './updates';
import { getMainWindow } from './window';

/**
 * 设置页「检查更新」的 IPC。
 * 只接受主窗口的渲染进程：查看器窗口加载同一套页面，不能借用更新权限。
 */
function fromMainWindow(event: IpcMainInvokeEvent): boolean {
    const win = getMainWindow();

    return win !== null && !win.isDestroyed() && event.sender === win.webContents;
}

export function installUpdateIpc(): void {
    ipcMain.handle('desktop:info', (event) => (fromMainWindow(event) ? getDesktopInfo() : null));
    ipcMain.handle('desktop:update-status', (event) => (fromMainWindow(event) ? getUpdateStatus() : null));
    ipcMain.handle('desktop:check-updates', async (event) => {
        if (!fromMainWindow(event)) {
            return null;
        }

        return checkForUpdatesForUi();
    });
    ipcMain.handle('desktop:install-update', (event) => (fromMainWindow(event)
        ? installDownloadedUpdate()
        : false));
}
