// @ts-check
import stylistic from '@stylistic/eslint-plugin';

/**
 * 根目录只覆盖脚本与 CLI 源码（apps/* 各自有独立配置）。
 * 4 空格缩进、分号、单引号，与 apps/desktop 保持一致。
 */
export default [
    {
        ignores: [
            '**/node_modules/**',
            'dist/**',
            '.dev/**',
            '.pnpm-store/**',
            'apps/**',
            'docs/**',
        ],
    },
    {
        files: ['scripts/**/*.{js,mjs}', 'packages/cli/**/*.{js,mjs}'],
        plugins: { '@stylistic': stylistic },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                Buffer: 'readonly',
                process: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                structuredClone: 'readonly',
            },
        },
        rules: {
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
        },
    },
];
