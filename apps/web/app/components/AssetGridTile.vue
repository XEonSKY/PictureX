<script setup lang="ts">
import { PictureOutlined, PlayCircleOutlined } from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';
import { pickGridThumbnailSize } from '../utils/thumbnail-size';

const props = withDefaults(defineProps<{
    asset: AssetSummaryDto
    albumId: string
    width: number
    height: number
    selectable?: boolean
    selected?: boolean
}>(), {
    selectable: false,
    selected: false,
});

const emit = defineEmits<{
    open: [assetId: string]
    toggle: [assetId: string]
}>();

const { t } = useI18n();
const pixelRatio = usePixelRatio();
const { failed, token: retryToken, onError, onLoad, reset } = useThumbnailRetry();

// 矩阵瓦片只占几十像素：按物理像素挑最小可用档位，缩略图大部分能直接命中缓存
const thumbnailSize = computed(() => pickGridThumbnailSize(props.width, pixelRatio.value));
const thumbnailUrl = computed(() => (
    `/api/v1/albums/${props.albumId}/assets/${props.asset.id}/thumbnail?size=${thumbnailSize.value}`
    + (retryToken.value > 0 ? `&r=${retryToken.value}` : '')
));
const { host, visible } = useVisibleImage();

watch(() => props.asset.id, reset);

function open(): void {
    if (props.selectable) {
        emit('toggle', props.asset.id);

        return;
    }

    emit('open', props.asset.id);
}
</script>

<template>
    <button
        ref="host"
        type="button"
        class="grid-tile"
        :class="{ 'grid-tile--selected': selectable && selected }"
        :aria-label="t('a11y.thumbnail', { name: asset.displayName })"
        @click="open"
    >
        <img
            v-if="visible && !failed"
            :src="thumbnailUrl"
            :alt="t('a11y.thumbnail', { name: asset.displayName })"
            loading="lazy"
            decoding="async"
            @load="onLoad"
            @error="onError"
        >
        <span v-else-if="failed" class="grid-tile__fallback">
            <PictureOutlined />
        </span>

        <span v-if="selectable" class="grid-tile__check">
            <a-checkbox
                :checked="selected"
                :aria-label="t('a11y.selectAsset', { name: asset.displayName })"
                @click.stop
                @change="emit('toggle', asset.id)"
            />
        </span>

        <span v-if="asset.kind === 'video'" class="grid-tile__kind">
            <PlayCircleOutlined />
        </span>
    </button>
</template>

<style scoped>
.grid-tile {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: calc(var(--px-space-1) / 2);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
    cursor: pointer;
}

.grid-tile--selected {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.grid-tile:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.grid-tile img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.grid-tile__fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: var(--px-font-size-body);
}

.grid-tile__check {
    position: absolute;
    top: var(--px-space-1);
    left: var(--px-space-1);
    display: inline-flex;
}

.grid-tile__kind {
    position: absolute;
    right: var(--px-space-1);
    bottom: var(--px-space-1);
    display: inline-flex;
    padding: 0 var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: var(--px-color-mask);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
}
</style>
