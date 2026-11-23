<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();

const title = computed(() => t('settings.moduleModels'));

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleModels')">
        <SettingsSection :title="t('settings.models')" :show-save="false">
            <p class="px-hint">
                {{ t('settings.modelHint') }}
            </p>
            <ModelManager />
        </SettingsSection>
    </SettingsModule>
</template>
