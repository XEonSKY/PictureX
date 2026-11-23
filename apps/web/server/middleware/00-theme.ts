import { getCookie } from 'h3';
import { normalizeThemeState } from '#shared/theme';
import { getSettings } from '../settings/setting-store';

/**
 * 把 setting.json 的主题注入请求上下文，供 app/plugins/theme.ts 在 SSR 首屏使用。
 * 设置读取有进程内缓存，这里不会产生逐请求 IO。
 */
export default defineEventHandler((event) => {
    const fallback = getSettings().theme;
    const raw = getCookie(event, 'picturex.theme');

    if (!raw) {
        event.context.pxTheme = fallback;

        return;
    }

    try {
        event.context.pxTheme = normalizeThemeState(JSON.parse(decodeURIComponent(raw)));
    }
    catch {
        event.context.pxTheme = fallback;
    }
});
