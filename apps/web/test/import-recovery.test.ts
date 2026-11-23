import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createImportJob,
    deleteAlbumImportJobs,
    getImportJob,
    listImportJobs,
    pauseStaleImports,
} from '../server/album/import-job-store';
import { closeTaskDatabase } from '../server/database/task';

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'picturex-tasks-'));
    process.env.NUXT_DATA_DIR = dataDir;
});

afterEach(() => {
    closeTaskDatabase();
    delete process.env.NUXT_DATA_DIR;

    try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('import recovery after a crash', () => {
    it('turns leftover running jobs into paused so they can be resumed', () => {
        const job = createImportJob('album-1', 'job-1', 'C:/photos');

        expect(job.status).toBe('running');
        expect(pauseStaleImports('album-1', true)).toBe(0);
        expect(getImportJob('album-1', 'job-1').status).toBe('running');

        expect(pauseStaleImports('album-1', false)).toBe(1);

        const paused = getImportJob('album-1', 'job-1');

        expect(paused.status).toBe('paused');
        expect(paused.finishedAt).toBeNull();
        expect(paused.error).toContain('restart');
    });

    it('keeps each album seeing only its own jobs', () => {
        createImportJob('album-1', 'job-1', 'C:/a');
        createImportJob('album-2', 'job-2', 'C:/b');

        expect(listImportJobs('album-1', 10).map(job => job.id)).toEqual(['job-1']);
        expect(listImportJobs('album-2', 10).map(job => job.id)).toEqual(['job-2']);
        // 任务 id 只在所属相册内可寻址，避免跨相册读到别人的任务
        expect(() => getImportJob('album-2', 'job-1')).toThrow();

        expect(deleteAlbumImportJobs('album-1')).toBe(1);
        expect(listImportJobs('album-1', 10)).toHaveLength(0);
        expect(listImportJobs('album-2', 10)).toHaveLength(1);
    });
});
