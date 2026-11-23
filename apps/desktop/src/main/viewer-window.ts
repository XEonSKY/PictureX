import path from 'node:path';
import { BrowserWindow, ipcMain, shell } from 'electron';
import { logMain } from './log';
import { getViewerFile, registerViewerFile, releaseViewerFile } from './viewer-files';

/**
 * 查看器窗口：无侧栏、可多开、每个文件一个窗口。与主相册窗口相互独立。
 * 渲染进程通过 pxfile://media/<ref> 取字节，通过 viewer:stat 取元数据。
 */

let ipcInstalled = false;
let allowedOrigin = '';

export function installViewerIpc(serverUrl?: string): void {
    if (serverUrl) {
        allowedOrigin = new URL(serverUrl).origin;
    }

    if (ipcInstalled) {
        return;
    }

    ipcInstalled = true;

    ipcMain.handle('viewer:stat', (event, ref: string) => {
        // 只接受本应用页面：防止任意渲染进程/被注入页面枚举已登记文件元数据
        if (allowedOrigin !== '') {
            try {
                if (!event.senderFrame || new URL(event.senderFrame.url).origin !== allowedOrigin) {
                    return null;
                }
            }
            catch {
                return null;
            }
        }

        const record = getViewerFile(ref);

        if (!record) {
            return null;
        }

        return {
            ref,
            name: record.name,
            sha256: record.sha256,
            kind: record.kind,
            mime: record.mime,
            size: record.size,
            url: `pxfile://media/${ref}`,
        };
    });
}

export async function openViewerWindowForPath(serverUrl: string, filePath: string): Promise<BrowserWindow | null> {
    const record = await registerViewerFile(filePath);

    if (!record) {
        // 只记 basename，日志不写用户文件的完整绝对路径
        logMain(`refused to open unsupported viewer file: ${path.basename(filePath)}`);

        return null;
    }

    const preload = path.join(__dirname, '..', 'preload', 'index.js');
    const win = new BrowserWindow({
        width: 1040,
        height: 760,
        minWidth: 560,
        minHeight: 420,
        show: false,
        title: record.name,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            preload,
        },
    });

    const target = `${serverUrl.replace(/\/$/u, '')}/viewer?ref=${encodeURIComponent(record.ref)}`;

    win.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);

            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                void shell.openExternal(url);
            }
        }
        catch {
            // 忽略无法解析的地址
        }

        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        try {
            if (new URL(url).origin !== new URL(serverUrl).origin) {
                event.preventDefault();
            }
        }
        catch {
            event.preventDefault();
        }
    });

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => releaseViewerFile(record.ref));

    await win.loadURL(target).catch((error: unknown) => {
        logMain(`viewer window failed to load: ${String(error)}`);
    });
    logMain(`viewer window opened for ${record.name} (${record.kind})`);

    return win;
}
