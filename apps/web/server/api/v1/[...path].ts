import { toWebRequest } from 'h3';
import app, { API_BASE_PATH } from '~~/server/hono/app';

/**
 * Hono 挂载点（Nitro catch-all）。
 * 不使用 @hono/node-server：把 Web Request 交给 Hono 的 fetch。
 * 这里剥掉 /api/v1 前缀，使 AppType 里的路由不含前缀，
 * 与前端 hc<AppType>('/api/v1') 严格对应。
 */
export default defineEventHandler((event) => {
    const request = toWebRequest(event);
    const url = new URL(request.url);
    // 连接地址由运行时提供；标准转发头仍由 clientIp() 按需读取
    const env = { clientIp: event.node.req.socket.remoteAddress };

    if (!url.pathname.startsWith(API_BASE_PATH)) {
        return app.fetch(request, env);
    }

    const rest = url.pathname.slice(API_BASE_PATH.length) || '/';
    const target = new URL(`${rest}${url.search}`, url.origin);

    // new Request(url, originalRequest) 会保留 method / headers / body
    return app.fetch(new Request(target, request), env);
});
