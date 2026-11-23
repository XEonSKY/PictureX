<script setup lang="ts">
definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const api = useApi();
const { form, saving, saved, saveSection } = useSettings();

const title = computed(() => t('settings.moduleAi'));

interface DeviceCapabilities {
    platform: string
    arch: string
    preference: 'auto' | 'cpu' | 'gpu'
    available: { id: string, label: string, kind: string }[]
    active: string | null
    accelerated: boolean
    acceleratorModelId: string
    acceleratorInstalled: boolean
}

interface LocalModelEntry {
    id: string
    name: string
    task: 'zero-shot' | 'captioning'
    status: 'available' | 'installed' | 'corrupted'
    broken?: boolean
}

interface ModelOption {
    value: string
    label: string
    disabled: boolean
}

const capabilities = ref<DeviceCapabilities | null>(null);
const localModels = ref<LocalModelEntry[]>([]);

const modeOptions = computed(() => [
    { value: 'zero-shot', label: t('settings.zeroShot') },
    { value: 'generative', label: t('settings.generative') },
    { value: 'external', label: t('settings.external') },
]);

const deviceOptions = computed(() => [
    { value: 'auto', label: t('settings.accelAuto') },
    { value: 'cpu', label: t('settings.accelCpu') },
    { value: 'gpu', label: t('settings.accelGpu') },
]);

const detectedDevices = computed(() => (
    capabilities.value?.available
        .filter(device => device.id !== 'cpu')
        .map(device => device.label)
        .join(' / ') || 'CPU'
));

const activeDevice = computed(() => {
    const active = capabilities.value?.active;

    if (!active) {
        return 'CPU';
    }

    return capabilities.value?.available.find(device => device.id === active)?.label ?? active;
});

function modelStatusLabel(status: LocalModelEntry['status']): string {
    if (status === 'installed') {
        return '';
    }

    return status === 'corrupted' ? t('models.corrupted') : t('models.available');
}

function modelOptionsFor(task: LocalModelEntry['task'], current: string): ModelOption[] {
    const options = localModels.value
        .filter(model => model.task === task && !model.broken)
        .map(model => ({
            value: model.id,
            label: model.status === 'installed'
                ? model.name
                : `${model.name} · ${modelStatusLabel(model.status)}`,
            disabled: model.status !== 'installed' && model.id !== current,
        }));

    if (current !== '' && !options.some(option => option.value === current)) {
        options.unshift({ value: current, label: current, disabled: false });
    }

    return options;
}

const zeroShotModelOptions = computed(() => modelOptionsFor('zero-shot', form.value.ai.localModelId));
const captioningModelOptions = computed(() => modelOptionsFor('captioning', form.value.ai.captioningModelId));

async function loadModels(): Promise<void> {
    try {
        const response = await api.models.$get();
        const body: { data: LocalModelEntry[] } = await response.json();

        localModels.value = body.data;
    }
    catch {
        localModels.value = [];
    }
}

async function loadCapabilities(): Promise<void> {
    try {
        const response = await api.settings.ai.devices.$get();
        const body: { data: DeviceCapabilities } = await response.json();

        capabilities.value = body.data;
    }
    catch {
        capabilities.value = null;
    }
}

async function saveSectionAi(): Promise<void> {
    await saveSection('ai', aiPatch());
    await loadCapabilities();
}

function saveSectionExternal(): void {
    void saveSection('external', aiPatch());
}

function aiPatch() {
    return {
        ai: {
            ...form.value.ai,
            external: { ...form.value.ai.external },
        },
    };
}

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});

onMounted(() => {
    void loadModels();
    void loadCapabilities();
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleAi')">
        <SettingsSection
            :title="t('settings.ai')"
            :saving="saving === 'ai'"
            :saved="saved === 'ai'"
            @save="saveSectionAi"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.labelMode')">
                    <a-select v-model:value="form.ai.labelMode" :options="modeOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.acceleration')">
                    <a-select v-model:value="form.ai.device" :options="deviceOptions" />
                    <p class="px-hint">
                        {{ t('settings.accelHint') }}
                    </p>
                    <p v-if="capabilities" class="px-hint">
                        {{ t('settings.accelDetected', { devices: detectedDevices }) }}
                        · {{ t('settings.accelActive', { device: activeDevice }) }}
                    </p>
                    <p v-if="capabilities && form.ai.device !== 'cpu' && !capabilities.acceleratorInstalled" class="px-hint">
                        {{ t('settings.accelPackHint', { model: capabilities.acceleratorModelId }) }}
                    </p>
                </a-form-item>
                <a-form-item :label="t('settings.localModel')">
                    <a-select v-model:value="form.ai.localModelId" :options="zeroShotModelOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.captioningModel')">
                    <a-select v-model:value="form.ai.captioningModelId" :options="captioningModelOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.autoTag')">
                    <a-switch v-model:checked="form.ai.autoTag" />
                </a-form-item>
                <a-form-item :label="t('settings.downloadConcurrency')">
                    <a-input-number v-model:value="form.ai.downloadConcurrency" :min="1" :max="16" class="px-field-full" />
                </a-form-item>
                <a-form-item :label="t('settings.autoResumeDownload')">
                    <a-switch v-model:checked="form.ai.autoResumeDownload" />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.aiHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>

        <SettingsSection
            :title="t('settings.external')"
            :saving="saving === 'external'"
            :saved="saved === 'external'"
            @save="saveSectionExternal"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.externalEnabled')">
                    <a-switch v-model:checked="form.ai.external.enabled" />
                </a-form-item>
                <a-form-item :label="t('settings.baseUrl')">
                    <a-input v-model:value="form.ai.external.baseUrl" placeholder="https://api.openai.com/v1" />
                </a-form-item>
                <a-form-item :label="t('settings.apiKey')">
                    <a-input-password v-model:value="form.ai.external.apiKey" />
                </a-form-item>
                <a-form-item :label="t('settings.model')">
                    <a-input v-model:value="form.ai.external.model" />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.apiKeyHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>
    </SettingsModule>
</template>
