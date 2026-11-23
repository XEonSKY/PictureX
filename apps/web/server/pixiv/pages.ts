import type { PixivPage, PixivPageUrls } from './types';

/**
 * 分P URL 的紧凑存储：`[[squareMedium, medium, large, original], ...]`，数组下标就是页码。
 * 0.1.0 基线只认这一种格式；读取到其它形状按无分P处理。
 */

type CompactPage = [string, string, string, string];

function urlsFromCompact(value: unknown): PixivPageUrls | null {
    if (!Array.isArray(value) || value.length < 4) {
        return null;
    }

    const [squareMedium, medium, large, original] = value;

    if (typeof squareMedium !== 'string' || typeof medium !== 'string'
      || typeof large !== 'string' || typeof original !== 'string') {
        return null;
    }

    return { squareMedium, medium, large, original };
}

export function packPixivPages(pages: PixivPage[]): string {
    const compact: CompactPage[] = pages.map((page) => {
        const { squareMedium, medium, large, original } = page.urls;

        return [squareMedium, medium, large, original];
    });

    return JSON.stringify(compact);
}

export function parsePixivPages(raw: string | null | undefined, pageCount: number): PixivPage[] {
    if (!raw) {
        return [];
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    const pages: PixivPage[] = [];

    parsed.forEach((item, index) => {
        const urls = urlsFromCompact(item);

        if (urls) {
            pages.push({ index, urls });
        }
    });

    return pages.filter(page => page.index < Math.max(pageCount, pages.length));
}
