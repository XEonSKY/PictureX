<script setup lang="ts">
import { ClearOutlined, CloudDownloadOutlined, DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined, SafetyCertificateOutlined, StopOutlined } from '@antdv-next/icons';
import type { ModelEntry } from '~~/server/model/types';

interface DownloadSummary {
    status: string
    bytesDone: number
    totalBytes: number
    speedBps: number
    updatedAt: string
    error: string | null
}

type ModelWithDownload = ModelEntry & { download: DownloadSummary | null };

const { t } = useI18n();
const api = useApi();
const { formatBytes, formatDateTime } = useFormat();

const models = ref<ModelWithDownload[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const cleaning = ref(false);
const busy = ref<Record<string, boolean>>({});
let source: EventSource | null = null;

function percentOf(model: ModelWithDownload): number {
    const download = model.download;

    if (!download || download.totalBytes <= 0) {
        return 0;
    }

    return Math.min(100, Math.round((download.bytesDone / download.totalBytes) * 100));
}

function statusText(model: ModelWithDownload): string {
    if (model.broken) {
        return t('models.broken');
    }
    if (model.status === 'installed') {
        return t('models.installed');
    }
    if (model.status === 'corrupted') {
        return t('models.corrupted');
    }

    return t('models.available');
}

function statusColor(model: ModelWithDownload): string {
    if (model.broken) {
        return 'warning';
    }
    if (model.status === 'installed') {
        return 'success';
    }
    if (model.status === 'corrupted') {
        return 'error';
    }

    return 'default';
}

function taskLabel(model: ModelWithDownload): string {
    return model.task === 'captioning' ? t('models.captionTask') : t('models.zeroShotTask');
}

async function load(): Promise<void> {
    loading.value = true;
    error.value = '';

    try {
        const response = await api.models.$get();
        const body = await response.json();

        models.value = body.data;
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loading.value = false;
    }
}

async function action(modelId: string, run: () => Promise<unknown>): Promise<void> {
    busy.value = { ...busy.value, [modelId]: true };
    error.value = '';

    try {
        await run();
        await load();
    }
    catch (actionError) {
        error.value = errorMessage(actionError);
    }
    finally {
        busy.value = { ...busy.value, [modelId]: false };
    }
}

function download(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].download.$post({ param: { modelId } }));
}

function pause(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].download.pause.$post({ param: { modelId } }));
}

function resume(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].download.resume.$post({ param: { modelId } }));
}

function cancel(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].download.cancel.$post({ param: { modelId } }));
}

function verify(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].verify.$post({ param: { modelId } }));
}

function remove(modelId: string): void {
    void action(modelId, () => api.models[':modelId'].$delete({ param: { modelId } }));
}

async function cleanup(): Promise<void> {
    cleaning.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.models.cleanup.$post({ json: { confirm: true, mode: 'unused' } });
        const body = await response.json();

        notice.value = t('models.cleanupDone', { count: body.data.removed.length });
        await load();
    }
    catch (cleanupError) {
        error.value = errorMessage(cleanupError);
    }
    finally {
        cleaning.value = false;
    }
}

function applyDownloadEvent(event: DownloadSummary & { modelId: string }): void {
    models.value = models.value.map((model) => {
        if (model.id !== event.modelId) {
            return model;
        }

        return { ...model, download: event };
    });
}

function openEvents(): void {
    if (!import.meta.client) {
        return;
    }

    source = new EventSource('/api/v1/models/events');

    source.addEventListener('snapshot', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as (DownloadSummary & { modelId: string })[];

        for (const item of payload) {
            applyDownloadEvent(item);
        }
    });

    source.addEventListener('download', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as DownloadSummary & { modelId: string };

        applyDownloadEvent(payload);

        // 完成/失败/取消后模型状态与文件列表会变化，重新拉取一次
        if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') {
            void load();
        }
    });
}

onMounted(() => {
    void load();
    openEvents();
});

onBeforeUnmount(() => {
    source?.close();
    source = null;
});
</script>

<template>
    <div class="models">
        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <div class="models__toolbar">
            <p class="models__hint">
                {{ t('models.cleanupHint') }}
            </p>
            <a-popconfirm
                :title="t('models.cleanupConfirm')"
                :ok-text="t('common.delete')"
                :cancel-text="t('common.cancel')"
                @confirm="cleanup"
            >
                <a-button danger :loading="cleaning">
                    <template #icon>
                        <ClearOutlined />
                    </template>
                    {{ t('models.cleanup') }}
                </a-button>
            </a-popconfirm>
        </div>

        <div v-if="loading" class="models__loading">
            <a-spin />
        </div>

        <article v-for="model in models" v-else :key="model.id" class="model-row px-surface">
            <header class="model-row__head">
                <div class="model-row__title">
                    <h3 class="model-row__name">
                        {{ model.name }}
                    </h3>
                    <p class="model-row__meta">
                        {{ taskLabel(model) }}
                        <span aria-hidden="true">·</span>
                        {{ model.totalBytes > 0 ? formatBytes(model.totalBytes) : t('models.sizeUnknown') }}
                    </p>
                </div>
                <a-tag :color="statusColor(model)">
                    {{ statusText(model) }}
                </a-tag>
            </header>

            <p class="model-row__path px-selectable">
                {{ model.files.map(file => file.path).join(' · ') }}
            </p>

            <div v-if="model.download && (model.download.status === 'downloading' || model.download.status === 'paused')" class="model-row__progress">
                <a-progress
                    :percent="percentOf(model)"
                    :status="model.download.status === 'paused' ? 'normal' : 'active'"
                    size="small"
                />
                <div class="model-row__stats">
                    <span>{{ t('jobs.downloadProgress', { done: formatBytes(model.download.bytesDone), total: formatBytes(model.download.totalBytes) }) }}</span>
                    <span>{{ t('jobs.speedNow', { speed: `${formatBytes(model.download.speedBps)}/s` }) }}</span>
                </div>
            </div>

            <p v-if="model.broken" class="model-row__hint model-row__hint--danger">
                {{ t('models.brokenHint') }}
            </p>
            <p v-else-if="model.status === 'installed'" class="model-row__hint">
                {{ t('models.installedHint') }}
                <span v-if="model.installedAt">· {{ formatDateTime(model.installedAt) }}</span>
            </p>
            <p v-else-if="model.status === 'corrupted'" class="model-row__hint model-row__hint--danger">
                {{ model.error ?? t('models.corruptedHint') }}
            </p>
            <p v-else class="model-row__hint">
                {{ t('models.availableHint') }}
            </p>

            <footer class="model-row__actions">
                <a-button
                    v-if="model.download?.status === 'downloading'"
                    :loading="busy[model.id]"
                    @click="pause(model.id)"
                >
                    <template #icon>
                        <PauseCircleOutlined />
                    </template>
                    {{ t('models.pause') }}
                </a-button>
                <a-button
                    v-else-if="model.download?.status === 'paused'"
                    :loading="busy[model.id]"
                    @click="resume(model.id)"
                >
                    <template #icon>
                        <PlayCircleOutlined />
                    </template>
                    {{ t('models.resume') }}
                </a-button>
                <a-button
                    v-else-if="model.status !== 'installed' && !model.broken"
                    type="primary"
                    :loading="busy[model.id]"
                    @click="download(model.id)"
                >
                    <template #icon>
                        <CloudDownloadOutlined />
                    </template>
                    {{ t('models.download') }}
                </a-button>

                <a-button
                    v-if="model.download && (model.download.status === 'downloading' || model.download.status === 'paused')"
                    danger
                    :loading="busy[model.id]"
                    @click="cancel(model.id)"
                >
                    <template #icon>
                        <StopOutlined />
                    </template>
                    {{ t('models.cancel') }}
                </a-button>

                <a-button
                    v-if="model.status === 'installed' && !model.broken"
                    :loading="busy[model.id]"
                    @click="verify(model.id)"
                >
                    <template #icon>
                        <SafetyCertificateOutlined />
                    </template>
                    {{ t('models.verify') }}
                </a-button>

                <a-popconfirm
                    v-if="model.status !== 'available'"
                    :title="t('models.removeConfirm', { name: model.name })"
                    :ok-text="t('common.delete')"
                    :cancel-text="t('common.cancel')"
                    @confirm="remove(model.id)"
                >
                    <a-button danger type="text" :loading="busy[model.id]">
                        <template #icon>
                            <DeleteOutlined />
                        </template>
                        {{ t('models.remove') }}
                    </a-button>
                </a-popconfirm>
            </footer>
        </article>
    </div>
</template>

<style scoped>
.models {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.models__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
}

.models__hint {
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.models__loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-10);
}

.model-row {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    padding: var(--px-space-4);
}

.model-row__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--px-space-3);
}

.model-row__title {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    min-width: 0;
}

.model-row__name {
    margin: 0;
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.model-row__meta {
    margin: 0;
    display: flex;
    gap: var(--px-space-1);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.model-row__path {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--px-color-text-tertiary);
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-micro);
}

.model-row__progress {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
}

.model-row__stats {
    display: flex;
    justify-content: space-between;
    gap: var(--px-space-2);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
}

.model-row__hint {
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.model-row__hint--danger {
    color: var(--px-color-danger);
}

.model-row__actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}
</style>
