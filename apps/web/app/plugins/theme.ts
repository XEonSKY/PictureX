import {
    normalizeThemeState,
    THEME_STORAGE_KEY,
    themeOverridesToCss,
    type ThemeState,
} from '#shared/theme';

interface ThemeWindow extends Window {
    __PX_THEME__?: unknown
}

function readStoredTheme(): unknown {
    try {
        return JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');
    }
    catch {
        return null;
    }
}

const appliedKeys = new Set<string>();

function applyThemeToDom(state: ThemeState): void {
    const root = document.documentElement;

    root.setAttribute('data-theme', state.preset);
    root.style.colorScheme = state.preset;

    for (const key of appliedKeys) {
        root.style.removeProperty(`--px-${key}`);
    }
    appliedKeys.clear();

    for (const [key, value] of Object.entries(state.overrides)) {
        root.style.setProperty(`--px-${key}`, value);
        appliedKeys.add(key);
    }
}

/**
 * 主题状态：SSR 从 setting.json 注入，客户端以内联脚本写入的 localStorage 为准。
 * head 中同步 data-theme 与覆盖变量，避免首屏闪烁。
 */
export default defineNuxtPlugin(() => {
    const event = import.meta.server ? useRequestEvent() : undefined;
    const serverTheme = event?.context.pxTheme;

    const state = useState<ThemeState>('px-theme', () => normalizeThemeState(serverTheme));

    if (import.meta.client) {
        const globals = (window as ThemeWindow).__PX_THEME__;
        const stored = readStoredTheme();

        state.value = normalizeThemeState(stored ?? globals ?? state.value);
    }

    useHead({
        htmlAttrs: {
            'data-theme': computed(() => state.value.preset),
        },
        style: computed(() => {
            const css = themeOverridesToCss(state.value.overrides);

            return css ? [{ innerHTML: css }] : [];
        }),
    });

    if (import.meta.client) {
        watch(state, value => applyThemeToDom(value), { immediate: true, deep: true });
    }
});
