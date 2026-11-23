<script setup lang="ts">
import { PictureOutlined } from '@antdv-next/icons';
import { pickDetailThumbnailSize } from '../utils/thumbnail-size';

/**
 * 通用缩略图：回收站、重复、相似等非虚拟列表统一用它。
 * - 进入视口才请求（useVisibleImage）；
 * - 按 devicePixelRatio 与估计显示宽度挑档，避免固定 256 在高分屏发虚；
 * - 复用 useThumbnailRetry：缓存优先模式下后台生成完成后自动补图。
 */
const props = withDefaults(defineProps<{
    albumId: string
    assetId: string
    alt: string
    /** 估计的 CSS 显示宽度；档位按它 × DPR 选择 */
    width?: number
}>(), {
    width: 256,
});

const pixelRatio = usePixelRatio();
const size = computed(() => pickDetailThumbnailSize(props.width, pixelRatio.value));
const { failed, token, onError, onLoad, reset } = useThumbnailRetry();
const { host, visible } = useVisibleImage();

const url = computed(() => (
    `/api/v1/albums/${props.albumId}/assets/${props.assetId}/thumbnail?size=${size.value}`
    + (token.value > 0 ? `&r=${token.value}` : '')
));

watch(() => props.assetId, reset);
</script>

<template>
    <span ref="host" class="px-thumb">
        <img
            v-if="visible && !failed"
            :src="url"
            :alt="alt"
            class="px-thumb__img"
            loading="lazy"
            decoding="async"
            @load="onLoad"
            @error="onError"
        >
        <span v-else class="px-thumb__fallback">
            <PictureOutlined />
        </span>
    </span>
</template>

<style scoped>
.px-thumb {
    display: block;
    overflow: hidden;
    background: var(--px-color-bg-sunken);
}

.px-thumb__img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.px-thumb__fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--px-color-text-fourth);
    font-size: var(--px-font-size-title-lg);
}
</style>
