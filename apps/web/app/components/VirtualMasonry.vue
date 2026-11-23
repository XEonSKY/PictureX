<script setup lang="ts" generic="T extends MasonryItem">
import { SCROLL_ROOT } from '~/utils/scroll-root';

export interface MasonryItem {
    id: string
    width?: number | null
    height?: number | null
}

interface Position {
    item: T
    index: number
    x: number
    y: number
    w: number
    h: number
}

const props = withDefaults(defineProps<{
    items: T[]
    gap: number
    minColumnWidth: number
    metaHeight: number
    mode?: 'masonry' | 'grid' | 'list'
    /** grid 模式固定列数；不传时按 minColumnWidth 自适应 */
    columnCount?: number
    listRowHeight?: number
    loading?: boolean
    /** 首屏仍在加载：此时不能渲染 empty 插槽，否则会闪出“相册还没有照片” */
    initialLoading?: boolean
    overscan?: number
    ariaLabel?: string
    /** 列表语义变化（排序/筛选/搜索）时强制从头布局 */
    resetKey?: string
    /** 首次布局完成后恢复的滚动位置（从查看器返回） */
    initialScrollTop?: number
}>(), {
    mode: 'masonry',
    columnCount: 0,
    listRowHeight: 72,
    loading: false,
    initialLoading: false,
    overscan: 800,
    ariaLabel: '',
    initialScrollTop: 0,
});

const emit = defineEmits<{
    loadMore: []
}>();

const AUTO_LOAD_MIN_DISTANCE = 1200;

defineSlots<{
    default(props: { item: T, width: number, height: number, index: number }): unknown
    empty(): unknown
}>();

const container = ref<HTMLDivElement | null>(null);
// 瓦片以列表自身的滚动容器为 IntersectionObserver root，快速滚动时不会误判视口
provide(SCROLL_ROOT, container);
const containerWidth = ref(0);
const viewportHeight = ref(0);
const scrollTop = ref(0);
const columns = computed(() => {
    if (props.mode === 'list') {
        return 1;
    }
    if (props.mode === 'grid' && props.columnCount > 0) {
        return Math.max(2, Math.min(32, Math.round(props.columnCount)));
    }
    if (containerWidth.value <= 0) {
        return 1;
    }

    return Math.max(1, Math.min(8, Math.floor((containerWidth.value + props.gap) / (props.minColumnWidth + props.gap))));
});

const columnWidth = computed(() => {
    if (columns.value <= 0) {
        return 0;
    }

    return Math.max(0, (containerWidth.value - props.gap * (columns.value - 1)) / columns.value);
});

const positions = shallowRef<Position[]>([]);
const buckets = shallowRef<Position[][]>([]);
const totalHeight = ref(0);

// 矩阵一页可能就是好几屏：按视口高度提前拉下一页，快速滚动才不会停在页尾等数据
const autoLoadDistance = computed(() => Math.max(AUTO_LOAD_MIN_DISTANCE, viewportHeight.value * 1.5));

// 矩阵瓦片可能只有 24px：固定的 480px 预渲染会多挂 20 行（数千个 <img>），
// 改成最多预留 6 行，行高随瓦片宽度变化。
const effectiveOverscan = computed(() => {
    if (props.mode !== 'grid' || columnWidth.value <= 0) {
        return props.overscan;
    }

    return Math.min(props.overscan, Math.max(160, columnWidth.value * 6));
});

let lastCount = 0;
let lastFirst = '';
let lastColumns = 0;
let lastWidth = 0;
let lastResetKey = props.resetKey ?? '';
let forceReset = false;

function itemHeight(item: T, width: number): number {
    if (props.mode === 'list') {
        return Math.max(1, Math.round(props.listRowHeight));
    }
    if (props.mode === 'grid') {
        return Math.round(width);
    }

    const ratio = item.width && item.height && item.width > 0 ? item.height / item.width : 1;
    const clamped = Math.min(2.4, Math.max(0.45, ratio));

    return Math.round(width * clamped + props.metaHeight);
}

function rebuildFrom(fromIndex: number, reuse: boolean): void {
    const cols = columns.value;
    const width = columnWidth.value;

    if (cols <= 0 || width <= 0) {
        return;
    }

    const next: Position[] = reuse ? positions.value.slice(0, fromIndex) : [];
    const heights = new Array<number>(cols).fill(0);

    if (reuse) {
        for (const position of next) {
            const column = position.index % cols;

            heights[column] = Math.max(heights[column] ?? 0, position.y + position.h + props.gap);
        }
    }

    for (let index = fromIndex; index < props.items.length; index += 1) {
        const item = props.items[index];

        if (!item) {
            continue;
        }

        const column = index % cols;
        const height = itemHeight(item, width);
        const x = column * (width + props.gap);
        const y = heights[column] ?? 0;

        next.push({ item, index, x, y, w: width, h: height });
        heights[column] = y + height + props.gap;
    }

    positions.value = next;
    totalHeight.value = heights.length > 0 ? Math.max(...heights) : 0;
    lastCount = props.items.length;
    lastFirst = props.items[0]?.id ?? '';
    lastColumns = cols;
    lastWidth = width;

    // 追加分页时只把新条目塞进对应列，避免每页都 O(n) 重建全部桶
    const bucketList = reuse && bucketColumns === cols && buckets.value.length === cols
        ? buckets.value.map(column => column.slice())
        : Array.from({ length: cols }, () => [] as Position[]);
    const start = reuse ? fromIndex : 0;

    for (let index = start; index < next.length; index += 1) {
        const position = next[index];

        if (position) {
            bucketList[position.index % cols]?.push(position);
        }
    }

    buckets.value = bucketList;
    bucketColumns = cols;
}

let bucketColumns = 0;
let initialScrollApplied = false;

function applyInitialScroll(): void {
    const element = container.value;

    if (initialScrollApplied || !element || props.initialScrollTop <= 0) {
        return;
    }
    if (element.clientWidth <= 0 || totalHeight.value <= 0) {
        return;
    }

    initialScrollApplied = true;
    element.scrollTop = props.initialScrollTop;
    scrollTop.value = element.scrollTop;
    maybeLoadMore();
}

watch([columns, columnWidth, () => props.mode, () => props.listRowHeight], () => {
    rebuildFrom(0, false);
}, { immediate: true });

watch(() => props.items, (items) => {
    if (items.length === 0) {
        positions.value = [];
        buckets.value = [];
        bucketColumns = 0;
        totalHeight.value = 0;
        lastCount = 0;
        lastFirst = '';
        lastColumns = columns.value;
        lastWidth = columnWidth.value;
        lastResetKey = props.resetKey ?? '';

        return;
    }

    // 长度和顺序没变时（收藏、重命名），只替换位置里的 item 引用，避免全量重排
    if (!forceReset
      && lastColumns === columns.value
      && lastWidth === columnWidth.value
      && items[0]?.id === lastFirst
      && items.length === lastCount
      && (props.resetKey ?? '') === lastResetKey) {
        let changed = false;

        for (let index = 0; index < positions.value.length && index < items.length; index += 1) {
            const position = positions.value[index];
            const item = items[index];

            if (position && item && position.item !== item) {
                position.item = item;
                changed = true;
            }
        }

        if (changed) {
            positions.value = [...positions.value];
            buckets.value = buckets.value.map(column => [...column]);
        }

        return;
    }

    const reset = lastColumns !== columns.value
      || lastWidth !== columnWidth.value
      || items[0]?.id !== lastFirst
      || items.length < lastCount
      || forceReset
      || (props.resetKey ?? '') !== lastResetKey;

    lastResetKey = props.resetKey ?? '';
    forceReset = false;
    rebuildFrom(reset ? 0 : lastCount, !reset);
}, { deep: false });

watch(() => props.resetKey, (value) => {
    if ((value ?? '') === lastResetKey) {
        return;
    }

    // 列表内容可能稍后才到；标记下一次 items 更新必须全量重排
    lastResetKey = value ?? '';
    forceReset = true;
    scrollTop.value = 0;

    if (container.value) {
        container.value.scrollTop = 0;
    }

    rebuildFrom(0, false);
});

function lowerBound(list: Position[], target: number): number {
    let low = 0;
    let high = list.length;

    while (low < high) {
        const middle = (low + high) >> 1;
        const position = list[middle];

        if (!position) {
            break;
        }

        if (position.y + position.h >= target) {
            high = middle;
        }
        else {
            low = middle + 1;
        }
    }

    return low;
}

const visible = computed<Position[]>(() => {
    const top = scrollTop.value - effectiveOverscan.value;
    const bottom = scrollTop.value + viewportHeight.value + effectiveOverscan.value;
    const result: Position[] = [];

    for (const column of buckets.value) {
        for (let index = lowerBound(column, top); index < column.length; index += 1) {
            const position = column[index];

            if (!position || position.y > bottom) {
                break;
            }

            result.push(position);
        }
    }

    return result.sort((a, b) => a.index - b.index);
});

function maybeLoadMore(): void {
    const element = container.value;

    if (!element || props.loading || props.items.length === 0 || totalHeight.value === 0) {
        return;
    }

    if (element.scrollTop + element.clientHeight >= totalHeight.value - autoLoadDistance.value) {
        emit('loadMore');
    }
}

// 快速滚动时不必每帧重算可视区：瓦片在内容坐标系里不动，原生滚动依然 60fps，
// 只有进出视口的瓦片集合需要更新。限制到 ~20fps 可显著减少一次性挂载的 <img> 数量。
const SCROLL_COMMIT_MS = 48;
let lastCommitAt = 0;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

function commitScroll(): void {
    const element = container.value;

    if (!element) {
        return;
    }

    lastCommitAt = performance.now();
    scrollTop.value = element.scrollTop;
    maybeLoadMore();
}

function onScroll(): void {
    const elapsed = performance.now() - lastCommitAt;

    if (elapsed >= SCROLL_COMMIT_MS) {
        if (commitTimer) {
            clearTimeout(commitTimer);
            commitTimer = null;
        }

        commitScroll();

        return;
    }

    // 尾沿：滚动停下后必须提交最后的位置，否则视口会停在上一批瓦片
    if (commitTimer) {
        return;
    }

    commitTimer = setTimeout(() => {
        commitTimer = null;
        commitScroll();
    }, SCROLL_COMMIT_MS - elapsed);
}

let observer: ResizeObserver | null = null;

// 内容没铺满视口（或小屏首屏）时也要继续翻页，形成无限自动滚动
watch([
    () => props.items.length,
    () => props.loading,
    () => props.initialScrollTop,
    totalHeight,
    viewportHeight,
    containerWidth,
], () => {
    nextTick(() => {
        applyInitialScroll();
        maybeLoadMore();
    });
});

onMounted(() => {
    const element = container.value;

    if (!element) {
        return;
    }

    observer = new ResizeObserver(() => {
        containerWidth.value = element.clientWidth;
        viewportHeight.value = element.clientHeight;
        nextTick(maybeLoadMore);
    });
    observer.observe(element);
    containerWidth.value = element.clientWidth;
    viewportHeight.value = element.clientHeight;
    nextTick(() => {
        applyInitialScroll();
        maybeLoadMore();
    });
});

defineExpose({
    getScrollTop: () => container.value?.scrollTop ?? 0,
});

onBeforeUnmount(() => {
    observer?.disconnect();

    if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
    }
});
</script>

<template>
    <div
        ref="container"
        class="masonry"
        role="list"
        :aria-label="ariaLabel"
        @scroll.passive="onScroll"
    >
        <div class="masonry__canvas" :style="{ height: `${totalHeight}px` }">
            <div
                v-for="position in visible"
                :key="position.item.id"
                class="masonry__item"
                role="listitem"
                :style="{
                    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
                    width: `${position.w}px`,
                    height: `${position.h}px`,
                }"
            >
                <slot
                    :item="position.item"
                    :width="position.w"
                    :height="position.h"
                    :index="position.index"
                />
            </div>
        </div>

        <div v-if="loading" class="masonry__status">
            <a-spin size="small" />
        </div>

        <slot v-if="items.length === 0 && !loading && !initialLoading" name="empty" />
    </div>
</template>

<style scoped>
.masonry {
    position: relative;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    contain: strict;
}

.masonry__canvas {
    position: relative;
    width: 100%;
}

.masonry__item {
    position: absolute;
    top: 0;
    left: 0;
    contain: layout paint;
    transition:
        transform var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        width var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        height var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

@media (prefers-reduced-motion: reduce) {
    .masonry__item {
        transition: none;
    }
}

.masonry__status {
    display: flex;
    justify-content: center;
    padding: var(--px-space-4);
}

.masonry__status:last-child {
    padding-bottom: var(--px-space-8);
}
</style>
