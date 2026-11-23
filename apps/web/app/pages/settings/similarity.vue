<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { form, saving, saved, saveSection } = useSettings();

const title = computed(() => t('settings.moduleSimilarity'));

function save(): void {
    void saveSection('similarity', { similarity: { ...form.value.similarity } });
}

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleSimilarity')">
        <SettingsSection
            :title="t('settings.similarity')"
            :saving="saving === 'similarity'"
            :saved="saved === 'similarity'"
            @save="save"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.similarityEnabled')">
                    <a-switch v-model:checked="form.similarity.enabled" />
                </a-form-item>
                <a-form-item :label="t('settings.hammingThreshold')">
                    <a-slider v-model:value="form.similarity.hammingThreshold" :min="0" :max="64" />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.thresholdHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>
    </SettingsModule>
</template>
