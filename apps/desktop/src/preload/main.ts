import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * 主窗口桥：只暴露版本信息与更新检查，不涉及文件系统或任意 IPC。
 * 查看器窗口使用另一个 preload（picturexViewer），不会拿到这些能力。
 */

type StatusHandler = (status: unknown) => void;

const listeners = new Map<number, StatusHandler>();
let nextListenerId = 1;

ipcRenderer.on('desktop:update-status', (_event: IpcRendererEvent, status: unknown) => {
    for (const handler of listeners.values()) {
        try {
            handler(status);
        }
        catch {
            // 渲染进程异常不能中断其它订阅者
        }
    }
});

contextBridge.exposeInMainWorld('picturexDesktop', {
    info: (): Promise<unknown> => ipcRenderer.invoke('desktop:info'),
    updateStatus: (): Promise<unknown> => ipcRenderer.invoke('desktop:update-status'),
    checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke('desktop:check-updates'),
    installUpdate: (): Promise<unknown> => ipcRenderer.invoke('desktop:install-update'),
    /** 返回订阅 id；用 unsubscribeUpdateStatus 取消 */
    subscribeUpdateStatus: (handler: StatusHandler): number => {
        const id = nextListenerId;

        nextListenerId += 1;
        listeners.set(id, handler);

        return id;
    },
    unsubscribeUpdateStatus: (id: number): void => {
        listeners.delete(id);
    },
});
