import { Menu, app, dialog, shell } from 'electron';
import path from 'node:path';
import { logPath } from './log';
import { resolveDataDir } from './paths';
import { shellStrings } from './strings';
import { hasTray } from './tray';

export interface AppMenuActions {
    hideWindow(): void;
    checkUpdates(): void;
}

export function installAppMenu(actions: AppMenuActions): void {
    const strings = shellStrings();
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: strings.file,
            submenu: [
                {
                    label: strings.hideMainWindow,
                    click: actions.hideWindow,
                    enabled: hasTray(),
                },
                {
                    label: strings.openDataDir,
                    click: () => {
                        void shell.openPath(resolveDataDir());
                    },
                },
                {
                    label: strings.openLogs,
                    click: () => {
                        void shell.openPath(path.dirname(logPath('desktop.log')));
                    },
                },
                { type: 'separator' },
                { label: strings.quit, role: 'quit' },
            ],
        },
        {
            label: strings.view,
            submenu: [
                { label: strings.reload, role: 'reload' },
                { label: strings.toggleDevTools, role: 'toggleDevTools', enabled: !app.isPackaged },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: strings.help,
            submenu: [
                {
                    label: strings.checkUpdates,
                    click: actions.checkUpdates,
                },
                { type: 'separator' },
                {
                    label: strings.about,
                    click: () => {
                        showAbout();
                    },
                },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout(): void {
    const strings = shellStrings();
    const detail = [
        `PictureX ${app.getVersion()}`,
        `Electron ${process.versions.electron}`,
        `Node ${process.versions.node}`,
        `Chromium ${process.versions.chrome}`,
        '',
        `${strings.openDataDir}: ${resolveDataDir()}`,
    ].join('\n');

    void dialog.showMessageBox({
        type: 'info',
        title: 'PictureX',
        message: 'PictureX',
        detail,
        buttons: ['OK'],
    });
}
