<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { form, saving, saved, saveSection } = useSettings();

const title = computed(() => t('settings.moduleMedia'));

// 缩略图在首次请求时懒生成；请求尺寸不在列表内时用最近的配置尺寸
const sizeOptions = [256, 512, 1024, 2048, 4096].map(size => ({ value: size, label: `${size}` }));

function saveThumbnails(): void {
    void saveSection('thumbnails', { thumbnails: { ...form.value.thumbnails } });
}

function onSizesChange(values: (number | string)[]): void {
    // 后端要求至少一项；取消最后一个勾选时回落到 256
    if (values.length === 0) {
        form.value.thumbnails.sizes = [256];
    }
}

function saveFfmpeg(): void {
    void saveSection('ffmpeg', { ffmpeg: { ...form.value.ffmpeg } });
}

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleMedia')">
        <SettingsSection
            :title="t('settings.thumbnails')"
            :saving="saving === 'thumbnails'"
            :saved="saved === 'thumbnails'"
            @save="saveThumbnails"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.dbMaxSizeMb')">
                    <a-input-number v-model:value="form.thumbnails.dbMaxSizeMb" :min="64" :max="1048576" class="px-field-full" />
                </a-form-item>
                <a-form-item :label="t('settings.sizes')">
                    <a-checkbox-group v-model:value="form.thumbnails.sizes" :options="sizeOptions" @change="onSizesChange" />
                </a-form-item>
                <a-form-item :label="t('settings.quality')">
                    <a-slider v-model:value="form.thumbnails.quality" :min="1" :max="100" />
                    <p class="px-hint">
                        {{ t('settings.qualityHint') }}
                    </p>
                </a-form-item>
                <a-form-item :label="t('settings.cacheFirst')">
                    <a-switch v-model:checked="form.thumbnails.cacheFirst" />
                    <p class="px-hint">
                        {{ t('settings.cacheFirstHint') }}
                    </p>
                </a-form-item>
                <a-form-item :label="t('settings.autoOptimize')">
                    <a-switch v-model:checked="form.thumbnails.autoOptimize" />
                    <p class="px-hint">
                        {{ t('settings.autoOptimizeHint') }}
                    </p>
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.thumbnailHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>

        <SettingsSection
            :title="t('settings.ffmpeg')"
            :saving="saving === 'ffmpeg'"
            :saved="saved === 'ffmpeg'"
            @save="saveFfmpeg"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.ffmpegEnabled')">
                    <a-switch v-model:checked="form.ffmpeg.enabled" />
                </a-form-item>
                <a-form-item :label="t('settings.ffmpegPath')">
                    <a-input v-model:value="form.ffmpeg.path" :placeholder="t('settings.ffmpegAuto')" />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.ffmpegHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>
    </SettingsModule>
</template>
