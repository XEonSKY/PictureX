#!/usr/bin/env node
/**
 * picturex —— PictureX 的命令行入口。
 *
 *   picturex web [options]   启动 Web 服务
 *   picturex help            查看帮助
 *   picturex version         查看版本
 *
 * 包内布局：bin/（本文件）、server/ + public/（Nitro 产物）。
 * 只用 Node 内置模块，与 Nuxt 构建完全解耦。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_NODE_MAJOR = 26;
const DEFAULT_PORT = 8830;
const DEFAULT_HOST = '127.0.0.1';

/**
 * 向上找最近的 package.json 所在目录作为「包根」：
 * - npm 安装后：<包根>/bin/… → <包根>
 * - 源码树内：<仓库>/packages/cli/bin/… → <仓库>/packages/cli
 */
function findPackageRoot(start) {
    let dir = start;

    for (let depth = 0; depth < 5; depth += 1) {
        if (existsSync(join(dir, 'package.json'))) {
            return dir;
        }
        dir = dirname(dir);
    }

    return start;
}

/** 向上找工作区根（pnpm-workspace.yaml 或含 workspaces 的 package.json） */
function findWorkspaceRoot(start) {
    let dir = start;

    for (let depth = 0; depth < 6; depth += 1) {
        if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
            return dir;
        }

        const manifestPath = join(dir, 'package.json');

        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

                if (Array.isArray(manifest.workspaces)) {
                    return dir;
                }
            }
            catch {
                // 解析失败继续向上
            }
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return null;
        }

        dir = parent;
    }

    return null;
}

const PACKAGE_ROOT = findPackageRoot(import.meta.dirname);
const WORKSPACE_ROOT = findWorkspaceRoot(import.meta.dirname);

/**
 * 服务端产物位置：
 * - 发布包内：<包根>/server/index.mjs
 * - 仓库内（工作区）：<仓库>/dist/nuxt/server/index.mjs
 */
function resolveRuntime() {
    const candidates = [
        join(PACKAGE_ROOT, 'server', 'index.mjs'),
    ];

    if (WORKSPACE_ROOT) {
        candidates.push(join(WORKSPACE_ROOT, 'dist', 'nuxt', 'server', 'index.mjs'));
    }

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return { serverEntry: candidate };
        }
    }

    return null;
}

const HELP_TEXT = `picturex —— 本地优先的 AI 相册（Nuxt 4 / Hono 4 / Drizzle）

用法:
  picturex web [选项]     启动 Web 服务
  picturex help           显示本帮助
  picturex version        显示版本

web 选项:
  -p, --port <port>        监听端口（默认 ${DEFAULT_PORT}）
  -H, --host <host>        监听地址（默认 ${DEFAULT_HOST}；对局域网开放用 0.0.0.0）
  -d, --data-dir <dir>     数据目录（默认 ~/.xeonsky/picturex）
  -o, --open               启动后自动用默认浏览器打开
      --no-open            不自动打开（默认行为）
  -h, --help               显示本帮助

示例:
  npx @xeonsky/picturex web
  picturex web --port 9000 --host 0.0.0.0 --open

环境变量（未通过命令行指定时生效）:
  PORT / NITRO_PORT         监听端口
  HOST / NITRO_HOST         监听地址
  NUXT_DATA_DIR             数据目录
  PX_MODEL_SOURCE           模型下载源（默认 modelscope；设为 hf-mirror 回退 HF）
  PX_MODEL_MIRROR           HF 镜像主机名（仅 PX_MODEL_SOURCE=hf-mirror 时生效）
  PX_AUTH_TOKEN             访问令牌（对局域网/代理访问生效，本机回环可留空）
  PX_ALLOW_INSECURE_BIND    设为 1 才允许「非回环绑定 + 无令牌」启动（默认拒绝）
`;

function parsePort(raw, from) {
    const port = Number.parseInt(raw, 10);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail(`端口不合法: ${raw}（来自 ${from}），应为 1-65535 的整数`);
    }

    return port;
}

function fail(message) {
    process.stderr.write(`错误: ${message}\n\n`);
    process.stderr.write(HELP_TEXT);

    process.exit(1);
}

function takeValue(args, index, flag) {
    const next = args[index + 1];

    if (!next || next.startsWith('-')) {
        fail(`${flag} 需要一个值`);
    }

    return next;
}

function parseWebOptions(args) {
    const options = {
        port: undefined,
        host: undefined,
        dataDir: undefined,
        open: false,
        help: false,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }

        if (arg === '-o' || arg === '--open') {
            options.open = true;
            continue;
        }

        if (arg === '--no-open') {
            options.open = false;
            continue;
        }

        if (arg === '-p' || arg === '--port') {
            options.port = takeValue(args, index, arg);
            index += 1;
            continue;
        }

        if (arg.startsWith('--port=')) {
            options.port = arg.slice('--port='.length);
            continue;
        }

        if (arg === '-H' || arg === '--host') {
            options.host = takeValue(args, index, arg);
            index += 1;
            continue;
        }

        if (arg.startsWith('--host=')) {
            options.host = arg.slice('--host='.length);
            continue;
        }

        if (arg === '-d' || arg === '--data-dir' || arg === '--dataDir' || arg === '-dataDir') {
            options.dataDir = takeValue(args, index, arg);
            index += 1;
            continue;
        }

        if (arg.startsWith('--data-dir=')) {
            options.dataDir = arg.slice('--data-dir='.length);
            continue;
        }

        if (arg.startsWith('--dataDir=')) {
            options.dataDir = arg.slice('--dataDir='.length);
            continue;
        }

        fail(`未知选项: ${arg}`);
    }

    return options;
}

function openBrowser(url) {
    const command = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];

    try {
        const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });

        child.on('error', () => {
            process.stderr.write(`未能自动打开浏览器，请手动访问 ${url}\n`);
        });
        child.unref();
    }
    catch {
        process.stderr.write(`未能自动打开浏览器，请手动访问 ${url}\n`);
    }
}

function readVersion() {
    const packageJsonPath = join(PACKAGE_ROOT, 'package.json');

    if (!existsSync(packageJsonPath)) {
        return '0.0.0';
    }

    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

async function startWeb(args) {
    const options = parseWebOptions(args);

    if (options.help) {
        process.stdout.write(HELP_TEXT);

        return;
    }

    const runtime = resolveRuntime();

    if (!runtime) {
        fail('找不到服务端产物：请先执行 pnpm build（产出 dist/nuxt）或用发布包内的 bin');
    }

    const port = parsePort(
        String(options.port ?? process.env.PORT ?? process.env.NITRO_PORT ?? DEFAULT_PORT),
        options.port ? '--port' : '环境变量',
    );
    const host = options.host ?? process.env.HOST ?? process.env.NITRO_HOST ?? DEFAULT_HOST;
    const explicitDataDir = options.dataDir ?? process.env.NUXT_DATA_DIR;
    const dataDir = explicitDataDir ? resolve(explicitDataDir) : null;
    const displayDataDir = dataDir ?? join(homedir(), '.xeonsky', 'picturex');

    // Nitro 产物按 Node 服务器运行；CLI 负责把参数翻译成运行期环境变量
    process.env.NODE_ENV ??= 'production';

    if (dataDir) {
        mkdirSync(dataDir, { recursive: true });
        process.env.NUXT_DATA_DIR = dataDir;
    }
    process.env.PORT = String(port);
    process.env.NITRO_PORT = String(port);
    process.env.HOST = host;
    process.env.NITRO_HOST = host;

    const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${port}`;

    const authToken = process.env.PX_AUTH_TOKEN?.trim() ?? '';
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    const exposed = !loopback;
    const allowInsecure = process.env.PX_ALLOW_INSECURE_BIND === '1';

    if (exposed && authToken === '' && !allowInsecure) {
        fail(
            `监听地址 ${host} 对局域网/公网开放但未设置 PX_AUTH_TOKEN，接口没有任何认证，`
            + '任意同网段访客都能读取全部相册并借 ffmpeg 转码执行任意程序。'
            + '请设置 PX_AUTH_TOKEN 后重试，或仅本机访问（默认 127.0.0.1）；'
            + '确需在可信网络无鉴权开放时设 PX_ALLOW_INSECURE_BIND=1。',
        );
    }

    process.stdout.write('\npicturex\n');
    process.stdout.write(`  访问地址: ${url}\n`);
    if (exposed && authToken === '') {
        process.stdout.write('  警告: 已通过 PX_ALLOW_INSECURE_BIND=1 跳过鉴权检查，接口没有认证，请仅在可信网络使用\n');
    }
    else if (authToken !== '') {
        // 回环地址同样需要令牌；不打印带令牌地址会让 --open 直接 401
        process.stdout.write(`  访问令牌: ${url}/?token=${encodeURIComponent(authToken)}\n`);
    }
    process.stdout.write(`  数据目录: ${displayDataDir}\n`);
    process.stdout.write('\n');

    // Nitro 产物顶层可能读取 globalThis._importMeta_.url；ESM 依赖先于入口执行，
    // 必须在动态 import 之前写入真实的 file URL，否则会拿到 file:///_entry.js 占位地址。
    const serverUrl = pathToFileURL(runtime.serverEntry).href;

    process.env.PX_SERVER_ROOT = dirname(runtime.serverEntry);
    globalThis._importMeta_ = { url: serverUrl, env: process.env };

    await import(serverUrl);

    if (options.open) {
        const openUrl = authToken !== '' ? `${url}/?token=${encodeURIComponent(authToken)}` : url;

        setTimeout(() => openBrowser(openUrl), 800);
    }
}

async function main() {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

    // Nitro 产物里的原生模块按 Node 26 ABI 编译，低版本会报难以理解的 dlopen 错误
    if (nodeMajor < REQUIRED_NODE_MAJOR) {
        fail(`需要 Node.js >= ${REQUIRED_NODE_MAJOR}，当前 ${process.versions.node}`);
    }

    const [, , first, ...rest] = process.argv;

    // 直接跟选项（如 `picturex --port 9000`）视为 web
    if (!first || first === 'help' || first === '--help' || first === '-h') {
        process.stdout.write(HELP_TEXT);

        return;
    }

    if (first === 'version' || first === '--version' || first === '-v') {
        process.stdout.write(`${readVersion()}\n`);

        return;
    }

    if (first === 'web') {
        await startWeb(rest);

        return;
    }

    if (first.startsWith('-')) {
        await startWeb([first, ...rest]);

        return;
    }

    fail(`未知命令: ${first}`);
}

main().catch((error) => {
    process.stderr.write(`启动失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
