<script setup lang="ts">
import type { LibraryMediaDto, LibraryTagDto } from '~~/shared/library';
import { tokenPx } from '#shared/theme';

definePageMeta({
    layout: 'library',
});

interface LibraryLayoutItem extends LibraryMediaDto {
    id: string
}

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const router = useRouter();
const { resolvedTokens } = useTheme();

const PAGE_SIZE = 200;

const mediaFeed = useCursorFeed<LibraryMediaDto, number>({
    fetchPage: async (nextCursor) => {
        const response = await api.viewer.media.$get({
            query: {
                limit: String(PAGE_SIZE),
                ...(nextCursor ? { cursor: nextCursor } : {}),
                ...(effectiveTagId.value ? { tagId: effectiveTagId.value } : {}),
            },
        });
        const body = await response.json();

        return {
            items: body.data,
            nextCursor: body.pagination.nextCursor,
            hasMore: body.pagination.hasMore,
            extra: body.total,
        };
    },
});
const media = mediaFeed.items;
const total = computed(() => mediaFeed.extra.value ?? 0);
const tags = ref<LibraryTagDto[]>([]);
const { loading, initialLoading, error, load: loadMedia } = mediaFeed;

const gap = computed(() => tokenPx(resolvedTokens.value, 'space-3', 12));
const minColumnWidth = computed(() => tokenPx(resolvedTokens.value, 'layout-tile-min', 200));
const visibleTags = computed(() => (
    [...tags.value].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
));
/** 标签筛选落到 ?tag=，与相册照片页一致；从全局标签页双击进入时直接带上 */
const selectedTagId = computed<string | undefined>({
    get: () => (typeof route.query.tag === 'string' ? route.query.tag : undefined),
    set: (value) => {
        void router.push({ path: '/library', ...(value ? { query: { tag: value } } : {}) });
    },
});
const effectiveTagId = computed(() => selectedTagId.value);
const renderKey = computed(() => effectiveTagId.value ?? 'all');
const selectedTag = computed(() => tags.value.find(tag => tag.id === effectiveTagId.value) ?? null);
const layoutItems = computed<LibraryLayoutItem[]>(() => (
    media.value.map(item => ({ ...item, id: item.sha256 }))
));

function clearErrors(): void {
    error.value = '';
}

async function loadTags(): Promise<void> {
    const response = await api.viewer.tags.$get();
    const body = await response.json();

    tags.value = body.data ?? [];
}

function toggleTag(tagId: string): void {
    selectedTagId.value = effectiveTagId.value === tagId ? undefined : tagId;
}

watch(effectiveTagId, () => {
    void loadMedia(true);
});

useHead({
    title: () => `${t('library.title')} · PictureX`,
});

onMounted(async () => {
    try {
        await Promise.all([loadTags(), loadMedia(true)]);
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        initialLoading.value = false;
    }
});
</script>

<template>
    <div class="library-page px-page-fill">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    PictureX
                </p>
                <h1 class="px-page-title">
                    {{ t('library.title') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('library.subtitle') }}
                </p>
            </div>
            <div class="px-header-actions">
                <span class="px-header-meta">
                    {{ t('library.mediaCount', { count: total }) }} · {{ t('library.tagCount', { count: visibleTags.length }) }}
                </span>
            </div>
        </header>

        <a-alert
            v-if="error"
            type="error"
            show-icon
            closable
            :message="error"
            @close="clearErrors"
        />

        <section class="library-filters px-surface">
            <div class="library-tags" role="group" :aria-label="t('library.title')">
                <button
                    type="button"
                    class="library-tag"
                    :class="{ 'library-tag--active': effectiveTagId === undefined }"
                    @click="selectedTagId = undefined"
                >
                    {{ t('library.filterAll') }}
                </button>
                <button
                    v-for="tag in visibleTags"
                    :key="tag.id"
                    type="button"
                    class="library-tag"
                    :class="{ 'library-tag--active': effectiveTagId === tag.id }"
                    :title="tag.name"
                    @click="toggleTag(tag.id)"
                >
                    <span class="library-tag__swatch" :style="{ background: tag.color || 'transparent' }" />
                    <span class="library-tag__name">{{ tag.name }}</span>
                    <span class="library-tag__count">{{ tag.count }}</span>
                </button>
            </div>
            <div v-if="selectedTag" class="library-filters__foot">
                <span class="library-selected">
                    <span class="library-tag__swatch" :style="{ background: selectedTag.color || 'transparent' }" />
                    {{ selectedTag.name }}
                </span>
            </div>
        </section>

        <div class="px-page-fill__body">
            <VirtualMasonry
                :items="layoutItems"
                :gap="gap"
                :min-column-width="minColumnWidth"
                :meta-height="0"
                :loading="loading && !initialLoading"
                :initial-loading="initialLoading"
                :reset-key="renderKey"
                :aria-label="t('library.gridLabel')"
                @load-more="loadMedia(false)"
            >
                <template #default="{ item, width, height }">
                    <GlobalLibraryTile
                        :item="item"
                        :width="width"
                        :height="height"
                    />
                </template>
                <template #empty>
                    <div class="px-empty-state px-empty-state--fill">
                        <a-empty :description="t('library.empty')" />
                        <p class="library-empty__hint">
                            {{ t('library.emptyHint') }}
                        </p>
                    </div>
                </template>
            </VirtualMasonry>

            <div v-if="initialLoading" class="px-loading-overlay">
                <a-spin />
            </div>
        </div>
    </div>
</template>

<style scoped>
.library-filters {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    padding: var(--px-space-3);
}

.library-tags {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
    max-height: calc(var(--px-space-16) * 2);
    overflow-y: auto;
}

.library-tag {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-1);
    height: var(--px-control-height-sm);
    padding: 0 var(--px-space-2);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-full);
    background: var(--px-color-bg-surface);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
    cursor: pointer;
    transition:
        transform var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        border-color var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        background-color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.library-tag:active {
    transform: scale(0.96);
}

.library-tag:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: var(--px-space-1);
}

.library-tag:hover {
    border-color: var(--px-color-border-strong);
    background: var(--px-color-bg-hover);
}

.library-tag--active {
    border-color: var(--px-color-brand);
    background: var(--px-color-brand-soft);
    color: var(--px-color-brand);
}

.library-tag__swatch {
    flex: none;
    width: var(--px-space-2);
    height: var(--px-space-2);
    border: var(--px-border-width) solid var(--px-color-border-strong);
    border-radius: var(--px-radius-full);
}

.library-tag__name {
    max-width: var(--px-space-16);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.library-tag__count {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
}

.library-tag__pixiv {
    padding: 0 var(--px-space-1);
    border-radius: var(--px-radius-full);
    background: var(--px-color-brand-soft);
    color: var(--px-color-brand);
    font-size: var(--px-font-size-micro);
    font-weight: var(--px-font-weight-medium);
}

.library-tag--active .library-tag__pixiv {
    background: var(--px-color-bg-surface);
}

.library-filters__foot {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    flex-wrap: wrap;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.library-selected {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-1);
    color: var(--px-color-text-primary);
}

.library-empty__hint {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}
</style>
