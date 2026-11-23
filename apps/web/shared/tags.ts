/** 标签页（相册标签 / 全局标签）共用的前端 DTO 与导入文件解析。 */

export type TagRowSource = 'manual' | 'pixiv';

export interface TagRow {
    id: string
    name: string
    color: string
    createdAt?: string
    source?: TagRowSource
    count: number
}

export interface TagImportItem {
    name: string
    color?: string
}

export const MAX_TAG_NAME_LENGTH = 120;

/** 支持导出文件 `{ tags: [...] }` 或裸数组；无有效标签返回 null */
export function parseTagImport(raw: unknown): TagImportItem[] | null {
    const list = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object' && Array.isArray((raw as { tags?: unknown }).tags)
            ? (raw as { tags: unknown[] }).tags
            : null;

    if (!list) {
        return null;
    }

    return list.flatMap((item) => {
        if (!item || typeof item !== 'object') {
            return [];
        }

        const record = item as { name?: unknown, color?: unknown };
        const name = typeof record.name === 'string' ? record.name.trim() : '';

        if (name === '') {
            return [];
        }

        return [{
            name,
            color: typeof record.color === 'string' ? record.color : undefined,
        }];
    });
}
