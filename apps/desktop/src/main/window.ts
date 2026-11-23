import { BrowserWindow, app, powerMonitor, screen, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { logMain } from './log';
import { resourcePath, windowStatePath } from './paths';

interface StoredWindowState {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
}

interface NavigationEvent {
    preventDefault(): void;
}

export interface ClosePolicy {
    hideOnClose(): boolean;
    onHidden?(): void;
}

export interface MainWindowOptions {
    closePolicy?: ClosePolicy;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;

let allowedOrigin: string | null = null;
let currentUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
let sleepRecoveryInstalled = false;


function readState(): StoredWindowState {
    try {
        const parsed: unknown = JSON.parse(readFileSync(windowStatePath(), 'utf8'));

        if (typeof parsed === 'object' && parsed !== null) {
            const record = parsed as Record<string, unknown>;
            const width = typeof record.width === 'number' ? record.width : DEFAULT_WIDTH;
            const height = typeof record.height === 'number' ? record.height : DEFAULT_HEIGHT;
            const state: StoredWindowState = { width, height };

            if (typeof record.x === 'number') state.x = record.x;
            if (typeof record.y === 'number') state.y = record.y;
            if (typeof record.maximized === 'boolean') state.maximized = record.maximized;

            return state;
        }
    }
    catch {
        // 首次启动或文件损坏时用默认尺寸
    }

    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function isVisibleOnScreen(state: StoredWindowState): boolean {
    const { x, y } = state;

    if (x === undefined || y === undefined) {
        return true;
    }

    return screen.getAllDisplays().some(({ workArea }) =>
        x >= workArea.x - 40
        && y >= workArea.y - 40
        && x + 120 <= workArea.x + workArea.width
        && y + 80 <= workArea.y + workArea.height);
}

function saveState(win: BrowserWindow): void {
    try {
        const bounds = win.getNormalBounds();
        const state: StoredWindowState = {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            maximized: win.isMaximized(),
        };

        writeFileSync(windowStatePath(), `${JSON.stringify(state, null, 4)}\n`);
    }
    catch (error) {
        logMain(`failed to save window state: ${String(error)}`);
    }
}

function isSameOrigin(target: string, origin: string): boolean {
    try {
        return new URL(target).origin === origin;
    }
    catch {
        return false;
    }
}

function openExternal(target: string): void {
    try {
        const parsed = new URL(target);

        if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
            void shell.openExternal(target);
        }
    }
    catch {
        // 忽略无法解析的地址
    }
}

function installGuards(win: BrowserWindow): void {
    const guard = (event: NavigationEvent, target: string): void => {
        if (allowedOrigin === null) {
            return;
        }

        try {
            if (new URL(target).origin === allowedOrigin) {
                return;
            }
        }
        catch {
            // 非标准 URL 一律交给外部浏览器处理
        }

        event.preventDefault();
        openExternal(target);
    };

    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', guard);
    win.webContents.setWindowOpenHandler(({ url }) => {
        // 同源「新窗口」请求实为下载原图/预览：走应用内下载，避免甩给系统浏览器
        if (allowedOrigin !== null && isSameOrigin(url, allowedOrigin)) {
            win.webContents.downloadURL(url);
        }
        else {
            openExternal(url);
        }

        return { action: 'deny' };
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('render-process-gone', (_event, details) => {
        logMain(`renderer gone: ${details.reason} (${details.exitCode})`);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
        if (code !== -3) {
            logMain(`failed to load ${url}: ${description} (${code})`);
        }
    });
}

export function getMainWindow(): BrowserWindow | null {
    if (mainWindow !== null && mainWindow.isDestroyed()) {
        mainWindow = null;
    }

    return mainWindow;
}

function reloadIfNeeded(win: BrowserWindow): void {
    if (!win.webContents.isCrashed()) {
        return;
    }

    if (currentUrl !== null) {
        logMain('renderer is not responsive; reloading desktop shell');
        void win.loadURL(currentUrl);

        return;
    }

    win.webContents.reload();
}

export function showMainWindow(): boolean {
    const win = getMainWindow();

    if (win === null) {
        return false;
    }

    if (win.isMinimized()) {
        win.restore();
    }

    reloadIfNeeded(win);
    win.show();
    win.focus();

    return true;
}

export function hideMainWindow(): boolean {
    const win = getMainWindow();

    if (win === null || !win.isVisible()) {
        return false;
    }

    win.hide();

    return true;
}

export function closeMainWindow(): void {
    const win = getMainWindow();

    if (win === null) {
        return;
    }

    mainWindow = null;
    win.close();
}

export function installSleepRecovery(): void {
    if (sleepRecoveryInstalled) {
        return;
    }

    sleepRecoveryInstalled = true;
    powerMonitor.on('resume', () => {
        const win = getMainWindow();

        if (win !== null && win.isVisible()) {
            reloadIfNeeded(win);
        }
    });
}

export function createMainWindow(options: MainWindowOptions = {}): BrowserWindow {
    const existing = getMainWindow();

    if (existing !== null) {
        showMainWindow();

        return existing;
    }

    const state = readState();
    const icon = resourcePath('icon.png');
    const win = new BrowserWindow({
        width: state.width,
        height: state.height,
        ...(isVisibleOnScreen(state) && state.x !== undefined && state.y !== undefined
            ? { x: state.x, y: state.y }
            : {}),
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#0b0d12',
        title: 'PictureX',
        autoHideMenuBar: true,
        icon: existsSync(icon) ? icon : undefined,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
            devTools: !app.isPackaged,
        },
    });

    installGuards(win);

    win.once('ready-to-show', () => {
        if (state.maximized) {
            win.maximize();
        }

        win.show();
    });
    win.on('close', (event) => {
        saveState(win);

        if (options.closePolicy?.hideOnClose() !== true) {
            return;
        }

        event.preventDefault();
        win.hide();
        options.closePolicy.onHidden?.();
    });
    win.on('closed', () => {
        if (mainWindow === win) {
            mainWindow = null;
        }
    });

    void win.loadFile(resourcePath('splash.html')).catch((error: unknown) => {
        logMain(`failed to load splash: ${String(error)}`);
        win.show();
    });

    mainWindow = win;

    return win;
}

export function loadApp(win: BrowserWindow, url: string): Promise<void> {
    const parsed = new URL(url);

    allowedOrigin = parsed.origin;
    currentUrl = url;

    if (win.webContents.getURL() === url) {
        return Promise.resolve();
    }

    return win.loadURL(url);
}

