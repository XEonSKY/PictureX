import tokens from './theme-tokens.json';

export type ThemePreset = 'light' | 'dark';

export type ThemeOverrides = Record<string, string>;

export interface ThemeState {
    preset: ThemePreset
    overrides: ThemeOverrides
}

export const THEMABLE_TOKENS: readonly string[] = tokens.themable;

export const DEFAULT_THEME: ThemeState = { preset: 'light', overrides: {} };

export const THEME_STORAGE_KEY = 'picturex.theme';

const SHARED_TOKENS: Record<string, string> = tokens.shared;

const PRESET_TOKENS: Record<ThemePreset, Record<string, string>> = {
    light: tokens.light,
    dark: tokens.dark,
};

export function resolveThemeTokens(preset: ThemePreset, overrides: ThemeOverrides = {}): Record<string, string> {
    const merged: Record<string, string> = {
        ...SHARED_TOKENS,
        ...PRESET_TOKENS[preset],
    };

    for (const name of THEMABLE_TOKENS) {
        const value = overrides[name];

        if (typeof value === 'string' && value.trim() !== '') {
            merged[name] = value;
        }
    }

    return merged;
}

export function tokenVarName(name: string): string {
    return `--px-${name}`;
}

/** 读取 token 数值（用于 AntdvNext 的数值型 token，如 borderRadius: 8） */
export function tokenPx(resolved: Record<string, string>, name: string, fallback = 0): number {
    const raw = resolved[name];

    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseFloat(raw);

    return Number.isFinite(parsed) ? parsed : fallback;
}

export function isThemePreset(value: unknown): value is ThemePreset {
    return value === 'light' || value === 'dark';
}

// 覆盖值最终会被拼进 SSR 的 :root{...} <style>，必须按 token 类型校验，
// 只放十六进制/函数色（color-*）与长度（radius-* / font-size-* 等），
// 并阻断 `;{}` `<` 与 url()/expression，杜绝在 :root 内追加任意 CSS 声明。
const INJECTION_PATTERN = /[;{}<>]|url\s*\(|expression\s*\(/iu;
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s/+-]+\)|hsla?\([\d.,%\s/+-]+deg?[\d.,%\s/+-]*\))$/iu;
const SAFE_LENGTH = /^(?:0|[+-]?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|fr))$/u;

export function isSafeOverrideValue(name: string, value: string): boolean {
    const trimmed = value.trim();

    if (trimmed === '' || INJECTION_PATTERN.test(trimmed)) {
        return false;
    }

    if (name.startsWith('color-')) {
        return SAFE_COLOR.test(trimmed);
    }

    return SAFE_LENGTH.test(trimmed);
}

export function normalizeThemeState(raw: unknown): ThemeState {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_THEME, overrides: {} };
    }

    const input = raw as { preset?: unknown, overrides?: unknown };
    const preset = isThemePreset(input.preset) ? input.preset : DEFAULT_THEME.preset;
    const overrides: ThemeOverrides = {};

    if (input.overrides && typeof input.overrides === 'object') {
        for (const [name, value] of Object.entries(input.overrides as Record<string, unknown>)) {
            if (
                THEMABLE_TOKENS.includes(name)
                && typeof value === 'string'
                && isSafeOverrideValue(name, value)
            ) {
                overrides[name] = value.trim();
            }
        }
    }

    return { preset, overrides };
}

export function themeOverridesToCss(overrides: ThemeOverrides): string {
    const entries = Object.entries(overrides)
        .filter(([name, value]) => THEMABLE_TOKENS.includes(name) && isSafeOverrideValue(name, value));

    if (entries.length === 0) {
        return '';
    }

    return `:root{${entries.map(([name, value]) => `${tokenVarName(name)}:${value.trim()}`).join(';')}}`;
}
