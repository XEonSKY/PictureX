#!/usr/bin/env node
/**
 * 校验所有 ApiError / sendProblem 的错误码都存在于 i18n 的 errors.* 中（zh-CN 与 en-US）。
 * 用法：node scripts/check-i18n-errors.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SERVER_DIR = join(ROOT, 'apps', 'web', 'server');
const LOCALES_DIR = join(ROOT, 'apps', 'web', 'i18n', 'locales');

function walk(dir) {
    const files = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...walk(path));
        }
        else if (entry.name.endsWith('.ts')) {
            files.push(path);
        }
    }

    return files;
}

const codePatterns = [
    /new\s+ApiError\(\s*\d+\s*,\s*['"`]([^'"`]+)['"`]/gu,
    /sendProblem\(\s*[^,]+,\s*\d+\s*,\s*['"`]([^'"`]+)['"`]/gu,
];

const codes = new Set();

for (const file of walk(SERVER_DIR)) {
    const source = readFileSync(file, 'utf8');

    for (const pattern of codePatterns) {
        for (const match of source.matchAll(pattern)) {
            codes.add(match[1]);
        }
    }
}

const locales = ['zh-CN', 'en-US'];
let failed = false;

for (const locale of locales) {
    const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    const keys = new Set(Object.keys(messages.errors ?? {}));
    const missing = [...codes].filter(code => !keys.has(code)).sort();

    if (missing.length > 0) {
        failed = true;
        process.stderr.write(`[i18n] ${locale} 缺少错误码翻译: ${missing.join(', ')}\n`);
    }
}

if (failed) {
    process.exit(1);
}

process.stdout.write(`[i18n] ${codes.size} 个错误码在 zh-CN / en-US 中均有翻译\n`);
