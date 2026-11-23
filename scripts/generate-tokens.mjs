#!/usr/bin/env node
/**
 * 从 apps/web/shared/theme-tokens.json 生成 design-tokens.css。
 * 单一事实源：Token 值只写在 JSON；CSS 与运行时换肤都从这里派生。
 *
 *   node scripts/generate-tokens.mjs           写入文件
 *   node scripts/generate-tokens.mjs --check   校验文件是否为最新（CI / 单测）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'apps', 'web', 'shared', 'theme-tokens.json');
const TARGET = join(ROOT, 'apps', 'web', 'app', 'assets', 'css', 'design-tokens.css');

const manifest = JSON.parse(readFileSync(SOURCE, 'utf8'));
const themable = new Set(manifest.themable ?? []);

function block(selector, theme) {
    const entries = Object.entries({ ...manifest.shared, ...manifest[theme] });
    const lines = entries.map(([name, value]) => {
        const marker = themable.has(name) ? '    /* @themable */\n' : '';

        return `${marker}    --px-${name}: ${value};`;
    });

    return `${selector} {\n    color-scheme: ${theme};\n${lines.join('\n')}\n}\n`;
}

const header = `/*
 * design-tokens.css —— 自动生成，请勿手改。
 * 源文件：apps/web/shared/theme-tokens.json
 * 重新生成：pnpm tokens:gen
 *
 * 命名：--px-<类别>-<语义>
 * 带 @themable 注释标记的 Token 允许用户在设置页覆盖。
 */

`;

const css = header
    + block(':root,\n[data-theme="light"]', 'light')
    + '\n'
    + block('[data-theme="dark"]', 'dark');

if (process.argv.includes('--check')) {
    const current = (() => {
        try {
            return readFileSync(TARGET, 'utf8');
        }
        catch {
            return '';
        }
    })();

    if (current !== css) {
        process.stderr.write('design-tokens.css 已过期，请执行 pnpm tokens:gen\n');
        process.exit(1);
    }

    process.stdout.write('design-tokens.css 已是最新\n');
    process.exit(0);
}

writeFileSync(TARGET, css);
process.stdout.write(`已生成 ${TARGET}\n`);
