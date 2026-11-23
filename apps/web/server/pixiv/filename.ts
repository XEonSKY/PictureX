/**
 * 从文件名识别 Pixiv 作品与分P：127978234_p0.jpg、127978234_p12_master1200.png。
 * 作品 ID 至少 6 位，避免把日期/序号命名的普通照片误判为 Pixiv 图片。
 */
const PIXIV_FILENAME = /^(\d{6,12})_p(\d{1,4})(?:_[^.]+)?\.[a-z0-9]+$/iu;

export interface PixivFileRef {
    illustId: string
    pageIndex: number
}

export function parsePixivFilename(filename: string): PixivFileRef | null {
    const match = PIXIV_FILENAME.exec(filename.trim());

    if (!match?.[1] || match[2] === undefined) {
        return null;
    }

    const pageIndex = Number(match[2]);

    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        return null;
    }

    return { illustId: match[1], pageIndex };
}
