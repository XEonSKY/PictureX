<script setup lang="ts">
import { DeleteOutlined, PictureOutlined, PlayCircleOutlined, StarFilled, StarOutlined } from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';
import { pickGridThumbnailSize } from '../utils/thumbnail-size';

const props = withDefaults(defineProps<{
    asset: AssetSummaryDto
    albumId: string
    height: number
    selectable?: boolean
    selected?: boolean
}>(), {
    selectable: false,
    selected: false,
});

const emit = defineEmits<{
    open: [assetId: string]
    delete: [assetId: string]
    toggle: [assetId: string]
    favorite: [assetId: string, favorite: boolean]
}>();

const { t } = useI18n();
const { formatBytes, formatDateTime, formatDuration } = useFormat();
const pixelRatio = usePixelRatio();
const { failed, token: retryToken, onError, onLoad, reset } = useThumbnailRetry();

// 列表行缩略图约 48 CSS 像素，与其他瓦片一样按物理像素取档并等待进入视口
const thumbnailSize = computed(() => pickGridThumbnailSize(48, pixelRatio.value));
const thumbnailUrl = computed(() => (
    `/api/v1/albums/${props.albumId}/assets/${props.asset.id}/thumbnail?size=${thumbnailSize.value}`
    + (retryToken.value > 0 ? `&r=${retryToken.value}` : '')
));
const { host, visible } = useVisibleImage();

watch(() => props.asset.id, reset);

const metaText = computed(() => {
    const parts = [formatBytes(props.asset.size)];

    if (props.asset.width && props.asset.height) {
        parts.push(`${props.asset.width} × ${props.asset.height}`);
    }
    if (props.asset.durationMs) {
        parts.push(formatDuration(props.asset.durationMs));
    }

    parts.push(formatDateTime(props.asset.takenAt ?? props.asset.addedAt));

    return parts.join(' · ');
});

function open(): void {
    if (props.selectable) {
        emit('toggle', props.asset.id);

        return;
    }

    emit('open', props.asset.id);
}
</script>

<template>
    <article
        ref="host"
        class="asset-row"
        :class="{ 'asset-row--selected': selectable && selected }"
        :style="{ height: `${height}px` }"
    >
        <a-checkbox
            v-if="selectable"
            class="asset-row__check"
            :checked="selected"
            :aria-label="t('a11y.selectAsset', { name: asset.displayName })"
            @click.stop
            @change="emit('toggle', asset.id)"
        />

        <button
            type="button"
            class="asset-row__open"
            :aria-label="t('a11y.thumbnail', { name: asset.displayName })"
            @click="open"
        >
            <span class="asset-row__thumb">
                <img
                    v-if="visible && !failed"
                    :src="thumbnailUrl"
                    :alt="t('a11y.thumbnail', { name: asset.displayName })"
                    loading="lazy"
                    decoding="async"
                    @load="onLoad"
                    @error="onError"
                >
                <PictureOutlined v-else />
                <span v-if="asset.kind === 'video'" class="asset-row__kind">
                    <PlayCircleOutlined />
                </span>
            </span>

            <span class="asset-row__text">
                <span class="asset-row__name" :title="asset.filename">{{ asset.displayName }}</span>
                <span class="asset-row__meta">{{ metaText }}</span>
            </span>
        </button>

        <div class="asset-row__actions" @click.stop>
            <button
                type="button"
                class="asset-row__action"
                :class="{ 'asset-row__action--favorite': asset.favorite }"
                :aria-label="asset.favorite ? t('asset.unfavorite') : t('asset.favorite')"
                @click="emit('favorite', asset.id, !asset.favorite)"
            >
                <StarFilled v-if="asset.favorite" />
                <StarOutlined v-else />
            </button>
            <a-popconfirm
                :title="t('asset.deleteConfirm', { name: asset.displayName })"
                :ok-text="t('common.delete')"
                :cancel-text="t('common.cancel')"
                @confirm="emit('delete', asset.id)"
            >
                <button type="button" class="asset-row__action" :aria-label="t('asset.delete')">
                    <DeleteOutlined />
                </button>
            </a-popconfirm>
        </div>
    </article>
</template>

<style scoped>
.asset-row {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    width: 100%;
    padding: var(--px-space-2) var(--px-space-4);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
    background: var(--px-color-bg-surface);
    transition: background var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.asset-row:hover {
    background: var(--px-color-bg-hover);
}

.asset-row--selected {
    background: var(--px-color-brand-soft);
}

.asset-row__check {
    flex: none;
}

.asset-row__open {
    display: flex;
    align-items: center;
    flex: 1;
    gap: var(--px-space-3);
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
}

.asset-row__open:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: var(--px-space-1);
    border-radius: var(--px-radius-sm);
}

.asset-row__thumb {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--px-space-12);
    height: var(--px-space-12);
    overflow: hidden;
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-subtitle);
}

.asset-row__thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.asset-row__kind {
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

.asset-row__text {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: var(--px-space-1);
    min-width: 0;
}

.asset-row__name {
    overflow: hidden;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-body);
    font-weight: var(--px-font-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.asset-row__meta {
    overflow: hidden;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.asset-row__actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--px-space-1);
}

.asset-row__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    padding: 0;
    border: 0;
    border-radius: var(--px-radius-sm);
    background: transparent;
    color: var(--px-color-text-tertiary);
    cursor: pointer;
}

.asset-row__action:hover {
    background: var(--px-color-bg-hover);
    color: var(--px-color-text-primary);
}

.asset-row__action--favorite {
    color: var(--px-color-warning);
}

@media (max-width: 599px) {
    .asset-row {
        gap: var(--px-space-2);
        padding-inline: var(--px-space-3);
    }

    .asset-row__actions {
        gap: 0;
    }
}
</style>
