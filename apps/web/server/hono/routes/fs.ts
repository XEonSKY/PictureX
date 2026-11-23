import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { getSettings } from '../../settings/setting-store';
import type { AppEnv } from '../env';
import { ApiError } from '../problem';
import { validateQuery } from '../validation';

/**
 * 本地目录浏览（供创建/关联相册时选目录）。
 * 只列目录与是否包含 index.json，不读取任何文件内容；服务默认只监听 127.0.0.1。
 */

const listQuerySchema = z.object({
    path: z.string().trim().min(1).max(4096),
    showHidden: z.enum(['true', 'false']).optional(),
});

interface DirectoryEntry {
    name: string
    path: string
    isAlbum: boolean
    hidden: boolean
}

function isAlbumDirectory(dir: string): boolean {
    return existsSync(join(dir, 'index.json'));
}

function parentOf(path: string): string | null {
    const parent = dirname(path);

    return parent === path ? null : parent;
}

function windowsDrives(): string[] {
    const drives: string[] = [];

    for (let code = 65; code <= 90; code += 1) {
        const root = `${String.fromCharCode(code)}:\\`;

        if (existsSync(root)) {
            drives.push(root);
        }
    }

    return drives;
}

export const fsRoutes = new Hono<AppEnv>()
    .get('/roots', (c) => {
        const settings = getSettings();
        // 相册目录优先，选中框默认落在相册列表而不是某个盘符
        const roots = [
            settings.albumsRoot,
            dirname(settings.albumsRoot),
            ...(process.platform === 'win32' ? windowsDrives() : ['/', homedir()]),
        ];

        return c.json({
            data: [...new Set(roots)].map(path => ({
                path,
                name: path,
                isAlbum: isAlbumDirectory(path),
            })),
        });
    })
    .get('/list', validateQuery(listQuerySchema), (c) => {
        const { path: rawPath, showHidden } = c.req.valid('query');
        const target = resolve(rawPath);
        let stat;

        try {
            stat = statSync(target);
        }
        catch {
            throw new ApiError(404, 'fs_not_found', 'The requested directory does not exist.');
        }

        if (!stat.isDirectory()) {
            throw new ApiError(422, 'fs_not_directory', 'The requested path is not a directory.');
        }

        let dirents;

        try {
            dirents = readdirSync(target, { withFileTypes: true });
        }
        catch {
            throw new ApiError(403, 'fs_permission_denied', 'Cannot read the requested directory.');
        }

        const entries: DirectoryEntry[] = [];

        for (const entry of dirents) {
            const entryPath = join(target, entry.name);
            let directory = entry.isDirectory();

            if (entry.isSymbolicLink()) {
                try {
                    directory = statSync(entryPath).isDirectory();
                }
                catch {
                    continue;
                }
            }

            if (!directory) {
                continue;
            }

            const hidden = entry.name.startsWith('.');

            if (hidden && showHidden !== 'true') {
                continue;
            }

            entries.push({
                name: entry.name,
                path: entryPath,
                isAlbum: isAlbumDirectory(entryPath),
                hidden,
            });
        }

        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

        return c.json({
            data: {
                path: target,
                parent: parentOf(target),
                isAlbum: isAlbumDirectory(target),
                entries,
            },
        });
    });
