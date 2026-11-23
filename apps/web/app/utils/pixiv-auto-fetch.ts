import type { PixivAutoFetchAlbumStatusDto, PixivAutoFetchStatusDto } from '~~/shared/pixiv';

/** Pixiv 后台补全状态在「Pixiv 资料库」与「设置 → Pixiv」两处的公共推导。 */

export function activeAutoFetch(status: PixivAutoFetchStatusDto | null): PixivAutoFetchAlbumStatusDto | null {
    const albums = status?.albums ?? [];

    return albums.find(item => item.status === 'running')
      ?? albums.find(item => item.status === 'queued')
      ?? albums[0]
      ?? null;
}

export function autoFetchPercent(item: PixivAutoFetchAlbumStatusDto | null): number {
    if (!item || item.total <= 0) {
        return 0;
    }

    return Math.min(100, Math.round((item.processed / item.total) * 100));
}

export function autoFetchTagColor(
    item: PixivAutoFetchAlbumStatusDto | null,
): 'processing' | 'warning' | 'success' | 'error' | 'default' {
    switch (item?.status) {
        case 'running':
            return 'processing';
        case 'paused':
            return 'warning';
        case 'completed':
            return 'success';
        case 'failed':
            return 'error';
        case 'skipped':
            return 'warning';
        default:
            return 'default';
    }
}

const STATE_KEYS: Record<PixivAutoFetchAlbumStatusDto['status'], string> = {
    queued: 'settings.pixivAutoFetchStateQueued',
    running: 'settings.pixivAutoFetchStateRunning',
    paused: 'settings.pixivAutoFetchStatePaused',
    completed: 'settings.pixivAutoFetchStateCompleted',
    failed: 'settings.pixivAutoFetchStateFailed',
    skipped: 'settings.pixivAutoFetchStateSkipped',
};

/** 返回 i18n key；没有任务时返回调用方给的 idle key。 */
export function autoFetchStateKey(
    status: PixivAutoFetchStatusDto | null,
    item: PixivAutoFetchAlbumStatusDto | null,
    idleKey: string,
): string {
    if (status?.paused && item?.status !== 'running') {
        return 'settings.pixivAutoFetchStateUserPaused';
    }

    return item ? STATE_KEYS[item.status] ?? item.status : idleKey;
}
