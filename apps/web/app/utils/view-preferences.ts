/** 照片页 / Pixiv 资料库共用的视图偏好：视图模式与矩阵列数的读取、夹取与持久化。 */

export type GridViewMode = 'masonry' | 'grid' | 'list';

export const GRID_VIEW_MODES: readonly GridViewMode[] = ['masonry', 'grid', 'list'];

export function clampGridColumns(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function readStoredViewMode<T extends string>(
    storageKey: string,
    allowed: readonly T[],
    fallback: T,
): T {
    if (!import.meta.client) {
        return fallback;
    }

    try {
        const stored = localStorage.getItem(storageKey);

        return allowed.includes(stored as T) ? stored as T : fallback;
    }
    catch {
        return fallback;
    }
}

export function readStoredGridColumns(
    storageKey: string,
    min: number,
    max: number,
    fallback: number,
): number {
    if (!import.meta.client) {
        return fallback;
    }

    try {
        const stored = Number(localStorage.getItem(storageKey));

        return Number.isFinite(stored) && stored > 0
            ? clampGridColumns(stored, min, max)
            : fallback;
    }
    catch {
        return fallback;
    }
}

export function persistViewPreferences(
    modeKey: string,
    columnsKey: string,
    mode: GridViewMode,
    columns: number,
): void {
    if (!import.meta.client) {
        return;
    }

    try {
        localStorage.setItem(modeKey, mode);
        localStorage.setItem(columnsKey, String(columns));
    }
    catch {
        // 隐私模式或配额满时保持默认视图即可
    }
}
