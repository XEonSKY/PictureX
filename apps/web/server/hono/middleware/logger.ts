import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../../logger';
import type { AppEnv } from '../env';

/**
 * 自研请求日志中间件（不使用 hono-pino）。
 * 注入请求作用域 logger：c.get('logger')，并回写 x-request-id。
 */
export function requestLogger(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const requestId = c.req.header('x-request-id') ?? randomUUID();
        const log = logger.child({ requestId });

        c.set('logger', log);
        c.set('requestId', requestId);
        c.header('x-request-id', requestId);

        const startedAt = performance.now();

        await next();

        log.info(
            {
                method: c.req.method,
                path: c.req.path,
                status: c.res.status,
                durationMs: Math.round(performance.now() - startedAt),
            },
            'request completed',
        );
    };
}
