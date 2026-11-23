import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { ApiError } from './problem';

function summarize(error: { issues: { path: PropertyKey[], message: string }[] }): string {
    const detail = error.issues
        .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');

    return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
}

/**
 * Zod 校验失败统一返回 422（400 只用于请求无法解析）。
 * 错误体由 app.onError 构造，这里只负责翻译成 ApiError。
 */
export function validateJson<T extends ZodType>(schema: T) {
    return zValidator('json', schema, (result) => {
        if (!result.success) {
            throw new ApiError(422, 'validation_failed', summarize(result.error));
        }
    });
}

export function validateQuery<T extends ZodType>(schema: T) {
    return zValidator('query', schema, (result) => {
        if (!result.success) {
            throw new ApiError(422, 'validation_failed', summarize(result.error));
        }
    });
}

export function validateParam<T extends ZodType>(schema: T) {
    return zValidator('param', schema, (result) => {
        if (!result.success) {
            throw new ApiError(422, 'validation_failed', summarize(result.error));
        }
    });
}
