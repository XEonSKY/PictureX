#!/usr/bin/env node
/**
 * 跨包管理器任务启动器：`node scripts/task.mjs <包目录> <script> [...args]`
 *
 * pnpm / yarn / bun / npm 都能 `run <script>`，差别只在二进制名，所以按
 * npm_config_user_agent 识别当前管理器即可，根 package.json 的脚本因此不绑定 pnpm。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Nitro 产物里的原生模块按 Node 26 ABI 编译，低版本会报难以理解的 dlopen 错误。
// CLI 已有同款检查（picturex.mjs），这里补齐经 task 启动器运行的 dev/build/test 路径。
const REQUIRED_NODE_MAJOR = 26;
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (nodeMajor < REQUIRED_NODE_MAJOR) {
    process.stderr.write(
        `[task] 需要 Node.js >= ${REQUIRED_NODE_MAJOR}，当前 ${process.versions.node}。请切换版本（如 nvm use）后重试。\n`,
    );
    process.exit(1);
}

const MANAGERS = {
    pnpm: ['pnpm', ['run']],
    yarn: ['yarn', ['run']],
    bun: ['bun', ['run']],
    npm: ['npm', ['run']],
};

function detectManager() {
    const userAgent = process.env.npm_config_user_agent ?? '';
    const name = userAgent.split('/')[0];

    return MANAGERS[name] ? name : 'npm';
}

const [, , packageDir, script, ...rest] = process.argv;

if (!packageDir || !script) {
    process.stderr.write('用法: node scripts/task.mjs <包目录> <script> [...args]\n');
    process.exit(1);
}

const manager = detectManager();
const [command, baseArgs] = MANAGERS[manager];
const cwd = join(ROOT, packageDir);

process.stdout.write(`[task] ${manager} ${script} @ ${packageDir}\n`);

// 经包管理器脚本启动时，npm_execpath 指向其 JS 入口（pnpm.cjs / npm-cli.js）。
// 直接用 node 执行它可完全绕开 Windows 的 .cmd 与 shell 转义问题。
const execPath = process.env.npm_execpath ?? '';
const useExecPath = execPath !== ''
    && existsSync(execPath)
    && ['.js', '.cjs', '.mjs'].includes(extname(execPath).toLowerCase());

let child;

if (useExecPath) {
    child = spawn(process.execPath, [execPath, 'run', script, ...rest], {
        cwd,
        stdio: 'inherit',
        env: process.env,
    });
}
else {
    // 兜底：手工启动 node scripts/task.mjs 时没有 npm_execpath。
    // Windows 的 .cmd 只能经 shell；引号按 cmd 规则用双写转义（\" 在 cmd 里无效）。
    const WINDOWS_BINS = { pnpm: 'pnpm.cmd', npm: 'npm.cmd', yarn: 'yarn.cmd', bun: 'bun.exe' };
    const bin = process.platform === 'win32' ? (WINDOWS_BINS[manager] ?? command) : command;
    const SAFE_ARG = /^[\w@:/=.,+-]+$/u;
    const POSIX_ESCAPE = "'\\''";
    const quote = (value) => {
        if (SAFE_ARG.test(value)) {
            return value;
        }

        return process.platform === 'win32'
            ? `"${value.replace(/"/gu, '""')}"`
            : `'${value.replace(/'/gu, POSIX_ESCAPE)}'`;
    };
    const commandLine = [bin, ...baseArgs, script, ...rest].map(quote).join(' ');

    child = spawn(commandLine, {
        cwd,
        stdio: 'inherit',
        shell: true,
        env: process.env,
    });
}

child.on('exit', code => {
    process.exit(code ?? 1);
});

child.on('error', error => {
    process.stderr.write(`[task] 启动失败: ${error.message}\n`);
    process.exit(1);
});
