// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs';

/**
 * 代码风格：
 * 4 空格缩进、分号、单引号；stylistic 规则集由 @nuxt/eslint 的
 * `eslint.config.stylistic`（见 nuxt.config.ts）开启，此处只覆盖具体参数。
 * 禁止用 eslint-disable 绕过 indent 规则。
 */
export default withNuxt(
    {
        rules: {
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
            // 模板缩进同样使用 4 空格
            'vue/html-indent': ['error', 4],
            'vue/max-attributes-per-line': 'off',
        },
    },
);
