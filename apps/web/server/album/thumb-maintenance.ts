import type { AlbumContext } from './album-store';
import { createThumbStore } from './thumb-store';
import { leaseAlbumDatabase } from '../database/album';
import { logger } from '../logger';
import type { Settings } from '../settings/setting-schema';

export type ThumbMaintenanceKind = 'optimize' | 'clear';

export interface ThumbMaintenanceState {
    status: 'idle' | 'running' | 'completed' | 'failed'
    kind: ThumbMaintenanceKind | null
    startedAt: string | null
    finishedAt: string | null
    removed: number
    error: string | null
}

const IDLE: ThumbMaintenanceState = {
    status: 'idle',
    kind: null,
    startedAt: null,
    finishedAt: null,
    removed: 0,
    error: null,
};

const states = new Map<string, ThumbMaintenanceState>();
const running = new Set<string>();

export function thumbMaintenanceStatus(albumId: string): ThumbMaintenanceState {
    return states.get(albumId) ?? IDLE;
}

/** 当前正在整理/清空缩略图的相册（含 VACUUM，属于集中写入阶段） */
export function activeThumbMaintenance(): Array<{ albumId: string, state: ThumbMaintenanceState }> {
    return [...running]
        .map(albumId => ({ albumId, state: thumbMaintenanceStatus(albumId) }))
        .filter(item => item.state.status === 'running');
}

/**
 * 手动整理/清空缩略图会做 LRU 淘汰与 VACUUM，属于重活：
 * 立即返回 running，后台任务持租约执行，前端轮询缩略图统计里的 maintenance 状态。
 */
export function startThumbMaintenance(
    settings: Settings,
    context: AlbumContext,
    kind: ThumbMaintenanceKind,
): ThumbMaintenanceState {
    const albumId = context.index.id;

    if (running.has(albumId)) {
        return thumbMaintenanceStatus(albumId);
    }

    const startedAt = new Date().toISOString();

    running.add(albumId);
    states.set(albumId, {
        status: 'running',
        kind,
        startedAt,
        finishedAt: null,
        removed: 0,
        error: null,
    });

    const finish = (next: Omit<ThumbMaintenanceState, 'kind' | 'startedAt' | 'finishedAt'>): void => {
        states.set(albumId, {
            ...next,
            kind,
            startedAt,
            finishedAt: new Date().toISOString(),
        });
        running.delete(albumId);
    };

    void new Promise<void>(resolve => setImmediate(resolve))
        .then(() => {
            const lease = leaseAlbumDatabase(context.dir);

            try {
                const store = createThumbStore(context.db.thumbnails, settings.thumbnails.dbMaxSizeMb, context.index.id);
                const removed = kind === 'optimize'
                    ? store.optimize().removed
                    : store.clear().removed;

                finish({ status: 'completed', removed, error: null });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);

                logger.warn({ err: error, albumId, kind }, 'thumbnail maintenance failed');
                finish({ status: 'failed', removed: 0, error: message });
            }
            finally {
                lease.release();
            }
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);

            logger.warn({ err: error, albumId, kind }, 'thumbnail maintenance could not start');
            finish({ status: 'failed', removed: 0, error: message });
        });

    return thumbMaintenanceStatus(albumId);
}

/** 仅供测试：清空内存中的任务状态 */
export function resetThumbMaintenanceForTests(): void {
    states.clear();
    running.clear();
}
