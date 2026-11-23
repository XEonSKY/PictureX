import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * 运行期数据根目录。优先级（高 → 低）：
 *   1. 命令行 -dataDir / --dataDir / --data-dir
 *   2. 环境变量 NUXT_DATA_DIR
 *   3. 开发模式：仓库根下 .dev/data
 *   4. 生产模式：~/.xeonsky/picturex
 *
 * 数据目录解析只允许发生在本文件；其它地方禁止手写数据路径。
 */

const FLAG_NAMES = ['-dataDir', '--dataDir', '--data-dir'] as const;

const PROD_DIR_PARTS = ['.xeonsky', 'picturex'] as const;
const DEV_DIR_NAME = '.dev';
const DEV_DATA_NAME = 'data';

export function parseDataDirArg(argv: readonly string[]): string | undefined {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (!arg) {
            continue;
        }

        for (const flag of FLAG_NAMES) {
            if (arg === flag) {
                const next = argv[index + 1];

                if (next && !next.startsWith('-')) {
                    return next;
                }

                break;
            }

            if (arg.startsWith(`${flag}=`)) {
                const value = arg.slice(flag.length + 1).trim();

                if (value !== '') {
                    return value;
                }
            }
        }
    }

    return undefined;
}

/**
 * 向上找工作区根：pnpm 认 pnpm-workspace.yaml，yarn/npm/bun 认 package.json 的 workspaces。
 * 找不到就返回 undefined（单包部署场景）。
 */
export function findWorkspaceRoot(startDir: string): string | undefined {
    let current = startDir;

    for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
            return current;
        }

        const manifestPath = join(current, 'package.json');

        if (existsSync(manifestPath)) {
            try {
                const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));

                if (
                    manifest
                    && typeof manifest === 'object'
                    && 'workspaces' in manifest
                    && Array.isArray((manifest as { workspaces?: unknown }).workspaces)
                ) {
                    return current;
                }
            }
            catch {
                // package.json 损坏时继续向上找
            }
        }

        const parent = dirname(current);

        if (parent === current) {
            return undefined;
        }

        current = parent;
    }

    return undefined;
}

export interface ResolveDataDirOptions {
    argv?: readonly string[]
    env?: Record<string, string | undefined>
    cwd?: string
    /** 默认取 NODE_ENV === 'production' */
    isProduction?: boolean
    /** 生产模式默认目录的用户主目录（测试可注入） */
    homeDir?: string
}

export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

    const explicit = parseDataDirArg(argv) ?? env.NUXT_DATA_DIR;

    if (explicit) {
        return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    }

    if (!isProduction) {
        const workspaceRoot = findWorkspaceRoot(cwd);

        if (workspaceRoot) {
            return join(workspaceRoot, DEV_DIR_NAME, DEV_DATA_NAME);
        }
    }

    return join(options.homeDir ?? homedir(), ...PROD_DIR_PARTS);
}

export interface DataDirectories {
    /** 数据根目录 */
    dataDir: string
    /** 全局设置 <dataDir>/setting.json */
    settingPath: string
    /** 所有运行期 SQLite 的目录 <dataDir>/data */
    databaseDir: string
    /** 相册根目录 <dataDir>/albums */
    albumsRoot: string
    /** 模型仓库 <dataDir>/models */
    modelsRoot: string
    /** 下载任务目录 <dataDir>/.download */
    downloadDir: string
    /** 缓存目录 <dataDir>/cache */
    cacheDir: string
    /** 统一缩略图库 <dataDir>/data/thumbnails.db */
    thumbnailDbPath: string
    /** 图片/视频查看器的全局库 <dataDir>/data/picture.db */
    pictureDbPath: string
    /** 所有 Pixiv 作品详情与画师/标签的全局库 <dataDir>/data/pixiv.db */
    pixivDbPath: string
    /** 全局标签主数据 <dataDir>/data/tag.db */
    globalTagDbPath: string
    /** Pixiv 云端图片本地缓存 <dataDir>/data/cloud.db */
    cloudDbPath: string
    /** 导入与 AI 任务 <dataDir>/data/task.db */
    taskDbPath: string
}

/** 相册数据库目录 <album>/data；相册根目录仍只放 index.json 与 storage/ */
export function albumDatabaseDir(albumDir: string): string {
    return join(albumDir, 'data');
}

export function albumPictureDbPath(albumDir: string): string {
    return join(albumDatabaseDir(albumDir), 'picture.db');
}

export function albumTagDbPath(albumDir: string): string {
    return join(albumDatabaseDir(albumDir), 'tag.db');
}

export function albumPixivDbPath(albumDir: string): string {
    return join(albumDatabaseDir(albumDir), 'pixiv.db');
}

export function describeDataDirectories(options: ResolveDataDirOptions = {}): DataDirectories {
    const dataDir = resolveDataDir(options);
    const databaseDir = join(dataDir, 'data');

    return {
        dataDir,
        settingPath: join(dataDir, 'setting.json'),
        databaseDir,
        albumsRoot: join(dataDir, 'albums'),
        modelsRoot: join(dataDir, 'models'),
        downloadDir: join(dataDir, '.download'),
        cacheDir: join(dataDir, 'cache'),
        thumbnailDbPath: join(databaseDir, 'thumbnails.db'),
        pictureDbPath: join(databaseDir, 'picture.db'),
        pixivDbPath: join(databaseDir, 'pixiv.db'),
        globalTagDbPath: join(databaseDir, 'tag.db'),
        cloudDbPath: join(databaseDir, 'cloud.db'),
        taskDbPath: join(databaseDir, 'task.db'),
    };
}

/** 首次启动时补目录；已存在时无副作用 */
export function ensureDataDirectories(options: ResolveDataDirOptions = {}): DataDirectories {
    const directories = describeDataDirectories(options);

    for (const directory of [
        directories.dataDir,
        directories.databaseDir,
        directories.albumsRoot,
        directories.modelsRoot,
        directories.downloadDir,
        directories.cacheDir,
    ]) {
        mkdirSync(directory, { recursive: true });
    }

    return directories;
}
