// @ts-check
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['node_modules/**', 'out/**', 'runtime/**', 'dist/**'],
    },
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,mjs}'],
        plugins: { '@stylistic': stylistic },
        rules: {
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                Buffer: 'readonly',
                process: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
            },
        },
    },
);
