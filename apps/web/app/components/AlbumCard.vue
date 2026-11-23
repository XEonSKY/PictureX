<script setup lang="ts">
import { MoreOutlined, PictureOutlined } from '@antdv-next/icons';
import type { AlbumIndex } from '~~/server/album/album-store';

const props = defineProps<{
    album: AlbumIndex
    dir?: string
    missing?: boolean
    corrupt?: boolean
}>();

const emit = defineEmits<{
    open: [id: string]
    rename: [id: string]
    delete: [id: string]
}>();

const { t } = useI18n();
const { formatRelative } = useFormat();
const pixelRatio = usePixelRatio();

const coverElement = ref<HTMLImageElement | null>(null);
const coverFade = ref(false);
const coverLoaded = ref(true);

onMounted(() => {
    if (document.visibilityState !== 'visible') {
        return;
    }

    const image = coverElement.value;

    if (!image || (image.complete && image.naturalWidth > 0)) {
        return;
    }

    coverFade.value = true;
    coverLoaded.value = false;
});

const coverSize = computed(() => (pixelRatio.value >= 2 ? 1024 : 512));
const coverUrl = computed(() => (
    props.missing
        ? ''
        : props.album.coverAssetId
            ? `/api/v1/albums/${props.album.id}/assets/${props.album.coverAssetId}/thumbnail?size=${coverSize.value}`
            : ''
));

const menuItems = computed(() => [
    { key: 'rename', label: t('album.rename'), disabled: props.missing || props.corrupt },
    { key: 'delete', label: t('album.unlink') },
]);

function openAlbum(): void {
    if (props.missing || props.corrupt) {
        return;
    }

    emit('open', props.album.id);
}

function onMenu(info: { key: string | number }): void {
    if (info.key === 'rename') {
        emit('rename', props.album.id);
    }
    if (info.key === 'delete') {
        emit('delete', props.album.id);
    }
}
</script>

<template>
    <article
        class="album-card"
        :class="{ 'album-card--missing': props.missing || props.corrupt }"
    >
        <button
            type="button"
            class="album-card__open"
            :aria-label="t('a11y.openAlbum', { name: album.name })"
            :disabled="props.missing || props.corrupt"
            @click="openAlbum"
        />
        <div class="album-card__cover">
            <span v-if="props.missing" class="album-card__badge">
                {{ t('album.pathMissing') }}
            </span>
            <span v-else-if="props.corrupt" class="album-card__badge">
                {{ t('album.pathCorrupt') }}
            </span>
            <img
                v-if="coverUrl"
                ref="coverElement"
                :src="coverUrl"
                :alt="album.name"
                class="album-card__image"
                :class="{ 'album-card__image--fade': coverFade && !coverLoaded }"
                loading="lazy"
                decoding="async"
                @load="coverLoaded = true"
            >
            <div v-else class="album-card__placeholder">
                <PictureOutlined />
            </div>

            <a-dropdown
                :trigger="['click']"
                :menu="{ items: menuItems, onClick: onMenu }"
            >
                <button
                    type="button"
                    class="album-card__menu"
                    :aria-label="t('a11y.albumActions')"
                    @click.stop
                >
                    <MoreOutlined />
                </button>
            </a-dropdown>
        </div>

        <footer class="album-card__body">
            <h3 class="album-card__name">
                {{ album.name }}
            </h3>
            <p v-if="props.missing || props.corrupt" class="album-card__meta album-card__meta--missing">
                {{ props.dir }}
                <span class="album-card__hint">
                    {{ props.corrupt ? t('album.pathCorruptHint') : t('album.pathMissingHint') }}
                </span>
            </p>
            <p v-else class="album-card__meta">
                {{ t('album.statAssets', { count: album.assetCount }) }}
                <span aria-hidden="true">·</span>
                {{ t('album.lastUpdated', { time: formatRelative(album.updatedAt) }) }}
            </p>
        </footer>
    </article>
</template>

<style scoped>
.album-card {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-md);
    background: var(--px-color-bg-surface);
    box-shadow: var(--px-shadow-surface);
    cursor: pointer;
    transition: transform var(--px-motion-duration-base) var(--px-motion-easing-emphasized);
}

.album-card:hover,
.album-card:focus-within {
    transform: translate3d(0, -2px, 0);
    box-shadow: var(--px-shadow-float);
}

/* 铺满整卡的打开按钮；内容层用 pointer-events 放行点击，只让操作按钮重新开启 */
.album-card__open {
    position: absolute;
    inset: 0;
    z-index: 0;
    padding: 0;
    border: 0;
    background: none;
    cursor: inherit;
}

.album-card__open:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.album-card--missing {
    cursor: default;
    border-style: dashed;
}

.album-card:has(.album-card__badge) {
    cursor: default;
}

.album-card__badge {
    position: absolute;
    top: var(--px-space-2);
    left: var(--px-space-2);
    z-index: 1;
    padding: 0 var(--px-space-2);
    border-radius: var(--px-radius-sm);
    background: color-mix(in srgb, var(--px-color-warning) 16%, var(--px-color-bg-surface));
    color: var(--px-color-warning);
    font-size: var(--px-font-size-caption);
    font-weight: var(--px-font-weight-medium);
    line-height: var(--px-control-height-sm);
}

.album-card__meta--missing {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    overflow-wrap: anywhere;
}

.album-card__hint {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.album-card__cover {
    position: relative;
    z-index: 1;
    pointer-events: none;
    aspect-ratio: 16 / 10;
    background: var(--px-color-bg-sunken);
    overflow: hidden;
}

.album-card__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition:
        opacity var(--px-motion-duration-base) var(--px-motion-easing-standard),
        transform var(--px-motion-duration-slow) var(--px-motion-easing-emphasized);
}

.album-card__image--fade {
    opacity: 0;
}

.album-card:hover .album-card__image {
    transform: scale(1.03);
}

.album-card__placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background:
        radial-gradient(80% 80% at 20% 0%, var(--px-color-brand-soft), transparent 70%),
        var(--px-color-bg-sunken);
    color: var(--px-color-brand);
    font-size: var(--px-font-size-title-lg);
}

.album-card__menu {
    position: absolute;
    top: var(--px-space-2);
    right: var(--px-space-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    border: none;
    border-radius: var(--px-radius-full);
    background: color-mix(in srgb, var(--px-color-bg-surface) 86%, transparent);
    color: var(--px-color-text-secondary);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        background-color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.album-card:hover .album-card__menu,
.album-card:focus-within .album-card__menu {
    opacity: 1;
    pointer-events: auto;
}

.album-card__menu:hover {
    background: var(--px-color-bg-surface);
    color: var(--px-color-text-primary);
}

/* 触屏没有 hover：操作入口常显并放大到 40vp 触控目标 */
@media (hover: none), (max-width: 839px) {
    .album-card__menu {
        width: var(--px-control-height);
        height: var(--px-control-height);
        opacity: 1;
        pointer-events: auto;
    }
}

.album-card__body {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding: var(--px-space-3) var(--px-space-4) var(--px-space-4);
    pointer-events: none;
}

.album-card__name {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.album-card__meta {
    margin: 0;
    display: flex;
    gap: var(--px-space-1);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}
</style>
