<script setup lang="ts">
import { DeleteOutlined, PictureOutlined, PlayCircleOutlined, StarFilled, StarOutlined } from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';
import { pickDetailThumbnailSize, pickExactThumbnailSize } from '../utils/thumbnail-size';

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
    delete: [assetId: string]
    toggle: [assetId: string]
    favorite: [assetId: string, favorite: boolean]
}>();

const { t } = useI18n();
const { formatBytes, formatDuration } = useFormat();
const pixelRatio = usePixelRatio();

const { failed, token: retryToken, onError: onImageError, onLoad: onImageLoad, reset: resetRetry } = useThumbnailRetry();
const imageElement = ref<HTMLImageElement | null>(null);
const fadeIn = ref(false);
const loaded = ref(true);

// 首屏按「快速档」出图；停留（悬停或持续可见）后再换成完整覆盖当前物理像素的档位。
// 升级请求带 upgrade=1，服务端缺图时同步生成，避免拿到与首屏相同的小图。
const baseSize = computed(() => pickDetailThumbnailSize(props.width, pixelRatio.value));
const exactSize = computed(() => pickExactThumbnailSize(props.width, pixelRatio.value));
const upgradeSize = ref<number | null>(null);
const activeUpgradeSize = computed(() => (
    upgradeSize.value !== null && upgradeSize.value > baseSize.value ? upgradeSize.value : null
));

function thumbnailUrlFor(size: number, upgrade = false): string {
    const retry = retryToken.value > 0 ? `&r=${retryToken.value}` : '';

    return `/api/v1/albums/${props.albumId}/assets/${props.asset.id}/thumbnail?size=${size}${upgrade ? '&upgrade=1' : ''}${retry}`;
}

const thumbnailUrl = computed(() => thumbnailUrlFor(
    activeUpgradeSize.value ?? baseSize.value,
    activeUpgradeSize.value !== null,
));
const { host, visible } = useVisibleImage();

const DWELL_MS = 600;
const HOVER_MS = 160;
const UPGRADE_RETRY_DELAYS = [1500, 4000];
let dwellTimer: ReturnType<typeof setTimeout> | null = null;
let upgradeTimer: ReturnType<typeof setTimeout> | null = null;
let upgradeToken = 0;

function clearDwell(): void {
    if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
    }
}

function clearUpgradeTimer(): void {
    if (upgradeTimer) {
        clearTimeout(upgradeTimer);
        upgradeTimer = null;
    }
}

function loadUpgrade(target: number, attempt = 0): void {
    const token = ++upgradeToken;
    const image = new Image();

    image.decoding = 'async';
    image.onload = () => {
        // 资产切换或已有更高档时丢弃过期结果
        if (token !== upgradeToken || image.naturalWidth === 0) {
            return;
        }

        upgradeSize.value = target;
    };
    image.onerror = () => {
        // 缓存优先模式下目标档可能还在后台队列里：稍后再试，不打断已显示的首屏图
        const delay = UPGRADE_RETRY_DELAYS[attempt];

        if (token !== upgradeToken || !visible.value || delay === undefined) {
            return;
        }

        clearUpgradeTimer();
        upgradeTimer = setTimeout(() => {
            upgradeTimer = null;

            if (token === upgradeToken && visible.value) {
                loadUpgrade(target, attempt + 1);
            }
        }, delay);
    };
    image.src = thumbnailUrlFor(target, true);
}

function handleImageLoad(): void {
    loaded.value = true;
    onImageLoad();

    // 首屏图加载完再安排升级；缓存优先时首图可能刚刚才由后台生成
    if (visible.value && activeUpgradeSize.value === null) {
        scheduleUpgrade(DWELL_MS);
    }
}

function scheduleUpgrade(delay: number): void {
    const target = exactSize.value;

    if (target <= Math.max(baseSize.value, upgradeSize.value ?? 0)) {
        return;
    }

    clearDwell();
    dwellTimer = setTimeout(() => {
        dwellTimer = null;

        if (!visible.value) {
            return;
        }

        const next = exactSize.value;

        if (next > Math.max(baseSize.value, upgradeSize.value ?? 0)) {
            loadUpgrade(next);
        }
    }, delay);
}

watch(visible, (isVisible) => {
    if (isVisible) {
        scheduleUpgrade(DWELL_MS);
    }
    else {
        clearDwell();
    }
});

// 只对「已经升级过」的瓦片响应列宽/DPR 变化；挂载时 DPR 同步不应触发整屏升级风暴
watch(exactSize, () => {
    if (visible.value && upgradeSize.value !== null) {
        scheduleUpgrade(DWELL_MS);
    }
});

watch(() => props.asset.id, () => {
    upgradeToken += 1;
    upgradeSize.value = null;
    clearDwell();
    clearUpgradeTimer();
    resetRetry();

    if (visible.value) {
        scheduleUpgrade(DWELL_MS);
    }
});

onBeforeUnmount(() => {
    clearDwell();
    clearUpgradeTimer();
});

onMounted(() => {
    // 后台/隐藏页面的 CSS 过渡会冻结，淡入会把图片永久停在 opacity:0
    if (document.visibilityState !== 'visible') {
        return;
    }

    const image = imageElement.value;

    // 首屏 SSR 图片保持可见；客户端挂载时尚未解码完成的才淡入，缓存命中不重复闪
    if (!image || (image.complete && image.naturalWidth > 0)) {
        return;
    }

    fadeIn.value = true;
    loaded.value = false;
});

const badge = computed(() => {
    if (props.asset.kind === 'video') {
        return props.asset.durationMs ? formatDuration(props.asset.durationMs) : t('asset.video');
    }
    if (props.asset.kind === 'gif') {
        return t('asset.animated');
    }
    if (props.asset.kind === 'dynamic') {
        return t('asset.dynamic');
    }
    if (props.asset.kind === 'svg') {
        return t('asset.svg');
    }

    return '';
});

const metaText = computed(() => {
    if (props.asset.width && props.asset.height) {
        return `${props.asset.width} × ${props.asset.height}`;
    }

    return formatBytes(props.asset.size);
});

// 悬停/键盘聚焦表示有查看意图，缩短等待；离开视口由 visible 统一清理计时器
function scheduleHoverUpgrade(): void {
    if (visible.value) {
        scheduleUpgrade(HOVER_MS);
    }
}

function open(): void {
    if (props.selectable) {
        emit('toggle', props.asset.id);

        return;
    }

    emit('open', props.asset.id);
}

function toggle(): void {
    emit('toggle', props.asset.id);
}
</script>

<template>
    <article
        ref="host"
        class="tile"
        :class="{ 'tile--selected': selectable && selected }"
        :style="{ height: `${height}px` }"
        @pointerenter="scheduleHoverUpgrade"
        @focusin="scheduleHoverUpgrade"
    >
        <div class="tile__media">
            <button
                type="button"
                class="tile__open"
                :aria-label="t('a11y.thumbnail', { name: asset.displayName })"
                @click="open"
            >
                <img
                    v-if="visible && !failed"
                    ref="imageElement"
                    :src="thumbnailUrl"
                    :alt="t('a11y.thumbnail', { name: asset.displayName })"
                    class="tile__image"
                    :class="{ 'tile__image--fade': fadeIn && !loaded }"
                    loading="lazy"
                    decoding="async"
                    @load="handleImageLoad"
                    @error="onImageError"
                >
                <div v-else-if="failed" class="tile__fallback">
                    <PictureOutlined />
                </div>
            </button>

            <span v-if="selectable" class="tile__select">
                <a-checkbox
                    :checked="selected"
                    :aria-label="t('a11y.selectAsset', { name: asset.displayName })"
                    @change="toggle"
                />
            </span>

            <span v-if="badge" class="tile__badge">
                <PlayCircleOutlined v-if="asset.kind === 'video'" />
                {{ badge }}
            </span>

            <div class="tile__overlay">
                <span class="tile__overlay-name" :title="asset.filename">{{ asset.displayName }}</span>
                <span class="tile__actions" @click.stop>
                    <button
                        type="button"
                        class="tile__action"
                        :class="{ 'tile__action--favorite': asset.favorite }"
                        :aria-label="asset.favorite ? t('asset.unfavorite') : t('asset.favorite')"
                        @click.stop="emit('favorite', asset.id, !asset.favorite)"
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
                        <button type="button" class="tile__action" :aria-label="t('asset.delete')">
                            <DeleteOutlined />
                        </button>
                    </a-popconfirm>
                </span>
            </div>
        </div>

        <footer class="tile__meta">
            <span class="tile__name" :title="asset.filename">{{ asset.displayName }}</span>
            <span class="tile__sub">{{ metaText }}</span>
        </footer>
    </article>
</template>

<style scoped>
.tile {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-md);
    background: var(--px-color-bg-surface);
    box-shadow: var(--px-shadow-surface);
    cursor: pointer;
    /* 只动 transform；box-shadow 逐帧重绘代价高，悬停时直接切换 */
    transition: transform var(--px-motion-duration-base) var(--px-motion-easing-emphasized);
}

.tile:hover,
.tile:focus-within {
    transform: translate3d(0, -2px, 0);
    box-shadow: var(--px-shadow-float);
}

.tile__media {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--px-color-bg-sunken);
    overflow: hidden;
}

/* 主操作按钮铺满媒体区；覆盖层默认放行指针，让空白处点击仍触发打开 */
.tile__open {
    position: absolute;
    inset: 0;
    z-index: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
}

.tile__open:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.tile__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition:
        opacity var(--px-motion-duration-base) var(--px-motion-easing-standard),
        transform var(--px-motion-duration-slow) var(--px-motion-easing-emphasized);
}

.tile__image--fade {
    opacity: 0;
}

.tile:hover .tile__image {
    transform: scale(1.03);
}

.tile__fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--px-color-text-fourth);
    font-size: var(--px-font-size-title-lg);
}

.tile--selected {
    border-color: var(--px-color-brand);
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
    outline-offset: calc(var(--px-border-width) * -2);
}

.tile__select {
    position: absolute;
    top: var(--px-space-2);
    left: var(--px-space-2);
    z-index: 3;
    display: inline-flex;
    padding: var(--px-space-1);
    border-radius: var(--px-radius-xs);
    background: color-mix(in srgb, var(--px-color-bg-surface) 86%, transparent);
}

.tile__badge {
    position: absolute;
    left: var(--px-space-2);
    bottom: var(--px-space-2);
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-1);
    padding: var(--px-space-1) var(--px-space-2);
    border-radius: var(--px-radius-xs);
    background: color-mix(in srgb, var(--px-color-mask) 88%, transparent);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
    font-weight: var(--px-font-weight-medium);
}

.tile__overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--px-space-2);
    padding: var(--px-space-3);
    background: linear-gradient(to top, var(--px-color-mask), transparent 55%);
    opacity: 0;
    /* 覆盖层本身不吃指针事件：点击落到下层打开按钮，只有操作按钮重新开启 */
    pointer-events: none;
    transition: opacity var(--px-motion-duration-base) var(--px-motion-easing-standard);
}

.tile:hover .tile__overlay,
.tile:focus-within .tile__overlay {
    opacity: 1;
}

.tile__overlay-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-caption);
}

.tile__actions {
    display: inline-flex;
    gap: var(--px-space-1);
    pointer-events: auto;
}

.tile__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    border: none;
    border-radius: var(--px-radius-full);
    background: color-mix(in srgb, var(--px-color-bg-surface) 88%, transparent);
    color: var(--px-color-text-primary);
    cursor: pointer;
    transition: background-color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.tile__action:hover {
    background: var(--px-color-bg-surface);
}

.tile__action--favorite {
    color: var(--px-color-warning);
}

.tile__meta {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    height: calc(var(--px-control-height) + var(--px-space-2));
    padding: var(--px-space-1) var(--px-space-3);
    border-top: var(--px-border-width) solid var(--px-color-border);
}

.tile__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-font-size-caption);
    font-weight: var(--px-font-weight-medium);
    line-height: var(--px-line-height-tight);
    color: var(--px-color-text-primary);
}

.tile__sub {
    overflow: hidden;
    font-size: var(--px-font-size-micro);
    line-height: var(--px-line-height-tight);
    color: var(--px-color-text-tertiary);
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
