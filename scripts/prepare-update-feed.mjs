#!/usr/bin/env node
/**
 * 把 electron-builder 生成的 latest*.yml 改写成「指向 GitHub Release 资产」的更新元数据。
 *
 * 安装包体积远超 GitHub 100MB 单文件限制，无法放进仓库分支，因此更新目录只托管
 * 元数据，二进制继续留在 Release；electron-updater 支持绝对 URL，blockmap 会按
 * `<url>.blockmap` 拼接。
 *
 *   node scripts/prepare-update-feed.mjs --from <dir> --out <dir> --tag v1.2.3 [--repo owner/repo]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const CHANNEL_FILES = ['latest.yml', 'latest-linux.yml', 'latest-mac.yml'];

const args = process.argv.slice(2);

function arg(name, fallback = '') {
    const index = args.indexOf(`--${name}`);

    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const fromDir = arg('from');
const outDir = arg('out');
const tag = arg('tag');
const repo = arg('repo', process.env.GITHUB_REPOSITORY ?? 'XEonSKY/PictureX');

if (!fromDir || !outDir || !tag) {
    process.stderr.write('usage: --from <dir> --out <dir> --tag <tag> [--repo owner/repo]\n');
    process.exit(1);
}

const base = `https://github.com/${repo}/releases/download/${tag}/`;
const absolute = url => (/^[a-z][a-z\d+.-]*:\/\//iu.test(url) ? url : `${base}${url}`);

mkdirSync(outDir, { recursive: true });

let written = 0;

for (const name of CHANNEL_FILES) {
    const source = join(fromDir, name);

    if (!existsSync(source)) {
        continue;
    }

    const doc = parse(readFileSync(source, 'utf8'));

    if (doc && typeof doc === 'object') {
        if (typeof doc.path === 'string') {
            doc.path = absolute(doc.path);
        }
        if (Array.isArray(doc.files)) {
            for (const file of doc.files) {
                if (!file || typeof file.url !== 'string') {
                    continue;
                }

                // 补 blockMapSize：electron-builder 未走 publish 时不会写入该字段，
                // 缺少它 electron-updater 会退回整包下载。
                const name = file.url.split('/').pop();
                const blockmap = join(fromDir, `${name}.blockmap`);

                if (name && existsSync(blockmap)) {
                    file.blockMapSize = statSync(blockmap).size;
                }

                file.url = absolute(file.url);
            }
        }
    }

    writeFileSync(join(outDir, name), stringify(doc));
    written += 1;
    process.stdout.write(`[update-feed] ${name} -> ${outDir}\n`);
}

if (written === 0) {
    process.stderr.write('[update-feed] 没有找到 latest*.yml\n');
    process.exit(1);
}

process.stdout.write(`[update-feed] ${written} 个元数据文件，下载基地址 ${base}\n`);
