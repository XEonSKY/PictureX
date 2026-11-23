import type { AssetSummaryDto } from '~~/server/domain/asset-query';

/** `GET /albums/:albumId/groups/similar` 返回的分组结构，相册相似页与查看器共用。 */

export interface SimilarAssetDto extends AssetSummaryDto {
    distance: number
    score: number
}

export interface SimilarGroupDto {
    id: string
    representativeId: string
    maxDistance: number
    assets: SimilarAssetDto[]
}
