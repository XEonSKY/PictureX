#!/usr/bin/env node
/**
 * 校验 docs/ 中以 /guide/、/api/ 开头的站内链接是否指向存在的页面。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const docsRoot = join(ROOT, 'docs');
const errors = [];

if (!existsSync(docsRoot)) {
    process.stdout.write('[docs] 没有 docs 目录，跳过校验\n');
    process.exit(0);
}

const files = [];

function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            walk(path);
        }
        else if (entry.name.endsWith('.md')) {
            files.push(path);
        }
    }
}

walk(docsRoot);

for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const links = text.matchAll(/\]\((\/(?:guide|api)\/[^)\s]+)\)/gu);

    for (const [, raw] of links) {
        const path = raw.split('#')[0];
        const target = join(docsRoot, path);
        const candidates = [target, `${target}.md`, join(target, 'index.md')];

        if (!candidates.some(candidate => existsSync(candidate))) {
            errors.push(`${file.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '')}: 链接指向不存在的页面 ${raw}`);
        }
    }
}

if (errors.length > 0) {
    for (const error of errors) {
        process.stderr.write(`[docs] ${error}\n`);
    }
    process.exit(1);
}

process.stdout.write(`[docs] ${files.length} 篇文档内链校验通过\n`);
