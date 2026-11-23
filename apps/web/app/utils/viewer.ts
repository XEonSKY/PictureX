export const MIN_VIEWER_SCALE = 0.2;
export const MAX_VIEWER_SCALE = 8;
export const VIEWER_SCALE_STEP = 0.2;

/** 查看器缩放步进：限制在 0.2–8，保留两位小数 */
export function stepZoom(
    scale: number,
    direction: -1 | 1,
    min = MIN_VIEWER_SCALE,
    max = MAX_VIEWER_SCALE,
    step = VIEWER_SCALE_STEP,
): number {
    const next = Math.round((scale + direction * step) * 100) / 100;

    return Math.min(max, Math.max(min, next));
}

/** 输入框、文本域、下拉框或可编辑内容里不拦截快捷键 */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof target !== 'object') {
        return false;
    }

    const element = target as { tagName?: unknown, isContentEditable?: unknown };
    const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';

    return element.isContentEditable === true || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface ViewerShortcutState {
    shortcutsOpen: boolean
    deleteOpen: boolean
    renameOpen: boolean
    infoOpen: boolean
    canPlayUgoira: boolean
    hasLive: boolean
    favoriteSaving: boolean
}

export interface ViewerShortcutEvent {
    key: string
    code?: string
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    target: EventTarget | null
}

type ViewerCloseAction = 'close-shortcuts' | 'close-delete' | 'close-rename' | 'close-info' | 'close-viewer';
type ViewerNavAction = 'open-shortcuts' | 'prev' | 'next' | 'zoom-in' | 'zoom-out' | 'reset';
type ViewerToggleAction = 'toggle-info' | 'toggle-favorite' | 'play-ugoira' | 'toggle-live';

export type ViewerAction = ViewerCloseAction | ViewerNavAction | ViewerToggleAction;

export interface ViewerShortcut {
    action: ViewerAction
    preventDefault: boolean
}

/**
 * 查看器快捷键的唯一决策点：输入控件、修饰键与弹窗状态都在这里处理，
 * 页面只负责把 action 映射到具体方法。
 */
export function resolveViewerShortcut(
    event: ViewerShortcutEvent,
    state: ViewerShortcutState,
): ViewerShortcut | null {
    if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) {
        return null;
    }

    const key = event.key;
    const lower = key.toLowerCase();

    if (key === 'Escape') {
        if (state.shortcutsOpen) {
            return { action: 'close-shortcuts', preventDefault: false };
        }
        if (state.deleteOpen) {
            return { action: 'close-delete', preventDefault: false };
        }
        if (state.renameOpen) {
            return { action: 'close-rename', preventDefault: false };
        }
        if (state.infoOpen) {
            return { action: 'close-info', preventDefault: false };
        }

        return { action: 'close-viewer', preventDefault: false };
    }

    if (state.shortcutsOpen) {
        return null;
    }

    if (key === '?') {
        return { action: 'open-shortcuts', preventDefault: true };
    }
    if (state.deleteOpen || state.renameOpen) {
        return null;
    }

    if (key === 'ArrowLeft' || lower === 'a') {
        return { action: 'prev', preventDefault: true };
    }
    if (key === 'ArrowRight' || lower === 'd') {
        return { action: 'next', preventDefault: true };
    }
    if (key === '+' || key === '=' || key === 'ArrowUp' || lower === 'w') {
        return { action: 'zoom-in', preventDefault: true };
    }
    if (key === '-' || key === 'ArrowDown' || lower === 's') {
        return { action: 'zoom-out', preventDefault: true };
    }
    if (key === '0' || lower === 'r') {
        return { action: 'reset', preventDefault: true };
    }
    if (lower === 'i') {
        return { action: 'toggle-info', preventDefault: true };
    }
    if (lower === 'f') {
        return state.favoriteSaving ? null : { action: 'toggle-favorite', preventDefault: true };
    }
    if (event.code === 'Space') {
        if (state.canPlayUgoira) {
            return { action: 'play-ugoira', preventDefault: true };
        }
        if (state.hasLive) {
            return { action: 'toggle-live', preventDefault: true };
        }
    }

    return null;
}
