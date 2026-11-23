import { getRequestURL, sendRedirect, setCookie, setResponseHeaders } from 'h3';

/**
 * 页面级安全响应头。
 * CSP 允许首屏主题内联脚本与 AntdvNext 的运行时样式注入，但禁止外部脚本、
 * 内嵌对象与外站框架；开发环境额外放开 eval 供 Vite 使用。
 *
 * API 的 SVG 下载还会在 Hono 路由里追加更严格的 sandbox CSP。
 */
const isProduction = process.env.NODE_ENV === 'production';

const CONTENT_SECURITY_POLICY = [
    'default-src \'self\'',
    `script-src 'self' 'unsafe-inline'${isProduction ? '' : ' \'unsafe-eval\''}`,
    'style-src \'self\' \'unsafe-inline\'',
    // pxfile: 是桌面壳查看器的文件协议，Web 端不存在此类地址；放开仅让 <img>/<video> 能加载已登记的文件
    'img-src \'self\' data: blob: pxfile:',
    'media-src \'self\' blob: pxfile:',
    'font-src \'self\' data:',
    // 只用同源 SSE；生产环境收紧到 'self'（ws: 会放行任意主机的 WebSocket），开发环境保留 ws: 供 Vite/Nuxt HMR
    `connect-src 'self'${isProduction ? '' : ' ws:'}`,
    'object-src \'none\'',
    'base-uri \'self\'',
    'frame-ancestors \'none\'',
    'form-action \'self\'',
].join('; ');

export default defineEventHandler((event) => {
    // 首次带 ?token= 进入页面：服务端直接落 HttpOnly cookie 并 302 去掉查询参数，
    // 避免令牌留在地址栏、历史记录与 Referer 里（API 请求仍由 Hono 自行处理）
    if (event.method === 'GET') {
        const url = getRequestURL(event);
        const token = url.searchParams.get('token');

        if (token && !url.pathname.startsWith('/api/')) {
            setCookie(event, 'picturex.token', token, {
                httpOnly: true,
                sameSite: 'lax',
                path: '/',
                maxAge: 31_536_000,
            });
            url.searchParams.delete('token');

            return sendRedirect(event, `${url.pathname}${url.search}`, 302);
        }
    }

    setResponseHeaders(event, {
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
});
