import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * RFC 9457 Problem Details。
 * 所有错误响应统一由 app.onError / app.notFound 构造，handler 禁止手写错误体。
 * `code` 是稳定错误码（前端按 errors.<code> 翻译），`detail` 是英文开发者信息。
 */
export interface ProblemDetails {
    type: string
    title: string
    status: number
    detail?: string
    instance?: string
    code: string
}

const CONTENT_TYPE = 'application/problem+json; charset=UTF-8';

const TITLES: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    416: 'Range Not Satisfiable',
    422: 'Unprocessable Content',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
};

export function buildProblem(
    status: ContentfulStatusCode,
    code: string,
    detail?: string,
    options: { instance?: string } = {},
): ProblemDetails {
    const problem: ProblemDetails = {
        type: 'about:blank',
        title: TITLES[status] ?? 'Error',
        status,
        code,
    };

    if (detail !== undefined) {
        problem.detail = detail;
    }
    if (options.instance !== undefined) {
        problem.instance = options.instance;
    }

    return problem;
}

export function sendProblem(
    c: Context,
    status: ContentfulStatusCode,
    code: string,
    detail?: string,
): Response {
    const problem = buildProblem(status, code, detail, { instance: c.req.path });

    return c.body(JSON.stringify(problem), status, {
        'content-type': CONTENT_TYPE,
    });
}

/** 业务代码抛出的、带语义的错误；由 app.onError 转成 Problem Details */
export class ApiError extends HTTPException {
    constructor(
        status: ContentfulStatusCode,
        public readonly code: string,
        message: string,
    ) {
        super(status, { message });
    }
}
