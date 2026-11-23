import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const APP_ID = 'com.xeonsky.picturex';

export class RuntimeMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeMissingError';
    }
}

export function desktopRoot(): string {
    return app.getAppPath();
}

export function resourcePath(...parts: string[]): string {
    return path.join(desktopRoot(), 'resources', ...parts);
}

export function windowStatePath(): string {
    return path.join(app.getPath('userData'), 'window-state.json');
}

export function resolveDataDir(): string {
    const override = process.env.PX_DESKTOP_DATA_DIR?.trim();

    if (override) {
        return path.resolve(override);
    }

    return path.join(app.getPath('home'), '.xeonsky', 'picturex');
}

/**
 * 桌面端不直接加载 dist/package：其中的 better-sqlite3 按 Node ABI 编译，
 * 只有 prepare-runtime.mjs 产出的 runtime/ 才换成 Electron ABI。
 */
export function resolveRuntimeEntry(): string {
    const override = process.env.PX_DESKTOP_RUNTIME?.trim();
    const candidates = override
        ? [path.resolve(override)]
        : [
            app.isPackaged
                ? path.join(process.resourcesPath, 'runtime', 'server', 'bootstrap.cjs')
                : '',
            path.join(desktopRoot(), 'runtime', 'server', 'bootstrap.cjs'),
        ];

    for (const candidate of candidates) {
        if (candidate !== '' && existsSync(candidate)) {
            return candidate;
        }
    }

    throw new RuntimeMissingError('Desktop runtime is not prepared.');
}
