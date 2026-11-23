import { Menu, Tray, nativeImage } from 'electron';
import { logMain } from './log';
import { resourcePath } from './paths';
import { shellStrings } from './strings';

export interface TrayActions {
    show(): void;
    quit(): void;
}

let tray: Tray | null = null;

function trayLikelyAvailable(): boolean {
    return process.platform !== 'linux' || Boolean(process.env.XDG_CURRENT_DESKTOP);
}

export function hasTray(): boolean {
    return tray !== null;
}

export function createTray(actions: TrayActions): boolean {
    if (tray !== null) {
        return true;
    }

    if (!trayLikelyAvailable()) {
        return false;
    }

    try {
        const icon = nativeImage.createFromPath(resourcePath('icon.png'));

        if (icon.isEmpty()) {
            return false;
        }

        const strings = shellStrings();
        const nextTray = new Tray(icon.resize({ width: 16, height: 16 }));

        nextTray.setToolTip('PictureX');
        nextTray.setContextMenu(Menu.buildFromTemplate([
            { label: strings.showMainWindow, click: actions.show },
            { type: 'separator' },
            { label: strings.quit, click: actions.quit },
        ]));
        nextTray.on('click', actions.show);
        nextTray.on('double-click', actions.show);
        tray = nextTray;

        return true;
    }
    catch (error) {
        tray?.destroy();
        tray = null;
        logMain(`tray unavailable: ${String(error)}`);

        return false;
    }
}

export function destroyTray(): void {
    tray?.destroy();
    tray = null;
}
