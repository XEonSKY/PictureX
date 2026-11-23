<script setup lang="ts">
import { CloudOutlined, PlayCircleOutlined } from '@antdv-next/icons';
import type { PixivLibraryItemDto } from '~~/server/pixiv/library';

const { t } = useI18n();
const props = defineProps<{
    item: PixivLibraryItemDto
    height: number
}>();

const emit = defineEmits<{
    open: [item: PixivLibraryItemDto]
}>();

const failed = ref(false);

const thumbnailUrl = computed(() => props.item.coverUrl?.replace('variant=medium', 'variant=square') ?? null);

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
        class="pixiv-grid-tile"
        :style="{ height: `${height}px` }"
        :aria-label="item.title || item.illustId"
        @click="open"
    >
        <img
            v-if="visible && thumbnailUrl && !failed"
            :src="thumbnailUrl"
            alt=""
            loading="lazy"
            decoding="async"
            @error="failed = true"
        >
        <span v-else-if="!thumbnailUrl || failed" class="pixiv-grid-tile__fallback">
            <CloudOutlined />
        </span>

        <span v-if="item.invalid" class="pixiv-grid-tile__invalid">
            {{ t('pixivLibrary.invalidBadge') }}
        </span>
        <span v-else-if="item.placeholder" class="pixiv-grid-tile__pending" />
        <span v-if="item.ugoira" class="pixiv-grid-tile__kind">
            <PlayCircleOutlined />
        </span>
    </button>
</template>

<style scoped>
.pixiv-grid-tile {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    overflow: hidden;
    color: var(--px-color-text-tertiary);
    background: var(--px-color-bg-sunken);
    border: 0;
    border-radius: calc(var(--px-space-1) / 2);
    cursor: pointer;
}

.pixiv-grid-tile:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.pixiv-grid-tile img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.pixiv-grid-tile__fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: var(--px-font-size-body);
}

.pixiv-grid-tile__invalid {
    position: absolute;
    top: var(--px-space-1);
    left: var(--px-space-1);
    padding: 0 var(--px-space-1);
    color: var(--px-color-danger);
    font-size: var(--px-font-size-micro);
    font-weight: var(--px-font-weight-medium);
    background: var(--px-color-bg-surface);
    border-radius: var(--px-radius-full);
}

.pixiv-grid-tile__pending {
    position: absolute;
    top: var(--px-space-1);
    right: var(--px-space-1);
    width: var(--px-space-1);
    height: var(--px-space-1);
    background: var(--px-color-warning);
    border-radius: var(--px-radius-full);
}

.pixiv-grid-tile__kind {
    position: absolute;
    right: var(--px-space-1);
    bottom: var(--px-space-1);
    display: inline-flex;
    padding: 0 var(--px-space-1);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
    background: var(--px-color-mask);
    border-radius: var(--px-radius-xs);
}
</style>
