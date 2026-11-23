<script setup lang="ts">
import { theme as antdTheme, type ThemeConfig } from 'antdv-next';
import enUS from 'antdv-next/locale/en_US';
import zhCN from 'antdv-next/locale/zh_CN';
import { tokenPx } from '#shared/theme';

const { locale } = useI18n();
const { resolvedTokens, preset } = useTheme();

function antdLocaleFor(code: string) {
    return code === 'en-US' ? enUS : zhCN;
}

const antdLocale = computed(() => antdLocaleFor(locale.value));

// 同一相册内切图复用详情组件，避免每次路由变化都重挂载并清空本地相邻队列
function pageKey(route: { path: string }): string {
    const match = route.path.match(/^\/albums\/([^/]+)\/assets\/[^/]+$/u);

    return match?.[1] ? `/albums/${match[1]}/assets/:assetId` : route.path;
}

const themeConfig = computed<ThemeConfig>(() => {
    const tokens = resolvedTokens.value;

    return {
        algorithm: preset.value === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
            colorPrimary: tokens['color-brand'],
            colorInfo: tokens['color-info'],
            colorSuccess: tokens['color-success'],
            colorWarning: tokens['color-warning'],
            colorError: tokens['color-danger'],
            colorLink: tokens['color-brand'],
            colorText: tokens['color-text-primary'],
            colorTextSecondary: tokens['color-text-secondary'],
            colorTextTertiary: tokens['color-text-tertiary'],
            colorBgLayout: tokens['color-bg-page'],
            colorBgContainer: tokens['color-bg-surface'],
            colorBgElevated: tokens['color-bg-elevated'],
            colorBorder: tokens['color-border-strong'],
            colorBorderSecondary: tokens['color-border'],
            colorBgMask: tokens['color-mask'],
            fontFamily: tokens['font-family-base'],
            fontSize: tokenPx(tokens, 'font-size-body', 14),
            borderRadius: tokenPx(tokens, 'radius-sm', 8),
            borderRadiusLG: tokenPx(tokens, 'radius-md', 16),
            borderRadiusSM: tokenPx(tokens, 'radius-sm', 8),
            controlHeight: tokenPx(tokens, 'control-height', 40),
            controlHeightSM: tokenPx(tokens, 'control-height-sm', 28),
            controlHeightLG: tokenPx(tokens, 'control-height-lg', 48),
        },
        components: {
            Button: {
                borderRadiusSM: tokenPx(tokens, 'radius-button-sm', 14),
                fontWeight: tokenPx(tokens, 'font-weight-medium', 500),
            },
        },
    };
});

useHead({
    title: 'PictureX',
    htmlAttrs: {
        lang: computed(() => locale.value),
    },
});
</script>

<template>
    <a-config-provider :theme="themeConfig" :locale="antdLocale">
        <NuxtLoadingIndicator :color="resolvedTokens['color-brand']" :height="2" :duration="2000" :throttle="400" />
        <NuxtLayout>
            <NuxtPage :page-key="pageKey" />
        </NuxtLayout>
    </a-config-provider>
</template>
