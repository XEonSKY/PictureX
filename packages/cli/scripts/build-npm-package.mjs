#!/usr/bin/env node
/**
 * 把 dist/nuxt（Nitro 产物）组装成可发布的 npm 包目录（dist/package/）。
 * 产物结构：
 *   dist/package/package.json        包名 @xeonsky/picturex，bin: picturex
 *   dist/package/bin/…               命令行入口（源文件在 packages/cli/bin）
 *   dist/package/server/、public/    Nitro 运行时产物
 *
 * PictureX 没有全局业务数据库：相册的 data/picture.db、data/tag.db、data/pixiv.db 与数据根的 data/thumbnails.db
 * 在首次访问时自动建表/迁移，因此发布包不需要 migrations 目录。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const PACKAGE_NAME = '@xeonsky/picturex';
const BIN_NAME = 'picturex';

// 脚本在 packages/cli/scripts，回退三层到仓库根
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const OUTPUT_DIR = join(ROOT, 'dist', 'package');
const BUILD_DIR = join(ROOT, 'dist', 'nuxt');
const CLI_SOURCE = join(ROOT, 'packages', 'cli', 'bin', `${BIN_NAME}.mjs`);

function fail(message) {
    process.stderr.write(`构建 npm 包失败: ${message}\n`);
    process.exit(1);
}

if (!existsSync(CLI_SOURCE)) {
    fail(`缺少 packages/cli/bin/${BIN_NAME}.mjs`);
}

if (!existsSync(join(BUILD_DIR, 'server', 'index.mjs'))) {
    fail('缺少 dist/nuxt/server/index.mjs，请先执行 nuxt build（根目录 pnpm build）');
}

const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = typeof rootPackage.version === 'string' ? rootPackage.version : '0.0.0';

rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

// Nitro 产物：server 与 public 必须保持同级，index.mjs 里按相对路径找静态资源
cpSync(join(BUILD_DIR, 'server'), join(OUTPUT_DIR, 'server'), { recursive: true });

if (existsSync(join(BUILD_DIR, 'public'))) {
    cpSync(join(BUILD_DIR, 'public'), join(OUTPUT_DIR, 'public'), { recursive: true });
}

mkdirSync(join(OUTPUT_DIR, 'bin'), { recursive: true });
cpSync(CLI_SOURCE, join(OUTPUT_DIR, 'bin', `${BIN_NAME}.mjs`));

// ffmpeg 通过运行时 createRequire 解析，Nitro 静态追踪看不到二进制：
// 显式把两个包放到 server/node_modules，npm 包才能抽帧/转码。
const requireFromRoot = createRequire(join(ROOT, 'package.json'));

for (const packageName of ['ffmpeg-static', 'ffprobe-static']) {
    const manifestPath = requireFromRoot.resolve(`${packageName}/package.json`);
    const target = join(OUTPUT_DIR, 'server', 'node_modules', packageName);

    cpSync(dirname(manifestPath), target, { recursive: true });
}

// ffprobe-static 自带三平台二进制；发布包只保留当前 runner 的平台/架构
const ffprobeBin = join(OUTPUT_DIR, 'server', 'node_modules', 'ffprobe-static', 'bin');

if (existsSync(ffprobeBin)) {
    for (const platform of readdirSync(ffprobeBin)) {
        const platformDir = join(ffprobeBin, platform);

        if (platform !== process.platform) {
            rmSync(platformDir, { recursive: true, force: true });
            continue;
        }

        for (const arch of readdirSync(platformDir)) {
            if (arch !== process.arch) {
                rmSync(join(platformDir, arch), { recursive: true, force: true });
            }
        }
    }
}

const manifest = {
    name: PACKAGE_NAME,
    version,
    description: 'PictureX：本地优先、支持 i18n 与运行时换肤的 AI 相册，一条 CLI 本地运行',
    type: 'module',
    bin: { [BIN_NAME]: `bin/${BIN_NAME}.mjs` },
    files: ['bin', 'server', 'public', 'README.md'],
    engines: { node: '>=26.0.0' },
    license: 'UNLICENSED',
    private: false,
    keywords: ['photos', 'ai', 'clip', 'blip', 'nuxt', 'hono', 'local-first'],
};

writeFileSync(join(OUTPUT_DIR, 'package.json'), `${JSON.stringify(manifest, null, 4)}\n`);

const README = `# ${PACKAGE_NAME}

PictureX：本地优先、支持 i18n、可运行时换肤的 AI 相册。
每个相册都是自包含目录（index.json / data/*.db / storage），
缩略图缓存统一存放在数据根目录的 data/thumbnails.db 中（按 album_id、尺寸分表隔离）。

## 运行

\`\`\`bash
npx ${PACKAGE_NAME} web

# 或全局安装
npm i -g ${PACKAGE_NAME}
${BIN_NAME} web
\`\`\`

## 常用参数

| 参数 | 说明 | 默认 |
|---|---|---|
| \`-p, --port <port>\` | 监听端口 | 8830 |
| \`-H, --host <host>\` | 监听地址（局域网开放用 0.0.0.0） | 127.0.0.1 |
| \`-d, --data-dir <dir>\` | 数据目录 | \`~/.xeonsky/picturex\` |
| \`-o, --open\` | 启动后自动打开浏览器 | 关闭 |

## 数据目录

- \`<dataDir>/setting.json\`：全局设置。
- \`<dataDir>/albums/<albumId>/\`：相册（含元数据、标签、两个 SQLite 库与原件）。
- \`<dataDir>/models/index.json\`：模型清单。
- \`<dataDir>/.download/index.json\`：下载任务清单。

要求 Node >= 26。
`;

writeFileSync(join(OUTPUT_DIR, 'README.md'), README);

process.stdout.write(`npm 包目录已生成: ${OUTPUT_DIR}\n`);
