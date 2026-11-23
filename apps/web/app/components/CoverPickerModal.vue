<script setup lang="ts">
import { SearchOutlined } from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';

const props = defineProps<{
    open: boolean
    albumId: string
    currentCoverId: string | null
}>();

const emit = defineEmits<{
    'update:open': [open: boolean]
    'select': [assetId: string]
}>();

const api = useApi();
const { t } = useI18n();

// 单元格按 CSS 像素传给瓦片，瓦片再按设备像素比挑最小可用的缩略图档位
const PAGE_SIZE = 60;
const CELL_PX = 168;

const keyword = ref('');
const selected = ref<string | null>(null);

function pickerQuery(nextCursor?: string) {
    const trimmed = keyword.value.trim();

    return {
        limit: String(PAGE_SIZE),
        sort: 'addedAt' as const,
        order: 'desc' as const,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        ...(trimmed ? { q: trimmed } : {}),
    };
}

const { items: assets, hasMore, loading, error, load } = useCursorFeed<AssetSummaryDto>({
    fetchPage: async (nextCursor) => {
        const response = await api.albums[':albumId'].assets.$get({
            param: { albumId: props.albumId },
            query: pickerQuery(nextCursor),
        });
        const body = await response.json();

        return {
            items: body.data,
            nextCursor: body.pagination.nextCursor,
            hasMore: body.pagination.hasMore,
        };
    },
});

function loadMore(): void {
    void load();
}

function onGridScroll(event: Event): void {
    const target = event.target as HTMLElement;

    if (target.scrollHeight - target.scrollTop - target.clientHeight < 480) {
        loadMore();
    }
}

function close(): void {
    emit('update:open', false);
}

function submit(): void {
    if (selected.value) {
        emit('select', selected.value);
        close();
    }
}

watch(() => props.open, (open) => {
    if (!open) {
        return;
    }

    keyword.value = '';
    selected.value = props.currentCoverId;
    void load(true);
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(keyword, () => {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }

    searchTimer = setTimeout(() => {
        void load(true);
    }, 400);
});

onBeforeUnmount(() => {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }
});
</script>

<template>
    <a-modal
        :open="props.open"
        :title="t('album.coverPickerTitle')"
        :width="860"
        :ok-text="t('album.coverApply')"
        :cancel-text="t('common.cancel')"
        :ok-button-props="{ disabled: !selected }"
        destroy-on-hidden
        @update:open="(value: boolean) => emit('update:open', value)"
        @ok="submit"
        @cancel="close"
    >
        <div class="cover-picker">
            <a-input
                v-model:value="keyword"
                :placeholder="t('album.coverSearchPlaceholder')"
                allow-clear
            >
                <template #prefix>
                    <SearchOutlined />
                </template>
            </a-input>

            <a-alert v-if="error" type="error" show-icon :message="error" />

            <div class="cover-picker__grid" @scroll="onGridScroll">
                <div
                    v-for="asset in assets"
                    :key="asset.id"
                    class="cover-picker__cell"
                    :class="{ 'cover-picker__cell--active': asset.id === selected }"
                >
                    <AssetGridTile
                        :asset="asset"
                        :album-id="props.albumId"
                        :width="CELL_PX"
                        :height="CELL_PX"
                        @open="selected = asset.id"
                    />
                </div>

                <p v-if="loading && assets.length === 0" class="cover-picker__hint">
                    {{ t('common.loading') }}
                </p>
                <p v-else-if="!loading && assets.length === 0" class="cover-picker__hint">
                    {{ t('album.coverPickerEmpty') }}
                </p>
            </div>

            <div class="cover-picker__footer">
                <span class="cover-picker__meta">
                    {{ t('album.coverPickerCount', { count: assets.length }) }}
                </span>
                <a-button v-if="hasMore" size="small" :loading="loading" @click="loadMore">
                    {{ t('album.coverLoadMore') }}
                </a-button>
            </div>
        </div>
    </a-modal>
</template>

<style scoped>
.cover-picker {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.cover-picker__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: var(--px-space-2);
    max-height: 56vh;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.cover-picker__cell {
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: var(--px-radius-sm);
}

.cover-picker__cell--active {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.cover-picker__hint {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-body);
    text-align: center;
}

.cover-picker__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.cover-picker__meta {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}
</style>
