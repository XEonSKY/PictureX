import { defineConfig } from 'vitepress';

/**
 * PictureX 文档站配置。
 * 页面内容全部位于 docs/guide 与 docs/api；这里只维护导航与侧栏结构。
 */
export default defineConfig({
    lang: 'zh-CN',
    title: 'PictureX',
    description: '本地优先、支持 i18n 与运行时换肤的 AI 相册',
    cleanUrls: true,
    // .git 历史不在重建范围内，关闭 git 时间戳避免构建依赖仓库状态
    lastUpdated: false,
    head: [
        ['link', { rel: 'icon', href: '/logo.svg' }],
    ],
    themeConfig: {
        logo: '/logo.svg',
        nav: [
            { text: '指南', link: '/guide/quickstart', activeMatch: '/guide/' },
            { text: 'API', link: '/api/albums', activeMatch: '/api/' },
            { text: '相册格式', link: '/guide/album-format' },
        ],
        sidebar: {
            '/guide/': [
                {
                    text: '开始',
                    items: [
                        { text: '快速开始', link: '/guide/quickstart' },
                        { text: '开发', link: '/guide/development' },
                        { text: '桌面端', link: '/guide/desktop' },
                        { text: '数据目录', link: '/guide/data-dir' },
                    ],
                },
                {
                    text: '核心概念',
                    items: [
                        { text: '相册格式', link: '/guide/album-format' },
                        { text: '去重与相似', link: '/guide/dedup-similarity' },
                        { text: '存储后端', link: '/guide/storage-backends' },
                        { text: '导航与布局', link: '/guide/navigation' },
                        { text: '国际化', link: '/guide/i18n' },
                        { text: '设计技能', link: '/guide/design-skills' },
                    ],
                },
                {
                    text: '功能',
                    items: [
                        { text: 'AI 打标', link: '/guide/ai-tagging' },
                        { text: '模型管理', link: '/guide/model-management' },
                        { text: 'Pixiv', link: '/guide/pixiv' },
                        { text: '入库基准', link: '/guide/benchmark' },
                    ],
                },
            ],
            '/api/': [
                {
                    text: 'HTTP API',
                    items: [
                        { text: '相册', link: '/api/albums' },
                        { text: '资产', link: '/api/assets' },
                        { text: '导入', link: '/api/imports' },
                        { text: '任务与 SSE', link: '/api/jobs' },
                        { text: '标签', link: '/api/tags' },
                        { text: '分组', link: '/api/groups' },
                        { text: 'AI', link: '/api/ai' },
                        { text: '模型', link: '/api/models' },
                        { text: 'Pixiv', link: '/api/pixiv' },
                        { text: '设置', link: '/api/settings' },
                        { text: '文件系统', link: '/api/fs' },
                        { text: '查看器', link: '/api/viewer' },
                    ],
                },
            ],
        },
        search: { provider: 'local' },
        outline: { level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        returnToTopLabel: '回到顶部',
        sidebarMenuLabel: '目录',
        darkModeSwitchLabel: '主题',
    },
});
