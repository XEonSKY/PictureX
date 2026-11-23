<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { form, dataDir, saving, saved, saveSection } = useSettings();

const title = computed(() => t('settings.moduleStorage'));

const pickerOpen = ref(false);
const pickerTarget = ref<'albumsRoot' | 'modelsRoot'>('albumsRoot');
const pickerInitial = ref<string | undefined>(undefined);

function openPathPicker(target: 'albumsRoot' | 'modelsRoot'): void {
    pickerTarget.value = target;
    pickerInitial.value = form.value[target]?.trim() || undefined;
    pickerOpen.value = true;
}

function onPickPath(path: string): void {
    form.value[pickerTarget.value] = path;
}

const storageOptions = computed(() => [
    { value: 'local', label: t('settings.storageLocal') },
    { value: 'quark', label: t('settings.storageComingSoon', { name: 'Quark' }), disabled: true },
    { value: 'oss', label: t('settings.storageComingSoon', { name: 'OSS' }), disabled: true },
    { value: 'ftp', label: t('settings.storageComingSoon', { name: 'FTP' }), disabled: true },
]);

function storagePatch() {
    return {
        albumsRoot: form.value.albumsRoot,
        modelsRoot: form.value.modelsRoot,
        storage: { ...form.value.storage },
    };
}

function savePaths(): void {
    void saveSection('storage', storagePatch());
}

function saveBackend(): void {
    void saveSection('backend', storagePatch());
}

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleStorage')">
        <SettingsSection
            :title="t('settings.paths')"
            :saving="saving === 'storage'"
            :saved="saved === 'storage'"
            @save="savePaths"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.dataDir')">
                    <a-input :value="dataDir" disabled class="px-selectable" />
                </a-form-item>
                <a-form-item :label="t('settings.albumsRoot')">
                    <div class="path-row">
                        <a-input v-model:value="form.albumsRoot" class="px-selectable path-row__input" />
                        <a-button @click="openPathPicker('albumsRoot')">
                            {{ t('album.browse') }}
                        </a-button>
                    </div>
                </a-form-item>
                <a-form-item :label="t('settings.modelsRoot')">
                    <div class="path-row">
                        <a-input v-model:value="form.modelsRoot" class="px-selectable path-row__input" />
                        <a-button @click="openPathPicker('modelsRoot')">
                            {{ t('album.browse') }}
                        </a-button>
                    </div>
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.pathsHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>

        <SettingsSection
            :title="t('settings.storageBackend')"
            :saving="saving === 'backend'"
            :saved="saved === 'backend'"
            @save="saveBackend"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.storageBackend')">
                    <a-select v-model:value="form.storage.default" :options="storageOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.partitionSize')">
                    <a-input-number v-model:value="form.storage.partitionSize" :min="1" :max="1000000" class="px-field-full" />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.storageHint') }}
                    </p>
                    <p class="px-hint">
                        {{ t('settings.partitionHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>

        <DirectoryPicker
            v-model:open="pickerOpen"
            mode="directory"
            :initial-path="pickerInitial"
            @select="onPickPath"
        />
    </SettingsModule>
</template>

<style scoped>
.path-row {
    display: flex;
    gap: var(--px-space-2);
    align-items: center;
}

.path-row__input {
    flex: 1;
    min-width: 0;
}
</style>
