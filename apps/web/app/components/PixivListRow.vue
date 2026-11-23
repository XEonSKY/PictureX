<script setup lang="ts">
import { CloudOutlined, PlayCircleOutlined, RightOutlined } from '@antdv-next/icons';
import type { PixivLibraryItemDto } from '~~/server/pixiv/library';
import { isPixivAiGenerated } from '~~/shared/pixiv';

const props = defineProps<{
    item: PixivLibraryItemDto
    height: number
}>();

const emit = defineEmits<{
    open: [item: PixivLibraryItemDto]
}>();

const { t } = useI18n();
const { formatNumber } = useFormat();
const failed = ref(false);

const thumbnailUrl = computed(() => props.item.coverUrl?.replace('variant=medium', 'variant=square') ?? null);

const metaText = computed(() => {
    const parts = [t('pixivLibrary.pageCount', { count: props.item.pageCount })];

    if (!props.item.placeholder) {
        parts.push(t('pixivLibrary.bookmarks', { count: formatNumber(props.item.totalBookmarks) }));
        parts.push(t('pixivLibrary.views', { count: formatNumber(props.item.totalView) }));
    }

    return parts.join(' · ');
});

watch(() => props.item.coverUrl, () => {
    failed.value = false;
});

const { host, visible } = useVisibleImage();

function open(): void {
    emit('open', props.item);
}
</script>

<template>
    <article ref="host" class="pixiv-row" :style="{ height: `${height}px` }">
        <button
            type="button"
            class="pixiv-row__open"
            :aria-label="item.title || item.illustId"
            @click="open"
        >
            <span class="pixiv-row__thumb">
                <img
                    v-if="visible && thumbnailUrl && !failed"
                    :src="thumbnailUrl"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    @error="failed = true"
                >
                <CloudOutlined v-else-if="!thumbnailUrl || failed" />
            </span>

            <span class="pixiv-row__text">
                <span class="pixiv-row__title">{{ item.title || item.illustId }}</span>
                <span class="pixiv-row__artist">{{ item.userName || item.userId || '—' }}</span>
                <span class="pixiv-row__meta">{{ metaText }}</span>
            </span>

            <span class="pixiv-row__badges">
                <a-tag v-if="item.invalid" color="red">
                    {{ t('pixivLibrary.invalidBadge') }}
                </a-tag>
                <a-tag v-else-if="item.placeholder">
                    {{ t('pixivLibrary.placeholderBadge') }}
                </a-tag>
                <a-tag v-if="item.ugoira">
                    <PlayCircleOutlined />
                    {{ t('pixivLibrary.ugoiraBadge') }}
                </a-tag>
                <a-tag v-if="isPixivAiGenerated(item.illustAiType)">
                    {{ t('pixivLibrary.aiBadge') }}
                </a-tag>
                <a-tag v-if="item.xRestrict > 0" color="red">
                    {{ t('pixivLibrary.restrictedBadge') }}
                </a-tag>
            </span>

            <RightOutlined class="pixiv-row__arrow" />
        </button>
    </article>
</template>

<style scoped>
.pixiv-row {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0 var(--px-space-4);
    background: var(--px-color-bg-surface);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
    transition: background var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.pixiv-row:hover {
    background: var(--px-color-bg-hover);
}

.pixiv-row__open {
    display: flex;
    align-items: center;
    flex: 1;
    gap: var(--px-space-3);
    min-width: 0;
    height: 100%;
    padding: 0;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
}

.pixiv-row__open:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: var(--px-space-1);
    border-radius: var(--px-radius-sm);
}

.pixiv-row__thumb {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--px-space-12);
    height: var(--px-space-12);
    overflow: hidden;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-subtitle);
    background: var(--px-color-bg-sunken);
    border-radius: var(--px-radius-sm);
}

.pixiv-row__thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.pixiv-row__text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--px-space-1);
    min-width: 0;
}

.pixiv-row__title {
    overflow: hidden;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-body);
    font-weight: var(--px-font-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pixiv-row__artist,
.pixiv-row__meta {
    overflow: hidden;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pixiv-row__badges {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--px-space-1);
}

.pixiv-row__badges :deep(.ant-tag) {
    margin: 0;
}

.pixiv-row__arrow {
    flex: none;
    color: var(--px-color-text-tertiary);
}

@media (max-width: 599px) {
    .pixiv-row {
        padding-inline: var(--px-space-3);
    }

    .pixiv-row__badges {
        display: none;
    }
}
</style>
