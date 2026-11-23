import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    normalizeThemeState,
    resolveThemeTokens,
    THEMABLE_TOKENS,
    themeOverridesToCss,
    tokenPx,
} from '#shared/theme';

const css = readFileSync(join(import.meta.dirname, '..', 'app', 'assets', 'css', 'design-tokens.css'), 'utf8');

describe('design tokens', () => {
    it('ships light and dark palettes from the JSON source', () => {
        expect(css).toContain('[data-theme="light"]');
        expect(css).toContain('[data-theme="dark"]');
        expect(css).toContain('--px-color-brand: #0A59F7;');
        expect(css).toContain('--px-color-brand: #317AF7;');
    });

    it('marks every themable token', () => {
        for (const token of THEMABLE_TOKENS) {
            expect(css).toContain(`--px-${token}:`);
            expect(css).toContain('/* @themable */');
        }
    });
});

describe('theme state', () => {
    it('falls back to defaults for invalid input', () => {
        expect(normalizeThemeState(null)).toEqual({ preset: 'light', overrides: {} });
        expect(normalizeThemeState({ preset: 'neon', overrides: { 'color-brand': '#fff' } })).toEqual({
            preset: 'light',
            overrides: { 'color-brand': '#fff' },
        });
    });

    it('drops overrides outside the whitelist', () => {
        const state = normalizeThemeState({
            preset: 'dark',
            overrides: { 'color-brand': '#123456', 'shadow-modal': 'none' },
        });

        expect(state.overrides).toEqual({ 'color-brand': '#123456' });
    });

    it('resolves preset + overrides and serializes CSS variables', () => {
        const tokens = resolveThemeTokens('dark', { 'color-brand': '#123456' });

        expect(tokens['color-brand']).toBe('#123456');
        expect(tokens['color-bg-page']).toBe('#191A1C');
        expect(tokenPx(tokens, 'radius-sm')).toBe(8);
        expect(themeOverridesToCss({ 'color-brand': '#123456' })).toBe(':root{--px-color-brand:#123456}');
    });
});
