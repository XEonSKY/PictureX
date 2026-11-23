<script setup lang="ts">
import { ExportOutlined, FileImageOutlined, FolderOpenOutlined, RollbackOutlined } from '@antdv-next/icons';
import type { ExportEvent } from '~~/server/domain/export-assets';

definePageMeta({
    layout: 'album',
});

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const albumId = computed(() => String(route.params.id));
const { formatBytes } = useFormat();
const { album, load } = useAlbumContext(albumId);
const { form: globalSettings, load: loadSettings } = useSettings();

const name = ref('');
const description = ref('');
const savingInfo = ref(false);
const savingFeatures = ref(false);
const notice = ref('');
const error = ref('');

const useGlobalThreshold = ref(true);
const threshold = ref(8);
const autoTagChoice = ref<'inherit' | 'on' | 'off'>('inherit');
const pixivEnabled = ref(false);
const pixivAutoDownload = ref(false);

const pickerOpen = ref(false);
const coverPickerOpen = ref(false);
const savingCover = ref(false);
const coverUrl = computed(() => {
    const cover = album.value?.coverAssetId;

    return cover
        ? `/api/v1/albums/${albumId.value}/assets/${cover}/thumbnail?size=256`
        : '';
});
const exportTarget = ref('');
const naming = ref<'sequence' | 'filename' | 'uuid'>('sequence');
const exporting = ref(false);
const exportProgress = ref({ total: 0, done: 0 });
const exportResult = ref<{ exported: number, missing: number, manifest: string } | null>(null);
interface ThumbMaintenance {
    status: 'idle' | 'running' | 'completed' | 'failed'
    kind: 'optimize' | 'clear' | null
    startedAt: string | null
    finishedAt: string | null
    removed: number
    error: string | null
}

interface ThumbWarmup {
    status: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
    scope: 'album' | 'import' | null
    total: number
    processed: number
    generated: number
    skipped: number
    failed: number
    currentAssetId: string | null
    startedAt: string | null
    finishedAt: string | null
    error: string | null
    resumable: boolean
    size: number
}

const thumbStats = ref<{
    count: number
    totalBytes: number
    fileBytes: number
    maxBytes: number
    sizes: { size: number, count: number, bytes: number }[]
    autoOptimize: boolean
    maintenance: ThumbMaintenance
    warmup: ThumbWarmup
    generator: { interactiveConcurrency: number, ewmaMs: number }
} | null>(null);
const optimizing = ref(false);
const clearingThumbs = ref(false);
const startingWarmup = ref(false);
const warmupPercent = computed(() => {
    const warmup = thumbStats.value?.warmup;

    if (!warmup || warmup.total <= 0) {
        return 0;
    }

    return Math.min(100, Math.round((warmup.processed / warmup.total) * 100));
});
let thumbPoll: ReturnType<typeof setInterval> | null = null;
let exportAbort: AbortController | null = null;

const globalThreshold = computed(() => globalSettings.value.similarity.hammingThreshold);
const exportPercent = computed(() => (
    exportProgress.value.total > 0
        ? Math.round((exportProgress.value.done / exportProgress.value.total) * 100)
        : 0
));
const autoTagOptions = computed(() => [
    { value: 'inherit', label: t('album.inheritGlobal', { value: globalSettings.value.ai.autoTag ? t('album.autoTagOn') : t('album.autoTagOff') }) },
    { value: 'on', label: t('album.autoTagOn') },
    { value: 'off', label: t('album.autoTagOff') },
]);
const namingOptions = computed(() => [
    { value: 'sequence', label: t('album.namingSequence') },
    { value: 'filename', label: t('album.namingFilename') },
    { value: 'uuid', label: t('album.namingUuid') },
]);

watch(album, (value) => {
    if (!value) {
        return;
    }

    name.value = value.name;
    description.value = value.description;
    useGlobalThreshold.value = value.settings.similarityThreshold === null;
    threshold.value = value.settings.similarityThreshold ?? globalThreshold.value;
    autoTagChoice.value = value.settings.autoTag === null
        ? 'inherit'
        : value.settings.autoTag ? 'on' : 'off';
    pixivEnabled.value = value.settings.pixivEnabled === true;
    pixivAutoDownload.value = value.settings.pixivAutoDownload === true;
}, { immediate: true });

async function saveInfo(): Promise<void> {
    savingInfo.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: albumId.value },
            json: { name: name.value.trim(), description: description.value.trim() },
        });
        notice.value = t('common.saved');
        await load(true);
    }
    catch (saveError) {
        error.value = errorMessage(saveError);
    }
    finally {
        savingInfo.value = false;
    }
}

async function patchCover(coverAssetId: string | null, doneMessage: string): Promise<void> {
    savingCover.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: albumId.value },
            json: { coverAssetId },
        });
        notice.value = doneMessage;
        await load(true);
    }
    catch (coverError) {
        error.value = errorMessage(coverError);
    }
    finally {
        savingCover.value = false;
    }
}

function applyCover(coverAssetId: string): Promise<void> {
    return patchCover(coverAssetId, t('album.coverApplied'));
}

function restoreAutoCover(): Promise<void> {
    return patchCover(null, t('album.coverAutoRestored'));
}

async function saveFeatures(): Promise<void> {
    savingFeatures.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: albumId.value },
            json: {
                settings: {
                    similarityThreshold: useGlobalThreshold.value ? null : threshold.value,
                    autoTag: autoTagChoice.value === 'inherit' ? null : autoTagChoice.value === 'on',
                    pixivEnabled: pixivEnabled.value,
                    pixivAutoDownload: pixivAutoDownload.value,
                },
            },
        });
        notice.value = t('common.saved');
        await load(true);
    }
    catch (saveError) {
        error.value = errorMessage(saveError);
    }
    finally {
        savingFeatures.value = false;
    }
}

async function loadThumbStats(): Promise<void> {
    try {
        const response = await api.albums[':albumId'].thumbnails.$get({
            param: { albumId: albumId.value },
        });

        thumbStats.value = (await response.json()).data;
    }
    catch {
        thumbStats.value = null;
    }
}

function stopThumbPoll(): void {
    if (thumbPoll) {
        clearInterval(thumbPoll);
        thumbPoll = null;
    }
}

function startThumbPoll(): void {
    if (thumbPoll) {
        return;
    }

    thumbPoll = setInterval(() => {
        // 后台标签页不需要 800ms 一次轮询；回到前台时由 visibilitychange 立即补一次
        if (document.visibilityState === 'visible') {
            void loadThumbStats();
        }
    }, 800);
}

/** 从后台切回时立刻刷新一次缩略图进度，不必等下一个轮询周期 */
function handleVisibility(): void {
    if (document.visibilityState === 'visible' && thumbPoll !== null) {
        void loadThumbStats();
    }
}

watch(() => thumbStats.value?.warmup.status, (status) => {
    if (status === 'running') {
        startThumbPoll();
    }
    else {
        stopThumbPoll();
    }
});

async function startWarmup(restart = false): Promise<void> {
    startingWarmup.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].thumbnails.warmup.$post({
            param: { albumId: albumId.value },
            json: { restart },
        });
        await loadThumbStats();
    }
    catch (warmupError) {
        error.value = errorMessage(warmupError);
    }
    finally {
        startingWarmup.value = false;
    }
}

async function pauseWarmup(): Promise<void> {
    try {
        await api.albums[':albumId'].thumbnails.warmup.pause.$post({
            param: { albumId: albumId.value },
        });
        await loadThumbStats();
    }
    catch (warmupError) {
        error.value = errorMessage(warmupError);
    }
}

async function cancelWarmup(): Promise<void> {
    try {
        await api.albums[':albumId'].thumbnails.warmup.cancel.$post({
            param: { albumId: albumId.value },
        });
        await loadThumbStats();
    }
    catch (warmupError) {
        error.value = errorMessage(warmupError);
    }
}

async function waitForThumbMaintenance(): Promise<ThumbMaintenance> {
    const deadline = Date.now() + 5 * 60 * 1000;

    for (;;) {
        const response = await api.albums[':albumId'].thumbnails.$get({
            param: { albumId: albumId.value },
        });
        const data = (await response.json()).data;

        thumbStats.value = data;

        if (data.maintenance.status === 'completed') {
            return data.maintenance;
        }
        if (data.maintenance.status === 'failed') {
            throw new Error(t('errors.internal_error'));
        }
        if (Date.now() > deadline) {
            throw new Error(t('errors.http_error'));
        }

        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

async function optimizeThumbs(): Promise<void> {
    optimizing.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].thumbnails.optimize.$post({
            param: { albumId: albumId.value },
        });
        const maintenance = await waitForThumbMaintenance();

        notice.value = t('album.thumbOptimized', { removed: maintenance.removed });
        await loadThumbStats();
    }
    catch (optimizeError) {
        error.value = errorMessage(optimizeError);
    }
    finally {
        optimizing.value = false;
    }
}

async function clearThumbs(): Promise<void> {
    clearingThumbs.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].thumbnails.$delete({
            param: { albumId: albumId.value },
        });
        await waitForThumbMaintenance();
        notice.value = t('album.thumbCleared');
        await loadThumbStats();
    }
    catch (clearError) {
        error.value = errorMessage(clearError);
    }
    finally {
        clearingThumbs.value = false;
    }
}

async function startExport(): Promise<void> {
    if (exporting.value || exportTarget.value.trim() === '') {
        if (exportTarget.value.trim() === '') {
            error.value = t('album.exportTargetMissing');
        }

        return;
    }

    exporting.value = true;
    error.value = '';
    notice.value = '';
    exportResult.value = null;
    exportProgress.value = { total: 0, done: 0 };
    const controller = new AbortController();

    exportAbort = controller;

    try {
        const response = await api.albums[':albumId'].exports.$post({
            param: { albumId: albumId.value },
            json: { targetPath: exportTarget.value.trim(), naming: naming.value },
        }, { init: { signal: controller.signal } });
        const reader = response.body?.getReader();

        if (!reader) {
            throw new Error(t('errors.export_stream_unavailable'));
        }

        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
            const chunk = await reader.read();

            if (chunk.done) {
                break;
            }

            buffer += decoder.decode(chunk.value, { stream: true });

            const lines = buffer.split('\n');

            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (line.trim() === '') {
                    continue;
                }

                const event = JSON.parse(line) as ExportEvent;

                if (event.type === 'start') {
                    exportProgress.value = { total: event.total, done: 0 };
                }
                else if (event.type === 'progress') {
                    exportProgress.value = { total: event.total, done: event.done };
                }
                else if (event.type === 'done') {
                    exportResult.value = {
                        exported: event.exported,
                        missing: event.missing,
                        manifest: event.manifest,
                    };
                }
                else if (event.type === 'cancelled') {
                    notice.value = t('album.exportCancelled');
                }
            }
        }
    }
    catch (exportError) {
        if (controller.signal.aborted) {
            notice.value = t('album.exportCancelled');
        }
        else {
            error.value = errorMessage(exportError);
        }
    }
    finally {
        exporting.value = false;
        exportAbort = null;
    }
}

function cancelExport(): void {
    exportAbort?.abort();
}

useHead({
    title: () => `${t('album.settingsTitle')} · ${album.value?.name ?? 'PictureX'}`,
});

onMounted(() => {
    void load(true);
    void loadSettings();
    void loadThumbStats();
    document.addEventListener('visibilitychange', handleVisibility);
});

onBeforeUnmount(() => {
    // 组件卸载后 reader.read() 仍在消费 NDJSON 流并写已卸载组件的 ref → 中止导出
    exportAbort?.abort();
    document.removeEventListener('visibilitychange', handleVisibility);
    stopThumbPoll();
});
</script>

<template>
    <div class="px-page album-settings">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <h1 class="px-page-title">
                    {{ t('album.settingsTitle') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('album.settingsSubtitle') }}
                </p>
            </div>
        </header>

        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />
        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />

        <SettingsSection
            :title="t('album.infoTitle')"
            :saving="savingInfo"
            @save="saveInfo"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('album.infoName')">
                    <a-input v-model:value="name" :maxlength="120" />
                </a-form-item>
                <a-form-item :label="t('album.infoDescription')">
                    <a-textarea v-model:value="description" :rows="2" :maxlength="2000" />
                </a-form-item>
            </a-form>
        </SettingsSection>

        <SettingsSection :title="t('album.coverTitle')" :show-save="false">
            <div class="cover-setting">
                <p class="px-hint">
                    {{ t('album.coverHint') }}
                </p>
                <div class="cover-setting__row">
                    <div class="cover-setting__preview">
                        <img v-if="coverUrl" :src="coverUrl" :alt="t('album.coverPreview')" loading="lazy" decoding="async">
                        <span v-else class="cover-setting__none">{{ t('album.coverNone') }}</span>
                    </div>
                    <div class="cover-setting__actions">
                        <a-button
                            type="primary"
                            :disabled="!album || album.assetCount === 0"
                            @click="coverPickerOpen = true"
                        >
                            <template #icon>
                                <FileImageOutlined />
                            </template>
                            {{ t('album.coverPick') }}
                        </a-button>
                        <a-button
                            :disabled="!album?.coverAssetId || savingCover"
                            :loading="savingCover"
                            @click="restoreAutoCover"
                        >
                            <template #icon>
                                <RollbackOutlined />
                            </template>
                            {{ t('album.coverAuto') }}
                        </a-button>
                    </div>
                </div>
            </div>
        </SettingsSection>

        <SettingsSection
            :title="t('album.featuresTitle')"
            :saving="savingFeatures"
            @save="saveFeatures"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('album.similarityThreshold')">
                    <a-checkbox v-model:checked="useGlobalThreshold">
                        {{ t('album.inheritGlobal', { value: globalThreshold }) }}
                    </a-checkbox>
                    <a-slider
                        v-model:value="threshold"
                        :min="0"
                        :max="64"
                        :disabled="useGlobalThreshold"
                    />
                </a-form-item>
                <a-form-item :label="t('album.autoTagOnImport')">
                    <a-select v-model:value="autoTagChoice" :options="autoTagOptions" />
                </a-form-item>
                <a-form-item :label="t('album.pixivEnable')">
                    <a-switch v-model:checked="pixivEnabled" />
                    <p class="px-hint">
                        {{ t('album.pixivEnableHint') }}
                    </p>
                </a-form-item>
                <a-form-item :label="t('album.pixivAutoDownload')">
                    <a-switch v-model:checked="pixivAutoDownload" :disabled="!pixivEnabled" />
                    <p class="px-hint">
                        {{ t('album.pixivAutoDownloadHint') }}
                    </p>
                </a-form-item>
            </a-form>
            <p class="px-hint">
                {{ t('album.featuresHint') }}
            </p>
        </SettingsSection>

        <SettingsSection :title="t('album.thumbStorageTitle')" :show-save="false">
            <div class="thumb-storage">
                <p class="px-hint">
                    {{ t('album.thumbStorageHint') }}
                </p>
                <p v-if="thumbStats" class="thumb-storage__meta">
                    {{ t('album.thumbStats', {
                        count: thumbStats.count,
                        used: formatBytes(thumbStats.totalBytes),
                        file: formatBytes(thumbStats.fileBytes),
                        max: formatBytes(thumbStats.maxBytes),
                    }) }}
                </p>
                <div v-if="thumbStats && thumbStats.sizes.length > 0" class="thumb-storage__sizes">
                    <p class="px-hint">
                        {{ t('album.thumbSizesTitle') }}
                    </p>
                    <p v-for="usage in thumbStats.sizes" :key="usage.size" class="thumb-storage__meta">
                        {{ t('album.thumbSizeStats', {
                            size: usage.size,
                            count: usage.count,
                            bytes: formatBytes(usage.bytes),
                        }) }}
                    </p>
                </div>
                <p v-if="thumbStats" class="px-hint">
                    {{ thumbStats.autoOptimize ? t('album.thumbAutoOn') : t('album.thumbAutoOff') }}
                </p>

                <div v-if="thumbStats" class="thumb-warmup">
                    <p class="px-hint">
                        {{ t('album.thumbWarmupHint', {
                            size: thumbStats.warmup.size || 256,
                            concurrency: thumbStats.generator.interactiveConcurrency,
                        }) }}
                    </p>
                    <a-progress
                        v-if="thumbStats.warmup.status !== 'idle'"
                        :percent="warmupPercent"
                        :status="thumbStats.warmup.status === 'failed' ? 'exception' : thumbStats.warmup.status === 'completed' ? 'success' : 'normal'"
                    />
                    <p v-if="thumbStats.warmup.status !== 'idle'" class="px-hint">
                        {{ t('album.thumbWarmupProgress', {
                            processed: thumbStats.warmup.processed,
                            total: thumbStats.warmup.total,
                            generated: thumbStats.warmup.generated,
                            skipped: thumbStats.warmup.skipped,
                            failed: thumbStats.warmup.failed,
                        }) }}
                    </p>
                    <p v-if="thumbStats.warmup.status === 'paused'" class="px-hint">
                        {{ t('album.thumbWarmupPaused') }}
                    </p>
                    <p v-if="thumbStats.warmup.status === 'cancelled'" class="px-hint">
                        {{ t('album.thumbWarmupCancelled') }}
                    </p>
                    <p v-if="thumbStats.warmup.status === 'failed'" class="px-hint">
                        {{ t('album.thumbWarmupFailed', { error: thumbStats.warmup.error ?? '' }) }}
                    </p>
                    <p v-if="thumbStats.warmup.status === 'completed'" class="px-hint">
                        {{ t('album.thumbWarmupCompleted') }}
                    </p>
                    <div class="thumb-storage__actions">
                        <template v-if="thumbStats.warmup.status === 'running'">
                            <a-button @click="pauseWarmup">
                                {{ t('album.thumbWarmupPause') }}
                            </a-button>
                            <a-button danger @click="cancelWarmup">
                                {{ t('album.thumbWarmupCancel') }}
                            </a-button>
                        </template>
                        <template v-else>
                            <a-button type="primary" :loading="startingWarmup" @click="startWarmup(false)">
                                {{ thumbStats.warmup.resumable ? t('album.thumbWarmupResume') : t('album.thumbWarmupStart') }}
                            </a-button>
                            <a-popconfirm
                                v-if="thumbStats.warmup.status !== 'idle' || thumbStats.warmup.resumable"
                                :title="t('album.thumbWarmupRestartConfirm')"
                                :ok-text="t('common.confirm')"
                                :cancel-text="t('common.cancel')"
                                @confirm="startWarmup(true)"
                            >
                                <a-button>
                                    {{ t('album.thumbWarmupRestart') }}
                                </a-button>
                            </a-popconfirm>
                        </template>
                    </div>
                </div>

                <div class="thumb-storage__actions">
                    <a-button :loading="optimizing" @click="optimizeThumbs">
                        {{ t('album.thumbOptimize') }}
                    </a-button>
                    <a-popconfirm
                        :title="t('album.thumbClearConfirm')"
                        :ok-text="t('common.delete')"
                        :cancel-text="t('common.cancel')"
                        @confirm="clearThumbs"
                    >
                        <a-button danger :loading="clearingThumbs">
                            {{ t('album.thumbClear') }}
                        </a-button>
                    </a-popconfirm>
                </div>
            </div>
        </SettingsSection>

        <SettingsSection :title="t('album.exportTitle')" :show-save="false">
            <div class="export-form">
                <p class="px-hint">
                    {{ t('album.exportHint') }}
                </p>
                <div class="export-form__row">
                    <a-input
                        v-model:value="exportTarget"
                        :placeholder="t('album.exportTarget')"
                        :maxlength="4096"
                    />
                    <a-button @click="pickerOpen = true">
                        <template #icon>
                            <FolderOpenOutlined />
                        </template>
                        {{ t('album.browse') }}
                    </a-button>
                </div>
                <a-select v-model:value="naming" :options="namingOptions" :aria-label="t('album.exportNaming')" />
                <div class="export-form__actions">
                    <a-button v-if="!exporting" type="primary" @click="startExport">
                        <template #icon>
                            <ExportOutlined />
                        </template>
                        {{ t('album.exportStart') }}
                    </a-button>
                    <a-button v-else danger :loading="true" @click="cancelExport">
                        {{ t('album.cancelExport') }}
                    </a-button>
                </div>
                <a-progress
                    v-if="exporting || exportResult"
                    :percent="exportPercent"
                    :show-info="false"
                    size="small"
                />
                <p v-if="exporting" class="px-hint">
                    {{ t('album.exportRunning', { done: exportProgress.done, total: exportProgress.total }) }}
                </p>
                <a-alert
                    v-if="exportResult"
                    type="success"
                    show-icon
                    :message="t('album.exportDone', { exported: exportResult.exported, manifest: exportResult.manifest })"
                />
                <a-alert
                    v-if="exportResult && exportResult.missing > 0"
                    type="warning"
                    show-icon
                    :message="t('album.exportMissing', { count: exportResult.missing })"
                />
            </div>
        </SettingsSection>

        <DirectoryPicker
            v-model:open="pickerOpen"
            mode="directory"
            :initial-path="exportTarget || undefined"
            @select="exportTarget = $event"
        />

        <CoverPickerModal
            v-model:open="coverPickerOpen"
            :album-id="albumId"
            :current-cover-id="album?.coverAssetId ?? null"
            @select="applyCover"
        />
    </div>
</template>

<style scoped>
.album-settings {
    max-width: var(--px-layout-content-narrow);
}

.cover-setting {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.cover-setting__row {
    display: flex;
    align-items: flex-start;
    gap: var(--px-space-4);
}

.cover-setting__preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 168px;
    height: 168px;
    overflow: hidden;
    border-radius: var(--px-radius-md);
    background: var(--px-color-bg-sunken);
}

.cover-setting__preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.cover-setting__none {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.cover-setting__actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--px-space-2);
}

.thumb-storage {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
}

.thumb-warmup {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
}

.thumb-storage__sizes {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding-left: var(--px-space-3);
    border-left: 1px solid var(--px-color-border);
}

.thumb-storage__meta {
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
    font-family: var(--px-font-family-mono);
}

.thumb-storage__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--px-space-2);
}

.export-form {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.export-form__row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.export-form__row :deep(.ant-input) {
    flex: 1;
}

.export-form__actions {
    display: flex;
    justify-content: flex-end;
}
</style>
