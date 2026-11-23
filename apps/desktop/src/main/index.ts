import { app, dialog, session } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logMain, logPath } from './log';
import { installAppMenu } from './menu';
import { classifyViewerFile } from './media-types';
import { APP_ID, RuntimeMissingError, resolveDataDir, resolveRuntimeEntry } from './paths';
import { startLocalServer, type LocalServer } from './server';
import { shellStrings } from './strings';
import { createTray, destroyTray, hasTray } from './tray';
import { checkForUpdates, setupAutoUpdates, stopAutoUpdates } from './updates';
import { installViewerIpc, openViewerWindowForPath } from './viewer-window';
import { installViewerProtocol, registerViewerScheme } from './viewer-protocol';
import {
    closeMainWindow,
    createMainWindow,
    getMainWindow,
    hideMainWindow,
    installSleepRecovery,
    loadApp,
    showMainWindow,
} from './window';

const devWebUrl = process.env.PX_DESKTOP_WEB_URL?.trim() || null;

// 开发态与安装版各自持有单实例锁与窗口状态，互不抢占
if (!app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'PictureX (dev)'));
}

// pxfile 特权方案必须在 app ready 之前注册
registerViewerScheme();

/** 从命令行里挑出可被查看器打开的图片/视频文件绝对路径 */
function collectViewerPaths(argv: readonly string[]): string[] {
    const paths: string[] = [];

    for (const arg of argv.slice(1)) {
        if (!arg || arg.startsWith('-') || !path.isAbsolute(arg)) {
            continue;
        }

        if (classifyViewerFile(arg) && existsSync(arg)) {
            paths.push(arg);
        }
    }

    return paths;
}

async function launchViewerFiles(paths: readonly string[]): Promise<void> {
    const url = await ensureAppUrl();

    installViewerProtocol();
    installViewerIpc(url);

    for (const filePath of paths) {
        await openViewerWindowForPath(url, filePath).catch((error: unknown) => {
            logMain(`failed to open viewer file ${path.basename(filePath)}: ${String(error)}`);
        });
    }
}

let localServer: LocalServer | null = null;
let appUrl: string | null = null;
let appUrlPromise: Promise<string> | null = null;
let quitting = false;
let lastStartupError: unknown = null;
let startupPromise: Promise<void> | null = null;

function showStartupError(error: unknown): void {
    const strings = shellStrings();
    const detail = error instanceof Error ? error.message : String(error);

    logMain(`startup failed: ${detail}`);

    if (error instanceof RuntimeMissingError) {
        dialog.showErrorBox(strings.runtimeMissingTitle, `${strings.runtimeMissingDetail}\n\n${detail}`);

        return;
    }

    dialog.showErrorBox(strings.serverFailedTitle, `${detail}\n\n${strings.logFolder}: ${logPath('desktop.log')}`);
}

function stopServer(): void {
    localServer?.stop();
    localServer = null;
}

/**
 * 把服务端自带的一次性令牌写进默认会话 cookie，
 * 主窗口与「打开方式」查看器窗口同源请求都会自动携带，本机其它进程直连端口则 401。
 */
async function applyAuthCookie(url: string, token: string): Promise<void> {
    try {
        await session.defaultSession.cookies.set({
            url,
            name: 'picturex.token',
            value: token,
            path: '/',
            sameSite: 'lax',
            httpOnly: true,
            expirationDate: Math.floor(Date.now() / 1000) + 31536000,
        });
    }
    catch (error) {
        logMain(`failed to set auth cookie: ${String(error)}`);
    }
}

function quitApp(): void {
    quitting = true;
    app.quit();
}

function ensureAppUrl(): Promise<string> {
    if (appUrl !== null) {
        return Promise.resolve(appUrl);
    }

    if (devWebUrl !== null) {
        appUrl = devWebUrl;

        return Promise.resolve(devWebUrl);
    }

    // 单例 promise：服务尚未 ready（appUrl 仍 null）时若用户再双击一张图，
    // second-instance 会并发调用本函数；不去重就会起两个 utilityProcess，端口/进程泄漏
    if (appUrlPromise === null) {
        appUrlPromise = startLocalServer({
            entry: resolveRuntimeEntry(),
            dataDir: resolveDataDir(),
            onExit: (code) => {
                logMain(`local server exited unexpectedly (${code}); quitting desktop shell`);
                quitApp();
            },
        }).then(async (server) => {
            localServer = server;
            // 令牌 cookie 必须在 appUrl 可见前就位：并发 second-instance
            // 看到 appUrl 后会立刻建查看器窗口并请求 API。
            await applyAuthCookie(server.url, server.token);
            appUrl = server.url;

            return server.url;
        }).catch((error: unknown) => {
            // 启动失败要清空，后续重试才能重新尝试
            appUrlPromise = null;
            throw error;
        });
    }

    return appUrlPromise;
}

async function createAndLoadWindow(): Promise<void> {
    const existing = getMainWindow();
    const win = createMainWindow({
        closePolicy: {
            hideOnClose: () => hasTray() && !quitting,
        },
    });

    if (existing !== null) {
        return;
    }

    const url = await ensureAppUrl();

    await loadApp(win, url);
    logMain('app loaded');
}

async function runEnsureMainWindow(): Promise<void> {
    if (showMainWindow()) {
        return;
    }

    if (lastStartupError !== null) {
        showStartupError(lastStartupError);
        quitApp();

        return;
    }

    try {
        await createAndLoadWindow();
    }
    catch (error) {
        lastStartupError = error;
        showStartupError(error);
        quitApp();
    }
}

function ensureMainWindow(): Promise<void> {
    if (startupPromise !== null) {
        return startupPromise;
    }

    startupPromise = runEnsureMainWindow().finally(() => {
        startupPromise = null;
    });

    return startupPromise;
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
}
else {
    app.on('second-instance', (_event, argv) => {
        const paths = collectViewerPaths(argv);

        if (paths.length > 0) {
            // 已运行状态下双击图片/视频：在当前进程里开新查看器窗口
            void launchViewerFiles(paths);

            return;
        }

        void ensureMainWindow();
    });

    app.whenReady().then(async () => {
        app.setAppUserModelId(APP_ID);
        installSleepRecovery();
        const trayCreated = createTray({
            show: () => {
                void ensureMainWindow();
            },
            quit: quitApp,
        });

        logMain(trayCreated ? 'tray ready' : 'tray unavailable; closing the window quits the app');
        installAppMenu({
            hideWindow: () => {
                if (!hideMainWindow()) {
                    quitApp();
                }
            },
            checkUpdates: () => {
                void checkForUpdates(true);
            },
        });
        setupAutoUpdates();

        // 通过 OS「打开方式」启动时，只开查看器窗口，不启动相册主窗口
        const startupPaths = collectViewerPaths(process.argv);

        if (startupPaths.length > 0) {
            await launchViewerFiles(startupPaths);
            logMain(`viewer-only launch: ${startupPaths.length} window(s)`);

            return;
        }

        const win = createMainWindow({
            closePolicy: {
                hideOnClose: () => hasTray() && !quitting,
            },
        });
        const url = await ensureAppUrl();

        await loadApp(win, url);
        logMain('app loaded');
    }).catch((error: unknown) => {
        lastStartupError = error;
        showStartupError(error);
        quitApp();
    });

    app.on('activate', () => {
        void ensureMainWindow();
    });

    app.on('window-all-closed', () => {
        if (!hasTray()) {
            quitApp();
        }
    });

    app.on('before-quit', () => {
        quitting = true;
        stopAutoUpdates();
        destroyTray();
        closeMainWindow();
        stopServer();
    });

    process.on('exit', () => {
        stopServer();
    });
}
