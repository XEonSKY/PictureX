import {
    isSafeOverrideValue,
    resolveThemeTokens,
    THEMABLE_TOKENS,
    THEME_STORAGE_KEY,
    tokenVarName,
    type ThemeOverrides,
    type ThemePreset,
    type ThemeState,
} from '#shared/theme';

/**
 * 运行时换肤。
 * 权威源：setting.json.theme；localStorage['picturex.theme'] 只做首屏缓存。
 * 切换即时生效（CSS 变量）、刷新保持（localStorage）、并异步同步到服务端。
 */
export function useTheme() {
    const state = useState<ThemeState>('px-theme');
    const syncing = ref(false);
    const api = useApi();

    const resolvedTokens = computed(() => resolveThemeTokens(state.value.preset, state.value.overrides));
    const isDark = computed(() => state.value.preset === 'dark');
    const themableTokens = THEMABLE_TOKENS;

    function persistLocal(): void {
        if (!import.meta.client) {
            return;
        }

        localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state.value));
        document.cookie = `${THEME_STORAGE_KEY}=${encodeURIComponent(JSON.stringify(state.value))}; path=/; max-age=31536000; samesite=lax`;
    }

    async function persistServer(patch: { preset?: ThemePreset, overrides?: ThemeOverrides }): Promise<void> {
        syncing.value = true;

        try {
            await api.settings.theme.$patch({ json: patch });
        }
        catch (error) {
            // 本地优先：服务端不可用时主题仍然即时生效，只记录告警
            if (import.meta.dev) {
                console.warn('[theme] failed to persist theme', error);
            }
        }
        finally {
            syncing.value = false;
        }
    }

    async function setPreset(preset: ThemePreset): Promise<void> {
        state.value = { ...state.value, preset };
        persistLocal();
        await persistServer({ preset });
    }

    async function togglePreset(): Promise<void> {
        await setPreset(isDark.value ? 'light' : 'dark');
    }

    async function setOverride(token: string, value: string): Promise<void> {
        if (!THEMABLE_TOKENS.includes(token)) {
            return;
        }

        const trimmed = value.trim();

        // 空值表示移除覆盖；非空值必须与 SSR 注入使用同一套类型校验
        if (trimmed !== '' && !isSafeOverrideValue(token, trimmed)) {
            return;
        }

        const overrides: ThemeOverrides = {};

        for (const [key, current] of Object.entries(state.value.overrides)) {
            if (key !== token) {
                overrides[key] = current;
            }
        }

        if (trimmed !== '') {
            overrides[token] = trimmed;
        }

        state.value = { ...state.value, overrides };
        persistLocal();
        await persistServer({ overrides });
    }

    async function setOverrides(next: ThemeOverrides): Promise<void> {
        const filtered: ThemeOverrides = {};

        for (const [token, value] of Object.entries(next)) {
            const trimmed = value.trim();

            if (THEMABLE_TOKENS.includes(token) && trimmed !== '' && isSafeOverrideValue(token, trimmed)) {
                filtered[token] = trimmed;
            }
        }

        state.value = { ...state.value, overrides: filtered };
        persistLocal();
        await persistServer({ overrides: filtered });
    }

    async function resetOverrides(): Promise<void> {
        state.value = { ...state.value, overrides: {} };
        persistLocal();
        await persistServer({ overrides: {} });
    }

    function cssVar(token: string): string {
        return `var(${tokenVarName(token)})`;
    }

    return {
        preset: computed(() => state.value.preset),
        overrides: computed(() => state.value.overrides),
        resolvedTokens,
        isDark,
        syncing,
        themableTokens,
        setPreset,
        togglePreset,
        setOverride,
        setOverrides,
        resetOverrides,
        cssVar,
    };
}
