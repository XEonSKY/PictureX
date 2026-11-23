<script setup lang="ts">
import {
    CloudDownloadOutlined,
    DatabaseOutlined,
    DeleteOutlined,
    FireOutlined,
    HddOutlined,
    PauseCircleOutlined,
    PictureOutlined,
    PlayCircleOutlined,
    ReloadOutlined,
    ScanOutlined,
    StopOutlined,
    SyncOutlined,
    ThunderboltOutlined,
    ToolOutlined,
} from '@antdv-next/icons';
import type { JobView } from '~~/server/jobs/job-query';
import type { DiskActivityDto, DiskActivityKind, DiskActivityTouch } from '~~/server/jobs/disk-activity';
import type { AiJobStatus } from '~~/server/album/ai-job-store';
import type { ImportStatus } from '~~/server/album/import-job-store';

type JobFilter = 'all' | 'import' | 'download' | 'ai';

interface JobCard {
    key: string
    type: 'import' | 'download' | 'ai'
    title: string
    subtitle: string
    status: string
    updatedAt: string
    percent: number
    detail: string
    extra: string
    error: string | null
    albumId?: string
    jobId?: string
    modelId?: string
}

const { t } = useI18n();
const api = useApi();
const { formatBytes, formatDateTime, formatNumber } = useFormat();

const props = withDefaults(defineProps<{
    albumId?: string
    embedded?: boolean
}>(), {
    albumId: '',
    embedded: false,
});

const albumScope = computed(() => props.albumId ?? '');

const jobs = ref<JobView[]>([]);
const filter = ref<JobFilter>('all');
const onlyActive = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref<Record<string, boolean>>({});
let source: EventSource | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let eventFrame = 0;
const pendingEvents = new Map<string, unknown>();

const DISK_POLL_MS = 2_500;
const DISK_COLLAPSED_ROWS = 4;

const disk = ref<DiskActivityDto | null>(null);
const diskExpanded = ref(false);
let diskTimer: ReturnType<typeof setInterval> | null = null;

interface DiskRow {
    key: string
    kind: DiskActivityKind
    label: string
    touchLabel: string
    albumName: string | null
    percent: number | null
    counter: string
    queued: number
    paused: boolean
}

function touchLabel(touch: DiskActivityTouch): string {
    if (touch === 'reading') {
        return t('jobs.diskTouchReading');
    }

    return touch === 'writing' ? t('jobs.diskTouchWriting') : t('jobs.diskTouchReadWrite');
}

function kindLabel(kind: DiskActivityKind): string {
    const map: Record<string, string> = {
        import: t('jobs.diskKindImport'),
        ai: t('jobs.diskKindAi'),
        thumbnail: t('jobs.diskKindThumbnail'),
        warmup: t('jobs.diskKindWarmup'),
        similarity: t('jobs.diskKindSimilarity'),
        maintenance: t('jobs.diskKindMaintenance'),
        pixiv: t('jobs.diskKindPixiv'),
        model: t('jobs.diskKindModel'),
    };

    return map[kind] ?? kind;
}

const diskRows = computed<DiskRow[]>(() => (disk.value?.items ?? []).map((item) => {
    const total = item.total;
    const done = item.done ?? 0;
    const hasTotal = total !== null && total > 0;
    const bytes = item.kind === 'model';

    return {
        key: item.id,
        kind: item.kind,
        label: kindLabel(item.kind),
        touchLabel: touchLabel(item.touch),
        albumName: item.albumName,
        percent: hasTotal && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
        counter: hasTotal
            ? (bytes
                ? `${formatBytes(done)} / ${formatBytes(total)}`
                : `${formatNumber(done)} / ${formatNumber(total)}`)
            : (bytes && done > 0 ? formatBytes(done) : ''),
        queued: item.queued,
        paused: item.paused,
    };
}));

const diskActiveCount = computed(() => diskRows.value.filter(row => !row.paused).length);
const diskVisibleRows = computed(() => (diskExpanded.value
    ? diskRows.value
    : diskRows.value.slice(0, DISK_COLLAPSED_ROWS)));

async function loadDisk(): Promise<void> {
    try {
        const response = await api.jobs.disk.$get();

        disk.value = (await response.json()).data;
    }
    catch {
        // 磁盘活动只是辅助信息：失败时保留上一次快照，不打断任务页
    }
}

function startDiskPolling(): void {
    if (diskTimer !== null) {
        return;
    }

    diskTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
            void loadDisk();
        }
    }, DISK_POLL_MS);
}

function stopDiskPolling(): void {
    if (diskTimer !== null) {
        clearInterval(diskTimer);
        diskTimer = null;
    }
}

/** 从后台切回时立刻补一次状态，避免等待下一个轮询/SSE 周期 */
function handleVisibility(): void {
    if (document.visibilityState === 'visible') {
        void load(true);
        void loadDisk();
    }
}

const IMPORT_STATUSES: readonly string[] = ['running', 'paused', 'completed', 'failed', 'cancelled'];

function readAiStatus(value: unknown, fallback: AiJobStatus): AiJobStatus {
    return typeof value === 'string' && IMPORT_STATUSES.includes(value) ? value as AiJobStatus : fallback;
}

function readNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function readImportStatus(value: unknown, fallback: ImportStatus): ImportStatus {
    return typeof value === 'string' && IMPORT_STATUSES.includes(value) ? value as ImportStatus : fallback;
}

const filterOptions = computed(() => [
    { value: 'all', label: t('jobs.all') },
    { value: 'import', label: t('jobs.import') },
    { value: 'download', label: t('jobs.download') },
    { value: 'ai', label: t('jobs.ai') },
]);

function statusLabel(status: string): string {
    const map: Record<string, string> = {
        queued: t('jobs.queued'),
        running: t('jobs.running'),
        downloading: t('jobs.running'),
        paused: t('jobs.paused'),
        completed: t('jobs.completed'),
        failed: t('jobs.failed'),
        cancelled: t('jobs.cancelled'),
    };

    return map[status] ?? status;
}

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' | 'brand' {
    if (status === 'completed') {
        return 'success';
    }
    if (status === 'failed') {
        return 'danger';
    }
    if (status === 'paused' || status === 'queued') {
        return 'warning';
    }
    if (status === 'cancelled') {
        return 'neutral';
    }

    return 'brand';
}

const ACTIVE_STATUSES = new Set(['running', 'downloading', 'queued', 'paused']);

const cards = computed<JobCard[]>(() => jobs.value
    .filter(job => (albumScope.value === '' || ('albumId' in job && job.albumId === albumScope.value))
      && (filter.value === 'all' || job.type === filter.value)
      && (!onlyActive.value || ACTIVE_STATUSES.has(job.status)))
    .map((job) => {
        if (job.type === 'import') {
            const percent = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

            return {
                key: `import:${job.id}`,
                type: 'import',
                title: job.albumName,
                subtitle: t('jobs.import'),
                status: job.status,
                updatedAt: job.updatedAt,
                percent,
                detail: t('jobs.progressFiles', { processed: job.processed, total: job.total }),
                extra: `${t('jobs.duplicates')} ${job.duplicates} · ${t('jobs.errors')} ${job.errors}`,
                error: job.error,
                albumId: job.albumId,
                jobId: job.id,
            };
        }

        if (job.type === 'ai') {
            const percent = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

            return {
                key: `ai:${job.id}`,
                type: 'ai',
                title: job.albumName,
                subtitle: t('jobs.ai'),
                status: job.status,
                updatedAt: job.updatedAt,
                percent,
                detail: t('jobs.progressFiles', { processed: job.processed, total: job.total }),
                extra: `${t('jobs.errors')} ${job.errors}`,
                error: job.error,
                albumId: job.albumId,
                jobId: job.id,
            };
        }

        const percent = job.totalBytes > 0 ? Math.round((job.bytesDone / job.totalBytes) * 100) : 0;

        return {
            key: `download:${job.modelId}`,
            type: 'download',
            title: job.name,
            subtitle: t('jobs.download'),
            status: job.status,
            updatedAt: job.updatedAt,
            percent,
            detail: t('jobs.downloadProgress', {
                done: formatBytes(job.bytesDone),
                total: formatBytes(job.totalBytes),
            }),
            extra: job.status === 'downloading'
                ? t('jobs.speedNow', { speed: `${formatBytes(job.speedBps)}/s` })
                : '',
            error: job.error,
            modelId: job.modelId,
        };
    }));

function progressStatus(card: JobCard): 'exception' | 'success' | 'active' | 'normal' {
    if (card.status === 'failed') {
        return 'exception';
    }
    if (card.status === 'completed') {
        return 'success';
    }
    // 只有真正在跑的任务才显示流动动画；排队/暂停保持静态
    if (card.status === 'running' || card.status === 'downloading') {
        return 'active';
    }

    return 'normal';
}

const CLEARABLE_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const clearableCards = computed(() => cards.value.filter(card => CLEARABLE_STATUSES.has(card.status)));

async function load(silent = false): Promise<void> {
    if (!silent) {
        loading.value = true;
    }

    error.value = '';

    try {
        const response = await api.jobs.$get({
            query: {
                limit: '200',
                ...(albumScope.value ? { albumId: albumScope.value } : {}),
            },
        });
        const body = await response.json();

        jobs.value = body.data;
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loading.value = false;
    }
}

function scheduleReload(): void {
    if (reloadTimer) {
        return;
    }

    reloadTimer = setTimeout(() => {
        reloadTimer = null;
        // 后台补齐列表时保留旧卡片，避免每次 SSE 重连都闪成 spinner
        void load(true);
        void loadDisk();
    }, 800);
}

function applyEvent(event: unknown): void {
    if (!event || typeof event !== 'object') {
        return;
    }

    const record = event as Record<string, unknown>;

    if (record.type === 'import' && typeof record.jobId === 'string') {
        let matched = false;

        jobs.value = jobs.value.map((job) => {
            if (job.type !== 'import' || job.id !== record.jobId) {
                return job;
            }

            matched = true;

            return {
                ...job,
                status: readImportStatus(record.status, job.status),
                total: readNumber(record.total, job.total),
                processed: readNumber(record.processed, job.processed),
                added: readNumber(record.added, job.added),
                duplicates: readNumber(record.duplicates, job.duplicates),
                skipped: readNumber(record.skipped, job.skipped),
                errors: readNumber(record.errors, job.errors),
                updatedAt: String(record.updatedAt ?? job.updatedAt),
            };
        });

        if (!matched) {
            scheduleReload();
        }
    }

    if (record.type === 'ai' && typeof record.jobId === 'string') {
        let matched = false;

        jobs.value = jobs.value.map((job): JobView => {
            if (job.type !== 'ai' || job.id !== record.jobId) {
                return job;
            }

            matched = true;

            return {
                ...job,
                status: readAiStatus(record.status, job.status),
                total: readNumber(record.total, job.total),
                processed: readNumber(record.processed, job.processed),
                errors: readNumber(record.errors, job.errors),
                updatedAt: String(record.updatedAt ?? job.updatedAt),
            };
        });

        if (!matched) {
            scheduleReload();
        }
    }

    if (record.type === 'download' && typeof record.modelId === 'string') {
        let matched = false;

        jobs.value = jobs.value.map((job) => {
            if (job.type !== 'download' || job.modelId !== record.modelId) {
                return job;
            }

            matched = true;

            return {
                ...job,
                status: String(record.status ?? job.status),
                bytesDone: Number(record.bytesDone ?? job.bytesDone),
                totalBytes: Number(record.totalBytes ?? job.totalBytes),
                speedBps: Number(record.speedBps ?? job.speedBps),
                updatedAt: String(record.updatedAt ?? job.updatedAt),
            };
        });

        if (!matched) {
            scheduleReload();
        }
    }
}

function eventKey(event: unknown): string {
    if (!event || typeof event !== 'object') {
        return '';
    }

    const record = event as Record<string, unknown>;

    return `${String(record.type ?? '')}:${String(record.jobId ?? record.modelId ?? '')}`;
}

function flushEvents(): void {
    eventFrame = 0;

    for (const event of pendingEvents.values()) {
        applyEvent(event);
    }

    pendingEvents.clear();
}

function queueEvent(event: unknown): void {
    const key = eventKey(event);

    if (key === '') {
        return;
    }

    // 同一任务在一个帧内只应用最后一次进度，避免下载/导入突发事件反复重渲染
    pendingEvents.set(key, event);

    if (eventFrame !== 0) {
        return;
    }

    if (import.meta.client) {
        eventFrame = requestAnimationFrame(flushEvents);
    }
}

function openEvents(): void {
    if (!import.meta.client) {
        return;
    }

    const query = albumScope.value ? `?albumId=${encodeURIComponent(albumScope.value)}` : '';

    source = new EventSource(`/api/v1/jobs/events${query}`);

    source.addEventListener('snapshot', (event) => {
        jobs.value = JSON.parse((event as MessageEvent).data) as JobView[];
        loading.value = false;
    });

    source.addEventListener('job', (event) => {
        queueEvent(JSON.parse((event as MessageEvent).data));
    });

    source.onerror = () => {
        scheduleReload();
    };
}

async function run(key: string, action: () => Promise<unknown>): Promise<void> {
    busy.value = { ...busy.value, [key]: true };
    error.value = '';

    try {
        await action();
        await load();
    }
    catch (actionError) {
        error.value = errorMessage(actionError);
    }
    finally {
        busy.value = { ...busy.value, [key]: false };
    }
}

function pauseImport(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].imports[':jobId'].pause.$post({
        param: { albumId, jobId },
    }));
}

function resumeImport(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].imports[':jobId'].resume.$post({
        param: { albumId, jobId },
    }));
}

function cancelImport(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].imports[':jobId'].cancel.$post({
        param: { albumId, jobId },
    }));
}

function pauseDownload(card: JobCard): void {
    const modelId = card.modelId;

    if (!modelId) {
        return;
    }

    void run(card.key, () => api.models[':modelId'].download.pause.$post({ param: { modelId } }));
}

function resumeDownload(card: JobCard): void {
    const modelId = card.modelId;

    if (!modelId) {
        return;
    }

    void run(card.key, () => api.models[':modelId'].download.resume.$post({ param: { modelId } }));
}

function cancelDownload(card: JobCard): void {
    const modelId = card.modelId;

    if (!modelId) {
        return;
    }

    void run(card.key, () => api.models[':modelId'].download.cancel.$post({ param: { modelId } }));
}

function pauseAi(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].ai.jobs[':jobId'].pause.$post({
        param: { albumId, jobId },
    }));
}

function resumeAi(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].ai.jobs[':jobId'].resume.$post({
        param: { albumId, jobId },
    }));
}

function cancelAi(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    void run(card.key, () => api.albums[':albumId'].ai.jobs[':jobId'].cancel.$post({
        param: { albumId, jobId },
    }));
}

function canDelete(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

async function clearCurrentTab(): Promise<void> {
    busy.value = { ...busy.value, clear: true };
    error.value = '';
    notice.value = '';

    try {
        const response = await api.jobs.clear.$post({
            json: {
                ...(filter.value === 'all' ? {} : { type: filter.value }),
                ...(albumScope.value ? { albumId: albumScope.value } : {}),
                confirm: true,
            },
        });
        const result = (await response.json()).data;

        notice.value = t('jobs.cleared', { count: result.removed });
        await load();
    }
    catch (clearError) {
        error.value = errorMessage(clearError);
    }
    finally {
        busy.value = { ...busy.value, clear: false };
    }
}

function removeJob(card: JobCard): void {
    const albumId = card.albumId;
    const jobId = card.jobId;

    if (!albumId || !jobId) {
        return;
    }

    if (card.type === 'import') {
        void run(card.key, () => api.albums[':albumId'].imports[':jobId'].$delete({
            param: { albumId, jobId },
        }));

        return;
    }

    if (card.type === 'ai') {
        void run(card.key, () => api.albums[':albumId'].ai.jobs[':jobId'].$delete({
            param: { albumId, jobId },
        }));
    }
}

onMounted(() => {
    void load();
    void loadDisk();
    startDiskPolling();
    openEvents();
    document.addEventListener('visibilitychange', handleVisibility);
});

onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibility);
    stopDiskPolling();
    source?.close();
    source = null;
    pendingEvents.clear();

    if (reloadTimer) {
        clearTimeout(reloadTimer);
    }
    if (eventFrame !== 0) {
        cancelAnimationFrame(eventFrame);
        eventFrame = 0;
    }
});
</script>

<template>
    <div class="px-page jobs-page">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p v-if="!embedded" class="px-page-header__eyebrow">
                    PICTUREX
                </p>
                <h1 class="px-page-title">
                    {{ t('jobs.title') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('jobs.subtitle') }}
                </p>
            </div>
            <div class="jobs-actions">
                <NuxtLink v-if="albumScope && !embedded" to="/jobs">
                    <a-tag color="processing" closable @close.prevent>
                        {{ t('jobs.albumScope') }}
                    </a-tag>
                </NuxtLink>
                <a-button :aria-label="t('common.refresh')" @click="load()">
                    <template #icon>
                        <ReloadOutlined />
                    </template>
                </a-button>
            </div>
        </header>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''">
            <template #action>
                <a-button size="small" @click="load()">
                    {{ t('common.retry') }}
                </a-button>
            </template>
        </a-alert>
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <section class="disk-activity px-surface" :aria-label="t('jobs.diskTitle')">
            <header class="disk-activity__head">
                <h2 class="disk-activity__title">
                    <HddOutlined />
                    {{ t('jobs.diskTitle') }}
                </h2>
                <span
                    class="disk-activity__summary"
                    :class="{ 'disk-activity__summary--idle': diskActiveCount === 0 }"
                >
                    {{ diskActiveCount === 0 ? t('jobs.diskIdle') : t('jobs.diskActive', { count: diskActiveCount }) }}
                </span>
                <a-button
                    v-if="diskRows.length > DISK_COLLAPSED_ROWS"
                    size="small"
                    type="text"
                    @click="diskExpanded = !diskExpanded"
                >
                    {{ diskExpanded ? t('jobs.diskCollapse') : t('jobs.diskExpand', { count: diskRows.length - DISK_COLLAPSED_ROWS }) }}
                </a-button>
            </header>

            <ul v-if="diskVisibleRows.length > 0" class="disk-activity__list">
                <li v-for="row in diskVisibleRows" :key="row.key" class="disk-activity__row">
                    <span class="disk-activity__icon" :class="`disk-activity__icon--${row.kind}`">
                        <SyncOutlined v-if="row.kind === 'import'" />
                        <ThunderboltOutlined v-else-if="row.kind === 'ai'" />
                        <PictureOutlined v-else-if="row.kind === 'thumbnail'" />
                        <FireOutlined v-else-if="row.kind === 'warmup'" />
                        <ScanOutlined v-else-if="row.kind === 'similarity'" />
                        <ToolOutlined v-else-if="row.kind === 'maintenance'" />
                        <CloudDownloadOutlined v-else-if="row.kind === 'model'" />
                        <DatabaseOutlined v-else />
                    </span>
                    <span class="disk-activity__label">{{ row.label }}</span>
                    <span v-if="row.albumName" class="disk-activity__album">{{ row.albumName }}</span>
                    <span class="disk-activity__touch">{{ row.touchLabel }}</span>
                    <span v-if="row.percent !== null" class="disk-activity__bar">
                        <a-progress :percent="row.percent" size="small" :show-info="false" />
                    </span>
                    <span v-if="row.counter !== ''" class="disk-activity__counter">{{ row.counter }}</span>
                    <a-tag v-if="row.queued > 0" color="processing">
                        {{ t('jobs.diskQueued', { count: row.queued }) }}
                    </a-tag>
                    <a-tag v-if="row.paused" color="warning">
                        {{ t('jobs.paused') }}
                    </a-tag>
                </li>
            </ul>

            <p class="disk-activity__hint">
                {{ t('jobs.diskHint', {
                    concurrency: disk?.thumbnails.interactiveConcurrency ?? 0,
                    ms: disk?.thumbnails.ewmaMs ?? 0,
                }) }}
            </p>
        </section>

        <div class="jobs-toolbar">
            <a-segmented v-model:value="filter" :options="filterOptions" />
            <a-checkbox v-model:checked="onlyActive">
                {{ t('jobs.onlyActive') }}
            </a-checkbox>
            <a-popconfirm
                v-if="clearableCards.length > 0"
                :title="t('jobs.clearTabConfirm', { count: clearableCards.length })"
                :ok-text="t('common.delete')"
                :cancel-text="t('common.cancel')"
                @confirm="clearCurrentTab"
            >
                <a-button danger :loading="busy.clear">
                    {{ t('jobs.clearTab', { count: clearableCards.length }) }}
                </a-button>
            </a-popconfirm>
        </div>

        <div v-if="loading" class="jobs-loading">
            <a-spin />
        </div>

        <div v-else-if="cards.length === 0" class="jobs-empty px-surface">
            <a-empty :description="t('jobs.empty')">
                <p class="jobs-empty__hint">
                    {{ t('jobs.emptyHint') }}
                </p>
            </a-empty>
        </div>

        <div v-else class="jobs-list">
            <article
                v-for="card in cards"
                :key="card.key"
                class="job-card px-surface"
            >
                <header class="job-card__head">
                    <span class="job-card__icon" :class="`job-card__icon--${card.type}`">
                        <SyncOutlined v-if="card.type === 'import'" />
                        <CloudDownloadOutlined v-else-if="card.type === 'download'" />
                        <ThunderboltOutlined v-else />
                    </span>
                    <div class="job-card__title">
                        <div class="job-card__title-row">
                            <h2 class="job-card__name">
                                {{ card.title }}
                            </h2>
                            <span class="job-card__status" :class="`job-card__status--${statusTone(card.status)}`">
                                <span class="job-card__status-dot" aria-hidden="true" />
                                {{ statusLabel(card.status) }}
                            </span>
                        </div>
                        <p class="job-card__subtitle">
                            {{ card.subtitle }}
                            <span aria-hidden="true">·</span>
                            {{ formatDateTime(card.updatedAt) }}
                        </p>
                    </div>
                </header>

                <div class="job-card__progress-row">
                    <a-progress
                        :percent="card.percent"
                        :status="progressStatus(card)"
                        :show-info="false"
                        size="small"
                    />
                    <span class="job-card__percent">{{ card.percent }}%</span>
                </div>

                <div class="job-card__meta">
                    <span>{{ card.detail }}</span>
                    <span v-if="card.extra">{{ card.extra }}</span>
                </div>

                <p v-if="card.status === 'failed' && card.error" class="job-card__error px-selectable">
                    {{ card.error }}
                </p>

                <footer class="job-card__footer">
                    <div class="job-card__links">
                        <NuxtLink v-if="card.albumId" :to="`/albums/${card.albumId}`" class="job-card__link">
                            {{ t('jobs.openAlbum') }}
                        </NuxtLink>
                        <NuxtLink v-else-if="card.type === 'download'" to="/settings/models" class="job-card__link">
                            {{ t('jobs.openModels') }}
                        </NuxtLink>
                    </div>
                    <div class="job-card__actions">
                        <template v-if="card.type === 'import'">
                            <a-button
                                v-if="card.status === 'running'"
                                :loading="busy[card.key]"
                                @click="pauseImport(card)"
                            >
                                <template #icon>
                                    <PauseCircleOutlined />
                                </template>
                                {{ t('jobs.pause') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'paused'"
                                type="primary"
                                :loading="busy[card.key]"
                                @click="resumeImport(card)"
                            >
                                <template #icon>
                                    <PlayCircleOutlined />
                                </template>
                                {{ t('jobs.resumeImport') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'running' || card.status === 'paused'"
                                danger
                                :loading="busy[card.key]"
                                @click="cancelImport(card)"
                            >
                                <template #icon>
                                    <StopOutlined />
                                </template>
                                {{ t('jobs.cancel') }}
                            </a-button>
                            <a-popconfirm
                                v-if="canDelete(card.status)"
                                :title="t('jobs.deleteJobConfirm')"
                                :ok-text="t('jobs.deleteTask')"
                                :cancel-text="t('common.cancel')"
                                @confirm="removeJob(card)"
                            >
                                <a-button danger type="text" :loading="busy[card.key]">
                                    <template #icon>
                                        <DeleteOutlined />
                                    </template>
                                    {{ t('jobs.deleteTask') }}
                                </a-button>
                            </a-popconfirm>
                        </template>

                        <template v-else-if="card.type === 'ai'">
                            <a-button
                                v-if="card.status === 'running'"
                                :loading="busy[card.key]"
                                @click="pauseAi(card)"
                            >
                                <template #icon>
                                    <PauseCircleOutlined />
                                </template>
                                {{ t('jobs.pause') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'paused'"
                                type="primary"
                                :loading="busy[card.key]"
                                @click="resumeAi(card)"
                            >
                                <template #icon>
                                    <PlayCircleOutlined />
                                </template>
                                {{ t('jobs.resume') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'running' || card.status === 'paused'"
                                danger
                                :loading="busy[card.key]"
                                @click="cancelAi(card)"
                            >
                                <template #icon>
                                    <StopOutlined />
                                </template>
                                {{ t('jobs.cancel') }}
                            </a-button>
                            <a-popconfirm
                                v-if="canDelete(card.status)"
                                :title="t('jobs.deleteJobConfirm')"
                                :ok-text="t('jobs.deleteTask')"
                                :cancel-text="t('common.cancel')"
                                @confirm="removeJob(card)"
                            >
                                <a-button danger type="text" :loading="busy[card.key]">
                                    <template #icon>
                                        <DeleteOutlined />
                                    </template>
                                    {{ t('jobs.deleteTask') }}
                                </a-button>
                            </a-popconfirm>
                        </template>

                        <template v-else-if="card.type === 'download'">
                            <a-button
                                v-if="card.status === 'downloading'"
                                :loading="busy[card.key]"
                                @click="pauseDownload(card)"
                            >
                                <template #icon>
                                    <PauseCircleOutlined />
                                </template>
                                {{ t('jobs.pause') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'paused'"
                                type="primary"
                                :loading="busy[card.key]"
                                @click="resumeDownload(card)"
                            >
                                <template #icon>
                                    <PlayCircleOutlined />
                                </template>
                                {{ t('models.resume') }}
                            </a-button>
                            <a-button
                                v-if="card.status === 'downloading' || card.status === 'paused'"
                                danger
                                :loading="busy[card.key]"
                                @click="cancelDownload(card)"
                            >
                                <template #icon>
                                    <StopOutlined />
                                </template>
                                {{ t('models.cancel') }}
                            </a-button>
                        </template>
                    </div>
                </footer>
            </article>
        </div>
    </div>
</template>

<style scoped>
.jobs-page {
    max-width: var(--px-layout-content-narrow);
}

.jobs-actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.jobs-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.jobs-loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-16);
}

.jobs-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--px-space-16);
}

.jobs-empty__hint {
    margin: var(--px-space-1) 0 0;
    color: var(--px-color-text-secondary);
}

.jobs-list {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
}

.job-card {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding: var(--px-space-3);
    transition: box-shadow var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.job-card:hover {
    box-shadow: var(--px-shadow-float);
}

.job-card__head {
    display: flex;
    align-items: flex-start;
    gap: var(--px-space-2);
}

.job-card__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    border-radius: var(--px-radius-sm);
    font-size: var(--px-font-size-body);
}

.job-card__icon--import {
    background: var(--px-color-brand-soft);
    color: var(--px-color-brand);
}

.job-card__icon--ai {
    background: color-mix(in srgb, var(--px-color-warning) 12%, transparent);
    color: var(--px-color-warning);
}

.job-card__icon--download {
    background: color-mix(in srgb, var(--px-color-info) 12%, transparent);
    color: var(--px-color-info);
}

.job-card__title {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    flex: 1;
    min-width: 0;
}

.job-card__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-2);
    min-width: 0;
}

.job-card__name {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
    color: var(--px-color-text-primary);
}

.job-card__status {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: var(--px-space-1);
    height: var(--px-space-5);
    padding: 0 var(--px-space-2);
    border-radius: var(--px-radius-full);
    font-size: var(--px-font-size-micro);
    font-weight: var(--px-font-weight-medium);
    line-height: 1;
}

.job-card__status-dot {
    width: var(--px-space-1);
    height: var(--px-space-1);
    border-radius: var(--px-radius-full);
    background: currentColor;
}

.job-card__status--success {
    background: color-mix(in srgb, var(--px-color-success) 12%, transparent);
    color: var(--px-color-success);
}

.job-card__status--danger {
    background: color-mix(in srgb, var(--px-color-danger) 12%, transparent);
    color: var(--px-color-danger);
}

.job-card__status--warning {
    background: color-mix(in srgb, var(--px-color-warning) 12%, transparent);
    color: var(--px-color-warning);
}

.job-card__status--neutral {
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
}

.job-card__status--brand {
    background: var(--px-color-brand-soft);
    color: var(--px-color-brand);
}

.job-card__subtitle {
    margin: 0;
    display: flex;
    gap: var(--px-space-1);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.job-card__progress-row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.job-card__progress-row :deep(.ant-progress) {
    flex: 1;
    margin: 0;
}

.job-card__percent {
    flex: none;
    min-width: var(--px-space-8);
    text-align: right;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
    font-family: var(--px-font-family-mono);
}

.job-card__meta {
    display: flex;
    justify-content: space-between;
    gap: var(--px-space-3);
    flex-wrap: wrap;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.job-card__error {
    margin: 0;
    padding: var(--px-space-1) var(--px-space-2);
    border-radius: var(--px-radius-sm);
    background: color-mix(in srgb, var(--px-color-danger) 10%, transparent);
    color: var(--px-color-danger);
    font-size: var(--px-font-size-caption);
    overflow-wrap: anywhere;
}

.job-card__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.job-card__links {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.job-card__link {
    color: var(--px-color-brand);
    font-size: var(--px-font-size-caption);
    font-weight: var(--px-font-weight-medium);
    text-decoration: none;
}

.job-card__link:hover {
    color: var(--px-color-brand-hover);
}

.job-card__actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.job-card__actions :deep(.ant-btn) {
    height: var(--px-control-height-sm);
    padding-inline: var(--px-space-2);
    font-size: var(--px-font-size-caption);
}

.job-card__actions:empty {
    display: none;
}

.disk-activity {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    margin-bottom: var(--px-space-4);
    padding: var(--px-space-3) var(--px-space-4);
    border-radius: var(--px-radius-lg);
}

.disk-activity__head {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
}

.disk-activity__title {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-2);
    margin: 0;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-subtitle);
    font-weight: var(--px-font-weight-medium);
}

.disk-activity__summary {
    color: var(--px-color-brand);
    font-size: var(--px-font-size-caption);
}

.disk-activity__summary--idle {
    color: var(--px-color-text-tertiary);
}

.disk-activity__head :deep(.ant-btn) {
    margin-inline-start: auto;
    height: var(--px-control-height-sm);
    font-size: var(--px-font-size-caption);
}

.disk-activity__list {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
}

.disk-activity__row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    padding: var(--px-space-1) 0;
    border-radius: var(--px-radius-sm);
    font-size: var(--px-font-size-caption);
}

.disk-activity__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-space-6);
    color: var(--px-color-brand);
}

.disk-activity__icon--warmup,
.disk-activity__icon--maintenance {
    color: var(--px-color-warning);
}

.disk-activity__label {
    flex: none;
    color: var(--px-color-text-primary);
}

.disk-activity__album {
    max-width: var(--px-space-16);
    overflow: hidden;
    color: var(--px-color-text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.disk-activity__touch {
    flex: none;
    padding-inline: var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
}

.disk-activity__bar {
    flex: 1;
    min-width: var(--px-space-16);
}

.disk-activity__bar :deep(.ant-progress) {
    margin: 0;
    line-height: 1;
}

.disk-activity__counter {
    flex: none;
    color: var(--px-color-text-secondary);
    font-family: var(--px-font-family-mono);
}

.disk-activity__hint {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}
</style>
