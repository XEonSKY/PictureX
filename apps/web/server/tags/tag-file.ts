import { colorFromTagName } from '../../shared/tag-color';
import { ApiError } from '../hono/problem';

/**
 * 标签名称/配色/导入合并的纯规则（不读写数据库）。
 * 相册标签与全局标签共用；持久化在 server/tags/tag-store.ts。
 */

export const MAX_TAG_NAME_LENGTH = 120;

export interface TagWriteInput {
    name: string
    color?: string
}

export interface TagPatchInput {
    name?: string
    color?: string
}

export interface TagOperationOptions {
    /** 未提供颜色时按名称生成稳定颜色 */
    autoColor?: boolean
    maxNameLength?: number
}

export function normalizeTagName(name: string, maxLength = MAX_TAG_NAME_LENGTH): string {
    return name.trim().replace(/\s+/gu, ' ').slice(0, maxLength);
}

/** 名称比较键：大小写不敏感，与旧 tag.json 的合并规则一致 */
export function tagNameKey(name: string): string {
    return name.toLocaleLowerCase();
}

export function requireTagName(name: string, options: TagOperationOptions = {}): string {
    const normalized = normalizeTagName(name, options.maxNameLength);

    if (normalized === '') {
        throw new ApiError(422, 'validation_failed', 'Tag name must not be empty.');
    }

    return normalized;
}

export function resolveTagColor(
    name: string,
    color: string | undefined,
    options: TagOperationOptions = {},
): string {
    const provided = color?.trim() ?? '';

    if (provided !== '') {
        return provided;
    }

    return options.autoColor ? colorFromTagName(name) : '';
}

export function tagNameConflict(): ApiError {
    return new ApiError(409, 'tag_name_conflict', 'A tag with this name already exists.');
}

export function tagNotFound(): ApiError {
    return new ApiError(404, 'tag_not_found', 'The requested tag does not exist.');
}
