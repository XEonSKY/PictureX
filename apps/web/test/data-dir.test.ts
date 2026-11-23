import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeDataDirectories, parseDataDirArg, resolveDataDir } from '../server/utils/data-dir';

describe('parseDataDirArg', () => {
    it('accepts -dataDir, --dataDir= and --data-dir= forms', () => {
        expect(parseDataDirArg(['-dataDir', '/var/lib/app'])).toBe('/var/lib/app');
        expect(parseDataDirArg(['--dataDir=/var/lib/app'])).toBe('/var/lib/app');
        expect(parseDataDirArg(['--data-dir', '/var/lib/app'])).toBe('/var/lib/app');
    });

    it('ignores flags without a value', () => {
        expect(parseDataDirArg(['-dataDir'])).toBeUndefined();
        expect(parseDataDirArg(['-dataDir', '--open'])).toBeUndefined();
    });
});

describe('resolveDataDir', () => {
    it('prioritizes argv over env', () => {
        expect(resolveDataDir({
            argv: ['-dataDir', '/from/argv'],
            env: { NUXT_DATA_DIR: '/from/env' },
            cwd: '/cwd',
            isProduction: true,
        })).toBe('/from/argv');
    });

    it('uses the home directory default in production', () => {
        const resolved = resolveDataDir({
            argv: [],
            env: {},
            cwd: '/cwd',
            isProduction: true,
            homeDir: '/home/tester',
        });

        expect(resolved).toBe(join('/home/tester', '.xeonsky', 'picturex'));
    });

    it('uses the workspace .dev/data folder in development', () => {
        const resolved = resolveDataDir({
            argv: [],
            env: {},
            cwd: join(import.meta.dirname, '..'),
            isProduction: false,
        });

        expect(resolved.replace(/\\/gu, '/')).toMatch(/\/\.dev\/data$/u);
    });
});

describe('describeDataDirectories', () => {
    it('derives the PictureX layout from dataDir', () => {
        const dirs = describeDataDirectories({ argv: ['-dataDir', '/data'], isProduction: true });

        expect(dirs.settingPath).toBe(join('/data', 'setting.json'));
        expect(dirs.albumsRoot).toBe(join('/data', 'albums'));
        expect(dirs.modelsRoot).toBe(join('/data', 'models'));
        expect(dirs.downloadDir).toBe(join('/data', '.download'));
        expect(dirs.cacheDir).toBe(join('/data', 'cache'));
        expect(dirs.thumbnailDbPath).toBe(join('/data', 'data', 'thumbnails.db'));
        expect(dirs.pixivDbPath).toBe(join('/data', 'data', 'pixiv.db'));
        expect(dirs.pictureDbPath).toBe(join('/data', 'data', 'picture.db'));
        expect(dirs.globalTagDbPath).toBe(join('/data', 'data', 'tag.db'));
        expect(dirs.taskDbPath).toBe(join('/data', 'data', 'task.db'));
        expect(dirs.databaseDir).toBe(join('/data', 'data'));
    });
});
