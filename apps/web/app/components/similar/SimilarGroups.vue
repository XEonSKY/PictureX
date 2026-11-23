<script setup lang="ts">
import type { SimilarAssetDto, SimilarGroupDto } from '~/utils/similar-groups';

const props = defineProps<{
    albumId: string
}>();

const emit = defineEmits<{
    changed: []
}>();

const { t } = useI18n();
const api = useApi();
const router = useRouter();
const { formatBytes } = useFormat();

const groups = ref<SimilarGroupDto[]>([]);
// 每组的最佳项只算一次；模板里 v-for 内反复调用 bestOf 会 O(n² log n)
const bestByGroup = computed(() => new Map(groups.value.map(group => [
    group.representativeId,
    bestOf(group)?.id ?? '',
])));
const threshold = ref(8);
const loading = ref(true);
const rebuilding = ref(false);
const error = ref('');
const selected = ref<Set<string>>(new Set());
const deleting = ref(false);
const indexed = ref(0);
const indexedTotal = ref(0);
const savedThreshold = ref<number | null>(null);
const batch = ref({ total: 0, done: 0 });
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let thresholdTimer: ReturnType<typeof setTimeout> | null = null;

const progressPercent = computed(() => (
    indexedTotal.value > 0 ? Math.min(100, Math.round((indexed.value / indexedTotal.value) * 100)) : 0
));
const batchPercent = computed(() => (
    batch.value.total > 0 ? Math.round((batch.value.done / batch.value.total) * 100) : 0
));

async function triggerRebuild(): Promise<void> {
    try {
        await api.albums[':albumId'].similarity.rebuild.$post({
            param: { albumId: props.albumId },
            json: savedThreshold.value === null ? {} : { threshold: threshold.value },
        });
    }
    catch (rebuildError) {
        // 触发失败不阻断浏览：下一次进入/轮询会再试
        error.value = errorMessage(rebuildError);
    }
}

function toggle(id: string): void {
    const next = new Set(selected.value);

    if (next.has(id)) {
        next.delete(id);
    }
    else {
        next.add(id);
    }

    selected.value = next;
}

function bestOf(group: SimilarGroupDto): SimilarAssetDto | undefined {
    return [...group.assets].sort((a, b) => {
        const areaA = (a.width ?? 0) * (a.height ?? 0);
        const areaB = (b.width ?? 0) * (b.height ?? 0);

        return areaB - areaA || b.size - a.size;
    })[0];
}

async function load(silent = false): Promise<void> {
    if (!silent) {
        loading.value = true;
        error.value = '';
        selected.value = new Set();
    }

    try {
        const response = await api.albums[':albumId'].groups.similar.$get({
            param: { albumId: props.albumId },
            // 首次打开不传阈值，由服务端解析「相册覆盖 → 全局默认」；用户拖动后才显式带上
            query: savedThreshold.value === null
                ? { limit: '100' }
                : { limit: '100', threshold: String(threshold.value) },
        });
        const body = await response.json();

        groups.value = body.data;
        threshold.value = body.meta.threshold;
        savedThreshold.value = body.meta.threshold;
        rebuilding.value = Boolean(body.meta.rebuilding);
        indexed.value = Number(body.meta.phashedCount ?? 0);
        indexedTotal.value = Number(body.meta.assetCount ?? 0);

        if (rebuilding.value) {
            // 索引不新鲜时由前端显式 POST 触发重建（GET 不再写库）；轮询只读进度
            if (!silent) {
                await triggerRebuild();
            }

            schedulePoll();
        }
    }
    catch (loadError) {
        if (!silent) {
            error.value = errorMessage(loadError);
        }
    }
    finally {
        if (!silent) {
            loading.value = false;
        }
    }
}

function schedulePoll(): void {
    if (pollTimer) {
        return;
    }

    pollTimer = setTimeout(() => {
        pollTimer = null;
        void load(true);
    }, 1500);
}

async function deleteAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) {
        return;
    }

    deleting.value = true;
    error.value = '';
    batch.value = { total: ids.length, done: 0 };

    try {
        await api.albums[':albumId'].assets['batch-delete'].$post({
            param: { albumId: props.albumId },
            json: { ids, confirm: true },
        });
        batch.value = { total: ids.length, done: ids.length };
        await load();
        emit('changed');
    }
    catch (deleteError) {
        error.value = errorMessage(deleteError);
        await load();
    }
    finally {
        deleting.value = false;
        batch.value = { total: 0, done: 0 };
    }
}

function openAsset(asset: SimilarAssetDto, group: SimilarGroupDto): void {
    void router.push({
        path: `/albums/${props.albumId}/assets/${asset.id}`,
        query: { from: 'similar', group: group.id },
    });
}

async function persistThreshold(): Promise<void> {
    if (savedThreshold.value === threshold.value) {
        return;
    }

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: props.albumId },
            json: { settings: { similarityThreshold: threshold.value } },
        });
        savedThreshold.value = threshold.value;
        emit('changed');
    }
    catch (saveError) {
        error.value = errorMessage(saveError);
    }
}

function keepBest(group: SimilarGroupDto): void {
    const best = bestOf(group);

    if (!best) {
        return;
    }

    void deleteAssets(group.assets.filter(asset => asset.id !== best.id).map(asset => asset.id));
}

watch(threshold, () => {
    // 服务端回填（或与已保存值一致）时不触发重建与写库
    if (threshold.value === savedThreshold.value) {
        return;
    }

    if (thresholdTimer) {
        clearTimeout(thresholdTimer);
    }

    thresholdTimer = setTimeout(() => {
        thresholdTimer = null;
        void load();
        void persistThreshold();
    }, 300);
});

onMounted(load);

onBeforeUnmount(() => {
    if (pollTimer) {
        clearTimeout(pollTimer);
    }
    if (thresholdTimer) {
        clearTimeout(thresholdTimer);
    }
});
</script>

<template>
    <div class="similar">
        <div class="similar__toolbar">
            <label class="similar__threshold">
                <span>{{ t('asset.threshold') }}</span>
                <a-slider v-model:value="threshold" :min="0" :max="64" :step="1" class="similar__slider" />
                <span class="similar__value">{{ threshold }}</span>
            </label>
            <a-popconfirm
                :title="t('asset.batchDeleteAssetsConfirm', { count: selected.size })"
                :ok-text="t('common.delete')"
                :cancel-text="t('common.cancel')"
                :disabled="selected.size === 0"
                @confirm="deleteAssets([...selected])"
            >
                <a-button danger :disabled="selected.size === 0" :loading="deleting">
                    {{ t('asset.deleteSelected') }} ({{ selected.size }})
                </a-button>
            </a-popconfirm>
        </div>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''">
            <template #action>
                <a-button size="small" @click="load(false)">
                    {{ t('common.retry') }}
                </a-button>
            </template>
        </a-alert>

        <div v-if="deleting && batch.total > 0" class="similar__progress px-surface">
            <a-progress
                :percent="batchPercent"
                size="small"
                :format="() => `${batch.done} / ${batch.total}`"
            />
        </div>

        <div v-if="rebuilding" class="similar__progress px-surface">
            <div class="similar__progress-head">
                <span>{{ t('album.similarComputing') }}</span>
                <span class="similar__progress-count">{{ indexed }} / {{ indexedTotal }}</span>
            </div>
            <a-progress :percent="progressPercent" size="small" :show-info="false" />
        </div>

        <div v-if="loading" class="similar__loading">
            <a-spin />
        </div>

        <a-empty v-else-if="groups.length === 0" :description="t('album.noSimilar')" />

        <template v-else>
            <section v-for="group in groups" :key="group.representativeId" class="similar-group px-surface">
                <header class="similar-group__header">
                    <span>{{ t('album.similarTitle') }} · {{ group.assets.length }}</span>
                    <a-popconfirm
                        :title="t('asset.batchDeleteAssetsConfirm', { count: group.assets.length - 1 })"
                        :ok-text="t('common.delete')"
                        :cancel-text="t('common.cancel')"
                        @confirm="keepBest(group)"
                    >
                        <a-button size="small" :loading="deleting">
                            {{ t('asset.keepBest') }}
                        </a-button>
                    </a-popconfirm>
                </header>

                <div class="similar-group__grid">
                    <figure
                        v-for="asset in group.assets"
                        :key="asset.id"
                        class="similar-item"
                        :class="{ 'similar-item--best': bestByGroup.get(group.representativeId) === asset.id }"
                    >
                        <div class="similar-item__media">
                            <button
                                type="button"
                                class="similar-item__open"
                                :aria-label="t('asset.openViewer')"
                                @click="openAsset(asset, group)"
                            >
                                <AssetThumbImage
                                    class="similar-item__image"
                                    :album-id="albumId"
                                    :asset-id="asset.id"
                                    :alt="asset.displayName"
                                    :width="220"
                                />
                            </button>
                            <a-checkbox
                                class="similar-item__check"
                                :checked="selected.has(asset.id)"
                                @change="toggle(asset.id)"
                            />
                            <span v-if="bestByGroup.get(group.representativeId) === asset.id" class="similar-item__badge">
                                {{ t('asset.best') }}
                            </span>
                        </div>
                        <figcaption class="similar-item__meta">
                            <span class="similar-item__name" :title="asset.filename">{{ asset.displayName }}</span>
                            <span class="similar-item__sub">
                                {{ t('asset.distanceValue', { distance: asset.distance }) }}
                                · {{ formatBytes(asset.size) }}
                            </span>
                        </figcaption>
                    </figure>
                </div>
            </section>
        </template>
    </div>
</template>

<style scoped>
.similar {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-4);
}

.similar__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.similar__threshold {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    flex: 1;
    min-width: calc(var(--px-layout-card-min) * 1.4);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}

.similar__slider {
    flex: 1;
    min-width: calc(var(--px-layout-card-min) / 2);
}

.similar__value {
    min-width: var(--px-space-6);
    text-align: right;
    font-family: var(--px-font-family-mono);
    color: var(--px-color-brand);
}

.similar__loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-10);
}

.similar__progress {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding: var(--px-space-3) var(--px-space-4);
}

.similar__progress-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.similar__progress-count {
    font-family: var(--px-font-family-mono);
    color: var(--px-color-text-tertiary);
}

.similar-group {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
    padding: var(--px-space-4);
}

.similar-group__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.similar-group__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--px-layout-card-min) / 2), 1fr));
    gap: var(--px-space-3);
}

.similar-item {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-sm);
    overflow: hidden;
    background: var(--px-color-bg-surface);
}

.similar-item--best {
    border-color: var(--px-color-brand);
}

.similar-item__media {
    position: relative;
    aspect-ratio: 4 / 3;
    background: var(--px-color-bg-sunken);
}

.similar-item__open {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
}

.similar-item__open:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.similar-item__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.similar-item__check {
    position: absolute;
    top: var(--px-space-2);
    left: var(--px-space-2);
    padding: var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: color-mix(in srgb, var(--px-color-bg-surface) 86%, transparent);
}

.similar-item__badge {
    position: absolute;
    top: var(--px-space-2);
    right: var(--px-space-2);
    padding: 0 var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: var(--px-color-brand);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
}

.similar-item__meta {
    display: flex;
    flex-direction: column;
    padding: var(--px-space-1) var(--px-space-2) var(--px-space-2);
}

.similar-item__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-font-size-caption);
}

.similar-item__sub {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
}
</style>
