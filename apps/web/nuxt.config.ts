import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// https://nuxt.com/docs/api/configuration/nuxt-config
const rootVersion = (JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
) as { version?: string }).version ?? '0.0.0';

export default defineNuxtConfig({

    modules: ['@antdv-next/nuxt', '@nuxt/eslint', '@nuxtjs/i18n'],

    components: [{ path: '~/components', pathPrefix: false }],

    devtools: { enabled: false },

    app: {
        pageTransition: { name: 'page', mode: 'out-in' },
        layoutTransition: { name: 'layout', mode: 'out-in' },
        head: {
            link: [
                { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
                { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
                { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
            ],
        },
    },

    css: [
        'antdv-next/dist/reset.css',
        '~/assets/css/design-tokens.css',
        '~/assets/css/theme.css',
    ],

    runtimeConfig: {
        public: {
            appName: 'PictureX',
            version: rootVersion,
        },
    },

    // 本地优先：显式绑定回环地址。Nuxt 4.6 的 devServer.host 默认值在部分 CLI 版本里
    // 会以未解析对象传给监听器，导致 `hostname.toLowerCase is not a function`。
    devServer: {
        host: '127.0.0.1',
        port: 3000,
    },

    compatibilityDate: '2026-10-18',

    nitro: {
        // Windows + 嵌套 node_modules 下，外部化的包会生成指向嵌套路径的相对 ESM 导入，
        // 产物一旦被复制/安装到其它目录（dist/desktop、Program Files）就会 ERR_MODULE_NOT_FOUND。
        // antdv-next 的嵌套副本 @v-c/trigger、@v-c/resize-observer 必须内联进服务端产物。
        externals: {
            inline: ['@ant-design/colors', '@v-c/trigger', '@v-c/resize-observer'],
        },
        output: {
            dir: process.env.NODE_ENV === 'development' ? '../../.dev/nuxt' : '../../dist/nuxt',
        },
    },

    vite: {
        optimizeDeps: {
            include: ['antdv-next', 'hono/client'],
        },
    },

    typescript: {
        strict: true,
        typeCheck: false,
    },

    antd: {
        icon: true,
    },

    eslint: {
        config: {
            stylistic: true,
        },
    },

    i18n: {
        strategy: 'no_prefix',
        defaultLocale: 'zh-CN',
        // 文案目录在 apps/web/i18n/locales（srcDir 是 app/，因此回退一级）
        langDir: '../i18n/locales',
        locales: [
            { code: 'zh-CN', language: 'zh-CN', name: '简体中文', file: 'zh-CN.json' },
            { code: 'en-US', language: 'en-US', name: 'English', file: 'en-US.json' },
        ],
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'picturex.lang',
            redirectOn: 'root',
            fallbackLocale: 'zh-CN',
        },
    },

});
