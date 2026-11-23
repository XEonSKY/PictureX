const DETAIL_SIZES = [256, 512, 1024, 2048, 4096];

/** 瀑布流/详情瓦片：按物理像素挑档，下一档超过 1.5 倍时退一档 */
export function pickDetailThumbnailSize(cssWidth: number, dpr: number, sizes: number[] = DETAIL_SIZES): number {
    const target = Math.max(1, cssWidth) * Math.max(1, dpr);
    const index = sizes.findIndex(size => size >= target);

    if (index <= 0) {
        return sizes[0] ?? 256;
    }
    if (index === -1) {
        return sizes[sizes.length - 1] ?? 4096;
    }

    const next = sizes[index] ?? 4096;
    const previous = sizes[index - 1] ?? next;

    return next / target <= 1.5 ? next : previous / target >= 0.8 ? previous : next;
}

/**
 * 停留升级档位：取完整覆盖当前物理像素的最小档，不做「退一档」。
 * 首屏用 pickDetailThumbnailSize 快速出图，停留后再按这个档位换成 1:1 清晰图。
 */
export function pickExactThumbnailSize(cssWidth: number, dpr: number, sizes: number[] = DETAIL_SIZES): number {
    const target = Math.max(1, cssWidth) * Math.max(1, dpr);

    return sizes.find(size => size >= target) ?? sizes[sizes.length - 1] ?? 4096;
}

/** 矩阵瓦片只占几十像素：按物理像素挑最小可用档位 */
export function pickGridThumbnailSize(cssWidth: number, dpr: number): 128 | 256 | 512 {
    const physical = Math.max(1, cssWidth) * Math.max(1, dpr);

    if (physical <= 192) {
        return 128;
    }
    if (physical <= 448) {
        return 256;
    }

    return 512;
}
