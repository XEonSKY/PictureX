import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../logger';
import type { Context } from 'hono';
import type { AppEnv } from './env';
import { requestLogger } from './middleware/logger';
import { albumRequestScope } from './middleware/album-scope';
import { ApiError, sendProblem } from './problem';
import { albumRoutes } from './routes/albums';
import { fsRoutes } from './routes/fs';
import { jobRoutes } from './routes/jobs';
import { modelRoutes } from './routes/models';
import { pixivRoutes } from './routes/pixiv';
import { settingsRoutes } from './routes/settings';
import { viewerRoutes } from './routes/viewer';

/**
 * 业务 API 前缀。
 * 运行时路径带前缀（由 Nitro catch-all 剥掉），RPC 类型里的路由不带前缀，
 * 因此前端用 hc<AppType>('/api/v1') 与之一一对应。
 */
export const API_BASE_PATH = '/api/v1';

const startedAt = new Date().toISOString();

// 所有合法请求体都被 zod 限制在 ≤500 个条目（远小于 2 MiB）；
// 声明的 content-length 超过它即拒绝，挡住 `Content-Length: 2GB` 式 OOM。
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::']);

// 每个 API 请求都会校验 Host；环境变量在进程生命周期内不变，解析一次即可
const ALLOWED_HOSTS = (process.env.PX_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

// 服务实际绑定地址由启动环境决定；回环值统一按 loopback 处理。
const BIND_HOST = (process.env.NITRO_HOST ?? process.env.HOST ?? process.env.NUXT_HOST ?? '127.0.0.1')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
const BIND_IS_WILDCARD = WILDCARD_BIND_HOSTS.has(BIND_HOST);

/**
 * 只接受回环、实际绑定地址或显式放行的 Host。
 * 默认监听 127.0.0.1；局域网访问用 --host 0.0.0.0（此时客户端按 LAN IP 连入，
 * IP 字面量 Host 合法）。绑定在单一地址时，其它 IP 字面量一律拒绝，堵住
 * 本机进程伪造 Host 头绕过同源校验的口子；DNS rebinding 由非 IP 的任意域名拦住。
 */
function isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) {
        return false;
    }

    let hostname = hostHeader.trim().toLowerCase();

    if (hostname.startsWith('[')) {
        const end = hostname.indexOf(']');

        hostname = end > 0 ? hostname.slice(1, end) : hostname;
    }
    else {
        hostname = hostname.replace(/:\d+$/u, '');
    }

    if (LOOPBACK_HOSTNAMES.has(hostname)) {
        return true;
    }

    if (isIP(hostname) !== 0) {
        // 绑定到所有接口时任意 IP 都可能是本机某张网卡的地址；
        // 绑定到单一地址时只接受该地址（回环绑定即拒绝任意外部 IP）。
        // 用 net.isIP 而非松散正则，避免 `beef`/`cafe` 这类纯十六进制单标签域名被误判为 IP。
        return BIND_IS_WILDCARD || hostname === BIND_HOST;
    }

    return ALLOWED_HOSTS.includes(hostname);
}

function originHost(origin: string): string {
    try {
        return new URL(origin).host.toLowerCase();
    }
    catch {
        return '';
    }
}

const AUTH_TOKEN = process.env.PX_AUTH_TOKEN?.trim() ?? '';
const AUTH_COOKIE = 'picturex.token';

function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');

    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** 令牌来源：Bearer / x-picturex-token / cookie / ?token=（用于首次在浏览器落地 cookie） */
function presentedToken(c: Context<AppEnv>): string | null {
    const authorization = c.req.header('authorization') ?? '';

    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim() || null;
    }

    const header = c.req.header('x-picturex-token')?.trim();

    if (header) {
        return header;
    }

    const query = c.req.query('token')?.trim();

    if (query) {
        return query;
    }

    const cookie = c.req.header('cookie') ?? '';
    const match = new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`, 'u').exec(cookie);

    if (!match?.[1]) {
        return null;
    }

    // 畸形 % 序列会让 decodeURIComponent 抛 URIError，令牌来源解析不能因此 500
    try {
        return decodeURIComponent(match[1]);
    }
    catch {
        return null;
    }
}

interface HealthPayload {
    status: 'ok'
    startedAt: string
    uptimeSeconds: number
    memory: {
        rssBytes: number
        heapUsedBytes: number
    }
}

/**
 * 根 Hono 实例。
 * 所有路由必须链式声明（.get().post()），否则 RPC 类型推断失效。
 * 挂载点：server/api/v1/[...path].ts → return app.fetch(...)
 */
const app = new Hono<AppEnv>()
    .use('*', requestLogger())
    .use('*', async (c, next) => {
        // 先创建响应对象，后续 c.header 会写进它的 headers；
        // handler 直接返回裸 Response 时，Hono 的 res setter 才会合并这些头
        // （否则 ?token= 的 Set-Cookie 和 x-request-id 会在媒体路由丢失）。
        void c.res;
        c.header('x-content-type-options', 'nosniff');
        c.header('referrer-policy', 'no-referrer');

        await next();
    })
    // 请求体上限：仅读声明头、不触碰 body，超限直接 413（放在鉴权前，尽早拒绝）
    .use('*', async (c, next) => {
        const declared = Number(c.req.header('content-length') ?? '');

        if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
            return sendProblem(c, 413, 'payload_too_large', 'The request body exceeds 2 MiB.');
        }

        await next();
    })
    // 可选访问令牌：设置 PX_AUTH_TOKEN 后，除健康探针外所有 API 都要带令牌
    .use('*', async (c, next) => {
        if (AUTH_TOKEN === '' || c.req.path === '/health') {
            await next();

            return;
        }

        const presented = presentedToken(c);

        if (!presented || !safeEqual(presented, AUTH_TOKEN)) {
            return sendProblem(c, 401, 'auth_required', 'A valid access token is required.');
        }

        if (c.req.query('token')) {
            c.header(
                'set-cookie',
                `${AUTH_COOKIE}=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            );
        }

        await next();
    })
    // 同源校验：阻止跨站页面调用删除/清理等破坏性接口，并挡住 DNS rebinding
    .use('*', async (c, next) => {
        const host = c.req.header('host');

        if (host !== undefined && !isAllowedHost(host)) {
            return sendProblem(c, 403, 'host_not_allowed', 'The request host is not allowed.');
        }
        if (c.req.header('sec-fetch-site') === 'cross-site') {
            return sendProblem(c, 403, 'origin_not_allowed', 'Cross-site requests are not allowed.');
        }

        const origin = c.req.header('origin');

        if (origin !== undefined) {
            const originValue = originHost(origin);

            // 浏览器同源请求一定带 Host；缺失 Host 时不能放行带 Origin 的请求
            if (host === undefined || originValue === '' || originValue !== host.toLowerCase()) {
                return sendProblem(c, 403, 'origin_not_allowed', 'Cross-site requests are not allowed.');
            }
        }

        await next();
    })
    // @public —— 存活探针
    .get('/health', (c) => {
        const memory = process.memoryUsage();
        const payload: HealthPayload = {
            status: 'ok',
            startedAt,
            uptimeSeconds: Math.round(process.uptime()),
            memory: {
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
            },
        };

        return c.json(payload);
    })
    // 相册请求级引用：必须在相册路由之前注册，才能包住后续处理
    .use('/albums/:albumId', albumRequestScope())
    .use('/albums/:albumId/*', albumRequestScope())
    .route('/albums', albumRoutes)
    .route('/fs', fsRoutes)
    .route('/models', modelRoutes)
    .route('/jobs', jobRoutes)
    .route('/settings', settingsRoutes)
    .route('/pixiv', pixivRoutes)
    .route('/viewer', viewerRoutes);

app.notFound((c) => {
    c.get('logger').warn({ path: c.req.path }, 'route not found');

    return sendProblem(c, 404, 'route_not_found', 'The requested resource does not exist.');
});

// Hono 4 的 onError 签名是 (err, c)
app.onError((err, c) => {
    const log = c.get('logger') ?? logger;

    if (err instanceof ApiError) {
        log.warn({ err, code: err.code }, 'api error');

        return sendProblem(c, err.status, err.code, err.message);
    }

    if (err instanceof HTTPException) {
        log.warn({ err }, 'http exception');

        return sendProblem(c, err.status, 'http_error', err.message);
    }

    log.error({ err }, 'unhandled error');

    return sendProblem(c, 500, 'internal_error', 'Unexpected internal error.');
});

export type AppType = typeof app;

export default app;
