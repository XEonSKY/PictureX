import { hc } from 'hono/client';
import type { AppType } from '~~/server/hono/app';

/** 前端统一 API 错误：message 已按 errors.<code> 翻译 */
export class ApiClientError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ApiClientError';
    }
}

function readProblem(raw: unknown): { code: string, detail: string, message: string } | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : '';
    const detail = typeof record.detail === 'string' ? record.detail : '';
    const message = typeof record.message === 'string' ? record.message : '';

    if (!code && !detail && !message) {
        return null;
    }

    return { code, detail, message };
}

type ApiClient = ReturnType<typeof hc<AppType>>;

/**
 * 客户端按 (baseURL, locale) 复用同一个 hc 实例：大多数页面在 setup 里调用
 * `useApi()`，同一个相册页会同时挂载多个组件，没必要为每个组件重新建客户端。
 * SSR 不缓存：每个请求的 origin（`useRequestURL()`）与 locale 都可能不同。
 * `t` / `te` 绑定在 vue-i18n composer 上，语言切换后仍返回新语言文案。
 */
const clientCache = new Map<string, ApiClient>();

/**
 * 类型安全的 API 客户端。
 * 类型链：手写 Zod schema → validateJson → c.json() → AppType → hc<AppType>
 *
 * 错误拦截通过 hc 的 `fetch` 选项集中完成：
 * application/problem+json → errors.<code> → detail → message。
 */
export function useApi(): ApiClient {
    // 服务端渲染时 fetch 需要绝对地址，客户端用相对地址
    const baseURL = import.meta.server
        ? `${useRequestURL().origin}/api/v1`
        : '/api/v1';

    const { t, te, locale } = useI18n();
    const cacheKey = `${baseURL}|${locale.value}`;
    const cached = import.meta.client ? clientCache.get(cacheKey) : undefined;

    if (cached) {
        return cached;
    }

    function translate(status: number, problem: { code: string, detail: string, message: string } | null): ApiClientError {
        const code = problem?.code || 'http_error';
        const key = `errors.${code}`;

        if (problem && te(key)) {
            return new ApiClientError(status, code, t(key));
        }

        if (import.meta.dev && problem?.code) {
            console.warn(`[i18n] missing translation for error code "${code}" (${key})`);
        }

        // 缺失翻译时回退 detail → message（RFC 9457 的两个开发者字段）
        return new ApiClientError(
            status,
            code,
            problem?.detail || problem?.message || t('errors.http_error'),
        );
    }

    const client = hc<AppType>(baseURL, {
        init: {
            credentials: 'include',
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await globalThis.fetch(input, init);

            if (response.ok) {
                return response;
            }

            const contentType = response.headers.get('content-type') ?? '';
            let problem: { code: string, detail: string, message: string } | null = null;

            if (contentType.includes('application/problem+json')) {
                try {
                    problem = readProblem(await response.clone().json());
                }
                catch {
                    problem = null;
                }
            }

            throw translate(response.status, problem);
        },
    });

    if (import.meta.client) {
        clientCache.set(cacheKey, client);
    }

    return client;
}
