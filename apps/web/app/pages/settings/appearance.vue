<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();

const title = computed(() => t('settings.moduleAppearance'));

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('theme.subtitle')">
        <ThemeStudio />
    </SettingsModule>
</template>
