<script setup lang="ts">
import type { AssetSummaryDto } from '~~/server/domain/asset-query';

definePageMeta({
    layout: 'album',
});

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const { formatDateTime } = useFormat();

const albumId = computed(() => String(route.params.id ?? ''));
const { album, load: loadContext } = useAlbumContext(albumId);

const selected = ref<Set<string>>(new Set());
const {
    items: assets,
    loading,
    error,
    hasMore,
    load: loadMore,
} = useCursorFeed<AssetSummaryDto>({
    fetchPage: async (nextCursor) => {
        const response = await api.albums[':albumId'].assets.$get({
            param: { albumId: albumId.value },
            query: {
                trash: 'true',
                limit: '120',
                ...(nextCursor ? { cursor: nextCursor } : {}),
            },
        });
        const body = await response.json();

        return {
            items: body.data,
            nextCursor: body.pagination.nextCursor,
            hasMore: body.pagination.hasMore,
        };
    },
    onReset: () => {
        selected.value = new Set();
    },
});
const notice = ref('');
const busyId = ref('');
const purgingAll = ref(false);
const batchBusy = ref(false);

const title = computed(() => t('album.trashTitle'));

async function restore(asset: AssetSummaryDto): Promise<void> {
    busyId.value = asset.id;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].assets[':assetId'].restore.$post({
            param: { albumId: albumId.value, assetId: asset.id },
        });
        assets.value = assets.value.filter(item => item.id !== asset.id);
        selected.value = new Set([...selected.value].filter(id => id !== asset.id));
        notice.value = t('album.restored');
        await loadContext(true);
    }
    catch (restoreError) {
        error.value = errorMessage(restoreError);
    }
    finally {
        busyId.value = '';
    }
}

async function purge(asset: AssetSummaryDto): Promise<void> {
    busyId.value = asset.id;
    error.value = '';
    notice.value = '';

    try {
        await api.albums[':albumId'].trash[':assetId'].$delete({
            param: { albumId: albumId.value, assetId: asset.id },
        });
        assets.value = assets.value.filter(item => item.id !== asset.id);
        selected.value = new Set([...selected.value].filter(id => id !== asset.id));
        notice.value = t('album.purgeDone', { count: 1 });
    }
    catch (purgeError) {
        error.value = errorMessage(purgeError);
        await loadMore(true);
    }
    finally {
        busyId.value = '';
    }
}

function clearSelection(): void {
    selected.value = new Set();
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

async function restoreSelected(): Promise<void> {
    const ids = [...selected.value];

    if (ids.length === 0) {
        return;
    }

    batchBusy.value = true;
    error.value = '';

    try {
        let restored = 0;

        for (let index = 0; index < ids.length; index += 1000) {
            const response = await api.albums[':albumId'].assets['batch-restore'].$post({
                param: { albumId: albumId.value },
                json: { ids: ids.slice(index, index + 1000) },
            });
            const body = await response.json();

            restored += body.data.restored;
        }

        selected.value = new Set();
        notice.value = t('album.restoreDone', { count: restored });
        await Promise.all([loadMore(true), loadContext(true)]);
    }
    catch (restoreError) {
        error.value = errorMessage(restoreError);
        await loadMore(true);
    }
    finally {
        batchBusy.value = false;
    }
}

async function purgeSelected(): Promise<void> {
    const ids = [...selected.value];

    if (ids.length === 0) {
        return;
    }

    batchBusy.value = true;
    error.value = '';

    try {
        let removed = 0;
        let failed = 0;

        for (let index = 0; index < ids.length; index += 1000) {
            const response = await api.albums[':albumId'].trash['batch-purge'].$post({
                param: { albumId: albumId.value },
                json: { ids: ids.slice(index, index + 1000), confirm: true },
            });
            const body = await response.json();

            removed += body.data.removed;
            failed += body.data.failed;
        }

        selected.value = new Set();
        await loadMore(true);
        notice.value = t('album.purgeDone', { count: removed });

        if (failed > 0) {
            error.value = t('album.purgePartial', { removed, failed });
        }
    }
    catch (purgeError) {
        error.value = errorMessage(purgeError);
        await loadMore(true);
    }
    finally {
        batchBusy.value = false;
    }
}

async function purgeAll(): Promise<void> {
    purgingAll.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.albums[':albumId'].trash.purge.$post({
            param: { albumId: albumId.value },
            json: { confirm: true },
        });
        const body = await response.json();

        selected.value = new Set();
        await loadMore(true);
        notice.value = t('album.purgeDone', { count: body.data.removed });

        if (body.data.failed > 0) {
            error.value = t('album.purgePartial', { removed: body.data.removed, failed: body.data.failed });
        }
    }
    catch (purgeError) {
        error.value = errorMessage(purgeError);
        await loadMore(true);
    }
    finally {
        purgingAll.value = false;
    }
}

useHead({
    title: () => `${title.value} · ${album.value?.name ?? ''} · PictureX`,
});

onMounted(() => {
    void loadMore(true);
});
</script>

<template>
    <div class="px-page">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    {{ album?.name ?? '' }}
                </p>
                <h1 class="px-page-title">
                    {{ title }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('album.trashSubtitle') }}
                </p>
            </div>
            <a-popconfirm
                v-if="assets.length > 0"
                :title="t('album.cleanTrashConfirm')"
                :ok-text="t('common.confirm')"
                :cancel-text="t('common.cancel')"
                @confirm="purgeAll"
            >
                <a-button danger :loading="purgingAll">
                    {{ t('album.cleanTrash') }}
                </a-button>
            </a-popconfirm>
        </header>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''">
            <template #action>
                <a-button size="small" @click="loadMore(true)">
                    {{ t('common.retry') }}
                </a-button>
            </template>
        </a-alert>
        <a-alert v-else-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <p class="px-hint">
            {{ t('album.trashHint') }}
        </p>

        <div v-if="selected.size > 0" class="trash-batch px-surface">
            <span class="trash-batch__count">
                {{ t('asset.selectedCount', { count: selected.size }) }}
            </span>
            <a-button size="small" :loading="batchBusy" @click="restoreSelected">
                {{ t('album.restore') }}
            </a-button>
            <a-popconfirm
                :title="t('album.batchPurgeConfirm', { count: selected.size })"
                :ok-text="t('common.confirm')"
                :cancel-text="t('common.cancel')"
                @confirm="purgeSelected"
            >
                <a-button size="small" danger :loading="batchBusy">
                    {{ t('album.purge') }}
                </a-button>
            </a-popconfirm>
            <a-button size="small" type="text" @click="clearSelection">
                {{ t('common.cancel') }}
            </a-button>
        </div>

        <div v-if="loading && assets.length === 0" class="trash-loading">
            <a-spin />
        </div>

        <a-empty v-else-if="assets.length === 0" :description="t('album.trashEmpty')" />

        <div v-else class="trash-grid">
            <article
                v-for="item in assets"
                :key="item.id"
                class="trash-card"
                :class="{ 'trash-card--selected': selected.has(item.id) }"
            >
                <a-checkbox
                    class="trash-card__check"
                    :checked="selected.has(item.id)"
                    :aria-label="t('a11y.selectAsset', { name: item.filename })"
                    @change="toggle(item.id)"
                />
                <AssetThumbImage
                    class="trash-card__thumb"
                    :album-id="albumId"
                    :asset-id="item.id"
                    :alt="item.filename"
                    :width="240"
                />
                <div class="trash-card__body">
                    <span class="trash-card__name" :title="item.filename">{{ item.filename }}</span>
                    <span class="trash-card__meta">
                        {{ item.deletedAt ? formatDateTime(item.deletedAt) : '' }}
                    </span>
                    <div class="trash-card__actions">
                        <a-button
                            size="small"
                            :loading="busyId === item.id"
                            @click="restore(item)"
                        >
                            {{ t('album.restore') }}
                        </a-button>
                        <a-popconfirm
                            :title="t('album.purgeConfirm')"
                            :ok-text="t('common.confirm')"
                            :cancel-text="t('common.cancel')"
                            @confirm="purge(item)"
                        >
                            <a-button size="small" danger :loading="busyId === item.id">
                                {{ t('album.purge') }}
                            </a-button>
                        </a-popconfirm>
                    </div>
                </div>
            </article>
        </div>

        <a-button
            v-if="hasMore && assets.length > 0"
            type="link"
            :loading="loading"
            @click="loadMore()"
        >
            {{ t('common.more') }}
        </a-button>
    </div>
</template>

<style scoped>
.trash-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--px-space-3);
    margin-top: var(--px-space-4);
}

.trash-batch {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
    padding: var(--px-space-2) var(--px-space-3);
}

.trash-batch__count {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.trash-card {
    position: relative;
    overflow: hidden;
    background: var(--px-color-bg-surface);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-md);
}

.trash-card--selected {
    border-color: var(--px-color-brand);
}

.trash-card__check {
    position: absolute;
    top: var(--px-space-2);
    left: var(--px-space-2);
    padding: var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: color-mix(in srgb, var(--px-color-bg-surface) 86%, transparent);
    z-index: 1;
}

.trash-card__thumb {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    background: var(--px-color-bg-sunken);
}

.trash-card__body {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding: var(--px-space-2);
}

.trash-card__name {
    overflow: hidden;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.trash-card__meta {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
}

.trash-loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-10) 0;
}

.trash-card__actions {
    display: flex;
    gap: var(--px-space-2);
    margin-top: var(--px-space-1);
}

/* 手机：批量与卡片操作按钮放大到 40vp 触控目标 */
@media (max-width: 599px) {
    .trash-batch :deep(.ant-btn),
    .trash-card__actions :deep(.ant-btn) {
        min-height: var(--px-control-height);
    }
}
</style>
