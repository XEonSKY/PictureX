import { sql } from 'drizzle-orm';
import { assets } from '../database/schemas/album';
import { parsePixivFilename } from './filename';

/**
 * Pixiv 作品已带有作者维护的标签，不应再进入 AI 打标。
 * SQL 过滤覆盖新导入的 meta.pixiv 与已建立的分P映射；JS 侧再按文件名兜底旧资产。
 */
export const NOT_PIXIV_ASSET = sql`
    ${assets.pixivIllustId} IS NULL
    AND NOT EXISTS (
        SELECT 1 FROM pixiv_asset_links WHERE pixiv_asset_links.asset_id = ${assets.id}
    )
`;

export interface PixivAssetProbe {
    filename: string
    meta?: string
}

export function isPixivAssetRow(row: PixivAssetProbe): boolean {
    if (parsePixivFilename(row.filename)) {
        return true;
    }

    if (!row.meta) {
        return false;
    }

    try {
        const meta = JSON.parse(row.meta) as { pixiv?: { illustId?: unknown } } | null;

        return typeof meta?.pixiv?.illustId === 'string' || typeof meta?.pixiv?.illustId === 'number';
    }
    catch {
        return false;
    }
}
