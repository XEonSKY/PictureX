import type { AssetSummaryDto } from '~~/server/domain/asset-query';

/**
 * 相册照片页的现场快照：从查看器返回时恢复已加载的列表与瀑布流滚动位置。
 * Map 必须放在模块作用域（不能写进 <script setup>，那里每个组件实例都会重新执行）。
 */

export interface AlbumListSnapshot {
    signature: string
    items: AssetSummaryDto[]
    nextCursor: string | null
    hasMore: boolean
    scrollTop: number
}

const MAX_SNAPSHOTS = 2;
const snapshots = new Map<string, AlbumListSnapshot>();

export function useAlbumListSnapshot() {
    function get(albumId: string): AlbumListSnapshot | undefined {
        return snapshots.get(albumId);
    }

    function set(albumId: string, snapshot: AlbumListSnapshot): void {
        snapshots.delete(albumId);
        snapshots.set(albumId, snapshot);

        while (snapshots.size > MAX_SNAPSHOTS) {
            const oldest = snapshots.keys().next().value;

            if (!oldest) {
                break;
            }

            snapshots.delete(oldest);
        }
    }

    function remove(albumId: string): void {
        snapshots.delete(albumId);
    }

    return { get, set, remove };
}
