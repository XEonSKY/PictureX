import type { AssetSummaryDto } from '~~/server/domain/asset-query';

/**
 * 查看器等页面修改资产后，把变更排队给被 KeepAlive 缓存的相册照片页。
 * 照片页重新激活时原地应用补丁/删除，避免为了同步一张图而重置列表与滚动位置。
 */

type AlbumListMutation
    = | { albumId: string, type: 'remove', assetId: string }
      | { albumId: string, type: 'patch', assetId: string, asset: AssetSummaryDto };

export function useAlbumListSync() {
    const queue = useState<AlbumListMutation[]>('album-list-mutations', () => []);

    function push(mutation: AlbumListMutation): void {
        // 同一资产只保留最后一次变更：先收藏后删除不会被旧补丁覆盖
        queue.value = [
            ...queue.value.filter(item => !(item.albumId === mutation.albumId && item.assetId === mutation.assetId)),
            mutation,
        ];
    }

    function removeAsset(albumId: string, assetId: string): void {
        push({ albumId, type: 'remove', assetId });
    }

    function patchAsset(albumId: string, asset: AssetSummaryDto): void {
        push({ albumId, type: 'patch', assetId: asset.id, asset });
    }

    function consume(albumId: string): {
        removals: Set<string>
        patches: Map<string, AssetSummaryDto>
    } {
        const mine = queue.value.filter(item => item.albumId === albumId);

        if (mine.length === 0) {
            return { removals: new Set(), patches: new Map() };
        }

        queue.value = queue.value.filter(item => item.albumId !== albumId);

        const removals = new Set<string>();
        const patches = new Map<string, AssetSummaryDto>();

        for (const mutation of mine) {
            if (mutation.type === 'remove') {
                removals.add(mutation.assetId);
                patches.delete(mutation.assetId);
            }
            else {
                patches.set(mutation.assetId, mutation.asset);
            }
        }

        return { removals, patches };
    }

    return { removeAsset, patchAsset, consume };
}
