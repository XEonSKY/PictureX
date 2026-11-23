<script setup lang="ts">
import { CloudOutlined } from '@antdv-next/icons';
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
const failed = ref(false);

const ratio = computed(() => {
    const width = props.item.width ?? 3;
    const height = props.item.height ?? 4;

    return `${width} / ${height}`;
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
    <button
        ref="host"
        type="button"
        class="pixiv-tile"
        :style="{ height: `${height}px` }"
        :aria-label="item.title || item.illustId"
        @click="open"
    >
        <span class="pixiv-tile__media" :style="{ aspectRatio: ratio }">
            <img
                v-if="visible && item.coverUrl && !failed"
                :src="item.coverUrl"
                alt=""
                loading="lazy"
                decoding="async"
                @error="failed = true"
            >
            <span v-else-if="!item.coverUrl || failed" class="pixiv-tile__fallback">
                <CloudOutlined />
            </span>

            <span class="pixiv-tile__badges">
                <span v-if="item.invalid" class="pixiv-tile__badge pixiv-tile__badge--invalid">
                    {{ t('pixivLibrary.invalidBadge') }}
                </span>
                <span v-else-if="item.placeholder" class="pixiv-tile__badge">
                    {{ t('pixivLibrary.placeholderBadge') }}
                </span>
                <span v-if="item.ugoira" class="pixiv-tile__badge">
                    {{ t('pixivLibrary.ugoiraBadge') }}
                </span>
                <span v-if="isPixivAiGenerated(item.illustAiType)" class="pixiv-tile__badge">
                    {{ t('pixivLibrary.aiBadge') }}
                </span>
                <span v-if="item.xRestrict > 0" class="pixiv-tile__badge pixiv-tile__badge--restricted">
                    {{ t('pixivLibrary.restrictedBadge') }}
                </span>
            </span>
        </span>

        <span class="pixiv-tile__body">
            <span class="pixiv-tile__title">{{ item.title || item.illustId }}</span>
            <span class="pixiv-tile__meta">
                <span class="pixiv-tile__artist">{{ item.userName || item.userId || '—' }}</span>
                <span>{{ t('pixivLibrary.pageCount', { count: item.pageCount }) }}</span>
            </span>
        </span>
    </button>
</template>

<style scoped>
.pixiv-tile {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0;
    overflow: hidden;
    text-align: left;
    background: var(--px-color-bg-surface);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-lg);
    cursor: pointer;
    transition:
        border-color var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        transform var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.pixiv-tile:hover,
.pixiv-tile:focus-visible {
    border-color: var(--px-color-brand);
    transform: translateY(calc(var(--px-border-width) * -2));
}

.pixiv-tile__media {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 100%;
    overflow: hidden;
    background: var(--px-color-bg-sunken);
}

.pixiv-tile__media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.pixiv-tile__fallback {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-title);
}

.pixiv-tile__badges {
    position: absolute;
    top: var(--px-space-2);
    left: var(--px-space-2);
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-space-1);
}

.pixiv-tile__badge {
    padding: 0 var(--px-space-1);
    color: var(--px-color-brand);
    font-size: var(--px-font-size-micro);
    font-weight: var(--px-font-weight-medium);
    background: var(--px-color-brand-soft);
    border-radius: var(--px-radius-full);
}

.pixiv-tile__badge--restricted,
.pixiv-tile__badge--invalid {
    color: var(--px-color-danger);
    background: var(--px-color-bg-surface);
}

.pixiv-tile__body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--px-space-1);
    min-height: 0;
    padding: var(--px-space-2);
    overflow: hidden;
}

.pixiv-tile__title {
    display: -webkit-box;
    overflow: hidden;
    font-size: var(--px-font-size-body);
    font-weight: var(--px-font-weight-medium);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-height: var(--px-line-height-normal);
}

.pixiv-tile__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-2);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.pixiv-tile__artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
