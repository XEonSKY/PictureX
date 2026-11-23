import { activeThumbMaintenance } from '../album/thumb-maintenance';
import { activeThumbnailWarmups } from '../album/thumb-warmup';
import { thumbnailServiceStats } from '../album/thumb-service';
import { listAlbumSummaries } from '../album/album-store';
import { getPixivAutoFetchStatus } from '../pixiv/auto-fetch';
import { buildingSimilarityAlbums } from '../ingest/similarity-index';
import { getSettings } from '../settings/setting-store';
import { listJobViews } from './job-query';

/**
 * 应用内的磁盘活动视图。
 *
 * 只回答「现在哪些功能正在读写磁盘、大概到哪了」：全部状态来自内存或任务库，
 * 不打开相册 SQLite、不采集操作系统字节数（Windows 下逐进程 IO 需要额外权限且开销大）。
 * 因此这里的数字是进度而不是吞吐量，够用来判断「该不该等它跑完」「谁在抢磁盘」。
 */

export type DiskActivityKind = 'import' | 'ai' | 'thumbnail' | 'warmup' | 'similarity'
  | 'maintenance' | 'pixiv' | 'model';

export type DiskActivityTouch = 'reading' | 'writing' | 'reading-writing';

export interface DiskActivityItem {
    id: string
    kind: DiskActivityKind
    /** 该活动对磁盘做了什么：读原图、写库/写文件，或两者都有 */
    touch: DiskActivityTouch
    albumId: string | null
    albumName: string | null
    /** 进度；无法量化时为 null */
    done: number | null
    total: number | null
    /** 排队中、还没开始读写的项目数 */
    queued: number
    paused: boolean
}

export interface DiskActivityDto {
    updatedAt: string
    /** 交互/后台缩略图队列的实时形态（动态并发按最近生成耗时调整） */
    thumbnails: {
        interactiveActive: number
        interactivePending: number
        backgroundActive: number
        backgroundPending: number
        interactiveConcurrency: number
        ewmaMs: number
    }
    items: DiskActivityItem[]
}

const ACTIVE_IMPORT_STATES = new Set(['running', 'paused']);
const ACTIVE_DOWNLOAD_STATES = new Set(['queued', 'downloading', 'paused']);

export function collectDiskActivity(): DiskActivityDto {
    const settings = getSettings();
    const names = new Map(listAlbumSummaries(settings).map(album => [album.id, album.name]));
    const nameFor = (albumId: string | null): string | null =>
        (albumId === null ? null : names.get(albumId) ?? albumId);

    const items: DiskActivityItem[] = [];

    for (const view of listJobViews()) {
        if (view.type === 'import' && ACTIVE_IMPORT_STATES.has(view.status)) {
            items.push({
                id: `import:${view.id}`,
                kind: 'import',
                touch: 'reading-writing',
                albumId: view.albumId,
                albumName: nameFor(view.albumId),
                done: view.processed,
                total: view.total,
                queued: 0,
                paused: view.status === 'paused',
            });
        }
        else if (view.type === 'ai' && ACTIVE_IMPORT_STATES.has(view.status)) {
            items.push({
                id: `ai:${view.id}`,
                kind: 'ai',
                touch: 'reading',
                albumId: view.albumId,
                albumName: nameFor(view.albumId),
                done: view.processed,
                total: view.total,
                queued: 0,
                paused: view.status === 'paused',
            });
        }
        else if (view.type === 'download' && ACTIVE_DOWNLOAD_STATES.has(view.status)) {
            items.push({
                id: `model:${view.modelId}`,
                kind: 'model',
                touch: 'writing',
                albumId: null,
                albumName: view.name,
                done: view.bytesDone,
                total: view.totalBytes > 0 ? view.totalBytes : null,
                queued: view.status === 'queued' ? 1 : 0,
                paused: view.status === 'paused',
            });
        }
    }

    const stats = thumbnailServiceStats();
    const generating = stats.interactiveActive + stats.backgroundActive;
    const pending = stats.interactivePending + stats.backgroundPending;

    if (generating + pending > 0) {
        items.push({
            id: 'thumbnail:queue',
            kind: 'thumbnail',
            touch: 'reading-writing',
            albumId: null,
            albumName: null,
            done: generating,
            total: generating + pending,
            queued: pending,
            paused: false,
        });
    }

    for (const { albumId, state } of activeThumbnailWarmups()) {
        items.push({
            id: `warmup:${albumId}`,
            kind: 'warmup',
            touch: 'reading-writing',
            albumId,
            albumName: nameFor(albumId),
            done: state.processed,
            total: state.total,
            queued: 0,
            paused: state.status === 'paused',
        });
    }

    for (const albumId of buildingSimilarityAlbums()) {
        items.push({
            id: `similarity:${albumId}`,
            kind: 'similarity',
            touch: 'reading-writing',
            albumId,
            albumName: nameFor(albumId),
            done: null,
            total: null,
            queued: 0,
            paused: false,
        });
    }

    for (const { albumId, state } of activeThumbMaintenance()) {
        items.push({
            id: `maintenance:${albumId}:${state.kind ?? 'optimize'}`,
            kind: 'maintenance',
            touch: 'writing',
            albumId,
            albumName: nameFor(albumId),
            done: null,
            total: null,
            queued: 0,
            paused: false,
        });
    }

    const autoFetch = getPixivAutoFetchStatus();

    for (const album of autoFetch.albums) {
        if (album.status !== 'running') {
            continue;
        }

        items.push({
            id: `pixiv:${album.albumId}`,
            kind: 'pixiv',
            touch: 'writing',
            albumId: album.albumId,
            albumName: album.albumName || nameFor(album.albumId),
            done: album.processed,
            total: album.total,
            queued: 0,
            paused: false,
        });
    }

    if (autoFetch.queued.length > 0) {
        items.push({
            id: 'pixiv:queued',
            kind: 'pixiv',
            touch: 'writing',
            albumId: null,
            albumName: null,
            done: 0,
            total: autoFetch.queued.length,
            queued: autoFetch.queued.length,
            paused: autoFetch.paused,
        });
    }

    items.sort((left, right) => Number(left.paused) - Number(right.paused)
      || (right.done ?? 0) - (left.done ?? 0));

    return {
        updatedAt: new Date().toISOString(),
        thumbnails: {
            interactiveActive: stats.interactiveActive,
            interactivePending: stats.interactivePending,
            backgroundActive: stats.backgroundActive,
            backgroundPending: stats.backgroundPending,
            interactiveConcurrency: stats.interactiveConcurrency,
            ewmaMs: Math.round(stats.ewmaMs),
        },
        items,
    };
}
