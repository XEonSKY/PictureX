export type LocaleCode = 'zh-CN' | 'en-US';

export const LOCALE_COOKIE_KEY = 'picturex.lang';
export const LOCALE_STORAGE_KEY = 'picturex.lang';

/**
 * 语言切换：vue-i18n 即时生效，写 cookie + localStorage，
 * 并把默认语言同步到 setting.json（PATCH /settings）。
 */
export function useLocale() {
    const { locale, setLocale, locales } = useI18n();
    const api = useApi();

    const current = computed(() => (locale.value === 'en-US' ? 'en-US' : 'zh-CN') as LocaleCode);

    async function switchLocale(code: LocaleCode): Promise<void> {
        await setLocale(code);

        if (import.meta.client) {
            const maxAge = 60 * 60 * 24 * 365;

            document.cookie = `${LOCALE_COOKIE_KEY}=${code}; path=/; max-age=${maxAge}; samesite=lax`;
            localStorage.setItem(LOCALE_STORAGE_KEY, code);
        }

        try {
            await api.settings.$patch({ json: { i18n: { defaultLocale: code } } });
        }
        catch (error) {
            if (import.meta.dev) {
                console.warn('[i18n] failed to persist default locale', error);
            }
        }
    }

    return {
        locale: current,
        locales,
        switchLocale,
    };
}
