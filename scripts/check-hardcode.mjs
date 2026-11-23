#!/usr/bin/env node
/**
 * 硬编码审计：
 * - apps/web/app 下 .vue/.ts 中出现中文（注释行除外）即失败
 * - .vue/.ts 中出现十六进制色值即失败（Token/主题/SVG 由生成器与 SVG 承担）
 *
 * 用法：node scripts/check-hardcode.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APP_DIR = join(ROOT, 'apps', 'web', 'app');

function walk(dir) {
    const files = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...walk(path));
        }
        else if (/\.(?:vue|ts)$/u.test(entry.name)) {
            files.push(path);
        }
    }

    return files;
}

const HAN = /[\u4e00-\u9fa5]/u;
const HEX = /#[0-9a-fA-F]{3,8}\b/u;
const failures = [];

for (const file of walk(APP_DIR)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);

    lines.forEach((line, index) => {
        const trimmed = line.trim();

        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('<!--')) {
            return;
        }

        if (HAN.test(line)) {
            failures.push(`${file}:${index + 1} 中文文案（请移到 i18n）`);
        }
        if (HEX.test(line)) {
            failures.push(`${file}:${index + 1} 十六进制色值（请使用 Token）`);
        }
    });
}

if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exit(1);
}

process.stdout.write('硬编码审计通过：无用户可见中文、无十六进制色值\n');
