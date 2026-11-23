<script setup lang="ts">
import {
    CloseOutlined,
    LayoutOutlined,
    LeftOutlined,
    MinusOutlined,
    PlusOutlined,
    ReloadOutlined,
    RightOutlined,
    SyncOutlined,
    TableOutlined,
    UnorderedListOutlined,
} from '@antdv-next/icons';
import { tokenPx } from '#shared/theme';
import type {
    PixivLibraryDetailDto,
    PixivLibraryItemDto,
    PixivLibrarySort,
    PixivLibraryStatsDto,
    PixivLibraryStatus,
} from '~~/server/pixiv/library';
import type { PixivAutoFetchStatusDto } from '~~/shared/pixiv';
import { pickPixivTagName } from '~~/shared/pixiv';
import {
    activeAutoFetch,
    autoFetchPercent,
    autoFetchStateKey,
    autoFetchTagColor,
} from '~/utils/pixiv-auto-fetch';
import {
    clampGridColumns,
    GRID_VIEW_MODES,
    persistViewPreferences,
    readStoredGridColumns,
    readStoredViewMode,
    type GridViewMode,
} from '~/utils/view-preferences';

type PixivViewMode = GridViewMode;

const VIEW_MODE_KEY = 'picturex.pixiv-view';
const GRID_COLUMNS_KEY = 'picturex.pixiv-grid-columns';
const MIN_GRID_COLUMNS = 2;
const MAX_GRID_COLUMNS = 20;

const { t } = useI18n();
const api = useApi();
const router = useRouter();
const { resolvedTokens } = useTheme();
const { formatNumber, formatDateTime } = useFormat();

const PAGE_SIZE = 60;

const viewMode = ref<PixivViewMode>('masonry');
const gridColumns = ref(6);
const appliedGridColumns = ref(6);
const gridWrap = ref<HTMLElement | null>(null);
const gridWrapWidth = ref(0);
let gridObserver: ResizeObserver | null = null;

const gap = computed(() => tokenPx(resolvedTokens.value, 'space-3', 12));
const minColumnWidth = computed(() => tokenPx(resolvedTokens.value, 'layout-tile-min', 200));
const metaHeight = computed(() => (
    tokenPx(resolvedTokens.value, 'space-16', 64) + tokenPx(resolvedTokens.value, 'space-2', 8)
));
const listRowHeight = computed(() => (
    tokenPx(resolvedTokens.value, 'space-16', 64) + tokenPx(resolvedTokens.value, 'space-2', 8)
));
const gridGap = computed(() => tokenPx(resolvedTokens.value, 'space-1', 4));
const minGridTileWidth = computed(() => tokenPx(resolvedTokens.value, 'space-6', 24));
const layoutGap = computed(() => {
    if (viewMode.value === 'list') {
        return 0;
    }

    return viewMode.value === 'grid' ? gridGap.value : gap.value;
});
const maxGridColumns = computed(() => {
    const width = gridWrapWidth.value > 0
        ? gridWrapWidth.value
        : import.meta.client ? window.innerWidth : 1080;

    return Math.max(
        MIN_GRID_COLUMNS,
        Math.min(MAX_GRID_COLUMNS, Math.floor((width + gridGap.value) / (minGridTileWidth.value + gridGap.value))),
    );
});
const layoutItems = computed(() => items.value.map(item => ({
    ...item,
    id: item.illustId,
})));
const renderKey = computed(() => [
    status.value,
    type.value,
    tagId.value,
    userId.value,
    sort.value,
    searchInput.value.trim(),
].join('|'));

const stats = ref<PixivLibraryStatsDto | null>(null);
const {
    items,
    extra: totalExtra,
    loading,
    initialLoading,
    error,
    load: loadList,
} = useCursorFeed<PixivLibraryItemDto, number>({
    fetchPage: async (nextCursor) => {
        const response = await api.pixiv.library.$get({
            query: {
                limit: String(PAGE_SIZE),
                status: status.value,
                sort: sort.value,
                ...(nextCursor ? { cursor: nextCursor } : {}),
                ...(searchInput.value.trim() ? { q: searchInput.value.trim() } : {}),
                ...(type.value ? { type: type.value } : {}),
                ...(tagId.value ? { tagId: tagId.value } : {}),
                ...(userId.value ? { userId: userId.value } : {}),
            },
        });
        const body = await response.json();

        return {
            items: body.data.data,
            nextCursor: body.data.pagination.nextCursor,
            hasMore: body.data.pagination.hasMore,
            extra: body.data.total,
        };
    },
});
const total = computed(() => totalExtra.value ?? 0);
const notice = ref('');

const searchInput = ref('');
const status = ref<PixivLibraryStatus>('all');
const type = ref('');
const tagId = ref('');
const userId = ref('');
const sort = ref<PixivLibrarySort>('recent');

const syncBusy = ref(false);
const fetchStatus = ref<PixivAutoFetchStatusDto | null>(null);
const fetchBusy = ref(false);
const pauseBusy = ref(false);
let fetchTimer: ReturnType<typeof setInterval> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const detailOpen = ref(false);
const detail = ref<PixivLibraryDetailDto | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detailPage = ref(0);
const detailRefreshing = ref(false);
const heroLoading = ref(false);
const pagePreviewOpen = ref(false);
const pagePreviewIndex = ref(0);

const statusOptions = computed(() => [
    { value: 'all', label: t('pixivLibrary.statusAll') },
    { value: 'fetched', label: t('pixivLibrary.statusFetched') },
    { value: 'placeholder', label: t('pixivLibrary.statusPlaceholder') },
    { value: 'invalid', label: t('pixivLibrary.statusInvalid') },
]);

const typeOptions = computed(() => [
    { value: '', label: t('pixivLibrary.typeAll') },
    ...(stats.value?.types ?? []).map(item => ({
        value: item.type,
        label: typeLabel(item.type),
    })),
]);

const tagOptions = computed(() => [
    { value: '', label: t('pixivLibrary.tagAll') },
    ...(stats.value?.topTags ?? []).map(tag => ({
        value: tag.tagId,
        label: `${tag.name} · ${tag.count}`,
    })),
]);

const artistOptions = computed(() => [
    { value: '', label: t('pixivLibrary.artistAll') },
    ...(stats.value?.topUsers ?? []).map(user => ({
        value: user.userId,
        label: `${user.name || user.account || user.userId} · ${user.count}`,
    })),
]);

const sortOptions = computed(() => [
    { value: 'recent', label: t('pixivLibrary.sortRecent') },
    { value: 'bookmarks', label: t('pixivLibrary.sortBookmarks') },
    { value: 'views', label: t('pixivLibrary.sortViews') },
    { value: 'updated', label: t('pixivLibrary.sortUpdated') },
    { value: 'id', label: t('pixivLibrary.sortId') },
]);

const activeFetch = computed(() => activeAutoFetch(fetchStatus.value));

const fetchPercent = computed(() => autoFetchPercent(activeFetch.value));

const fetchStateText = computed(() => t(autoFetchStateKey(
    fetchStatus.value,
    activeFetch.value,
    'pixivLibrary.autoFetchIdle',
)));

const fetchTagColor = computed(() => autoFetchTagColor(activeFetch.value));

const detailCover = computed(() => {
    const current = detail.value;

    if (!current || current.placeholder) {
        return '';
    }

    return imageUrl(current.illustId, detailPage.value, 'large');
});

const detailPages = computed(() => detail.value?.illust?.pages ?? []);

function typeLabel(value: string): string {
    const labels: Record<string, string> = {
        illust: t('pixivLibrary.typeIllust'),
        manga: t('pixivLibrary.typeManga'),
        ugoira: t('pixivLibrary.typeUgoira'),
    };

    return labels[value] ?? value;
}

function imageUrl(illustId: string, page: number, variant: 'square' | 'medium' | 'large' | 'original'): string {
    return `/api/v1/pixiv/library/image?illustId=${encodeURIComponent(illustId)}&page=${page}&variant=${variant}`;
}

function setViewMode(mode: PixivViewMode): void {
    if (viewMode.value === mode) {
        return;
    }

    viewMode.value = mode;
    appliedGridColumns.value = clampGridColumns(gridColumns.value, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
}

function bumpGridColumns(delta: number): void {
    gridColumns.value = clampGridColumns(gridColumns.value + delta, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
    appliedGridColumns.value = gridColumns.value;
}

function loadViewPreference(): void {
    viewMode.value = readStoredViewMode(VIEW_MODE_KEY, GRID_VIEW_MODES, 'masonry');
    gridColumns.value = readStoredGridColumns(
        GRID_COLUMNS_KEY,
        MIN_GRID_COLUMNS,
        MAX_GRID_COLUMNS,
        gridColumns.value,
    );
    appliedGridColumns.value = clampGridColumns(gridColumns.value, MIN_GRID_COLUMNS, MAX_GRID_COLUMNS);
}

function clearErrors(): void {
    error.value = '';
}

function resetFilters(): void {
    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }

    const filtersChanged = status.value !== 'all'
      || type.value !== ''
      || tagId.value !== ''
      || userId.value !== ''
      || sort.value !== 'recent';

    searchInput.value = '';
    status.value = 'all';
    type.value = '';
    tagId.value = '';
    userId.value = '';
    sort.value = 'recent';

    if (!filtersChanged) {
        void loadList(true);
    }
}

async function loadStats(): Promise<void> {
    try {
        const response = await api.pixiv.library.stats.$get();
        const body = await response.json();

        stats.value = body.data;
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
}

function onSearchInput(): void {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }

    searchTimer = setTimeout(() => {
        searchTimer = null;
        void loadList(true);
    }, 320);
}

async function loadFetchStatus(): Promise<void> {
    try {
        const response = await api.pixiv['auto-fetch'].$get();
        const body: { data: PixivAutoFetchStatusDto } = await response.json();

        fetchStatus.value = body.data;
    }
    catch {
        // 轮询失败不打断浏览，下次自动重试
    }
}

async function syncDatabase(): Promise<void> {
    if (syncBusy.value) {
        return;
    }

    syncBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        await api.pixiv.database.sync.$post();
        notice.value = t('pixivLibrary.syncDone');
        await Promise.all([loadStats(), loadList(true)]);
    }
    catch (syncError) {
        error.value = errorMessage(syncError);
    }
    finally {
        syncBusy.value = false;
    }
}

async function pauseFetch(): Promise<void> {
    pauseBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].pause.$post();
        const body: { data: PixivAutoFetchStatusDto } = await response.json();

        fetchStatus.value = body.data;
        notice.value = t('pixivLibrary.autoFetchPaused');
    }
    catch (pauseError) {
        error.value = errorMessage(pauseError);
    }
    finally {
        pauseBusy.value = false;
    }
}

async function resumeFetch(): Promise<void> {
    pauseBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].resume.$post();
        const body: { data: { queued: number, status: PixivAutoFetchStatusDto } } = await response.json();

        fetchStatus.value = body.data.status;
        notice.value = t('settings.pixivAutoFetchStarted', { count: body.data.queued });
    }
    catch (resumeError) {
        error.value = errorMessage(resumeError);
    }
    finally {
        pauseBusy.value = false;
    }
}

async function triggerFetch(): Promise<void> {
    fetchBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].$post({ json: {} });
        const body: { data: { queued: number, status: PixivAutoFetchStatusDto } } = await response.json();

        fetchStatus.value = body.data.status;
        notice.value = t('settings.pixivAutoFetchStarted', { count: body.data.queued });
    }
    catch (triggerError) {
        error.value = errorMessage(triggerError);
    }
    finally {
        fetchBusy.value = false;
    }
}

async function openDetail(item: PixivLibraryItemDto): Promise<void> {
    detailOpen.value = true;
    detailPage.value = 0;
    detail.value = null;
    detailError.value = '';
    detailLoading.value = true;
    pagePreviewOpen.value = false;

    try {
        const response = await api.pixiv.library[':illustId'].$get({
            param: { illustId: item.illustId },
        });
        const body = await response.json();

        detail.value = body.data;
        heroLoading.value = !body.data.placeholder;
    }
    catch (loadError) {
        detailError.value = errorMessage(loadError);
    }
    finally {
        detailLoading.value = false;
    }
}

function openPagePreview(index: number): void {
    detailPage.value = index;
    pagePreviewIndex.value = index;
    pagePreviewOpen.value = true;
}

function closePagePreview(): void {
    pagePreviewOpen.value = false;
}

function stepPagePreview(delta: number): void {
    const count = detailPages.value.length;

    if (count === 0) {
        return;
    }

    const next = Math.max(0, Math.min(count - 1, pagePreviewIndex.value + delta));

    if (next === pagePreviewIndex.value) {
        return;
    }

    pagePreviewIndex.value = next;
    detailPage.value = next;
    heroLoading.value = true;
}

function onPreviewKeydown(event: KeyboardEvent): void {
    if (!pagePreviewOpen.value) {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        closePagePreview();

        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepPagePreview(-1);

        return;
    }
    if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepPagePreview(1);
    }
}

async function refreshDetail(): Promise<void> {
    const current = detail.value;

    if (!current || detailRefreshing.value) {
        return;
    }

    detailRefreshing.value = true;
    detailError.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv.library[':illustId'].refresh.$post({
            param: { illustId: current.illustId },
        });
        const body = await response.json();

        detail.value = body.data;
        detailPage.value = 0;
        notice.value = body.data.invalid
            ? t('pixivLibrary.refreshInvalid')
            : t('pixivLibrary.refreshDone');
        items.value = items.value.map((item) => {
            if (item.illustId !== body.data.illustId) {
                return item;
            }

            return {
                ...item,
                invalid: body.data.invalid,
                placeholder: body.data.placeholder,
                ...(body.data.illust
                    ? {
                        title: body.data.illust.title,
                        userName: body.data.illust.userName,
                        userAccount: body.data.illust.userAccount,
                        fetchedAt: body.data.fetchedAt,
                        coverUrl: imageUrl(body.data.illustId, 0, 'medium'),
                        pageCount: body.data.illust.pageCount,
                    }
                    : {}),
            };
        });
    }
    catch (refreshError) {
        detailError.value = errorMessage(refreshError);
    }
    finally {
        detailRefreshing.value = false;
    }
}

function openLocal(albumId: string, assetId: string): void {
    void router.push(`/albums/${albumId}/assets/${assetId}`);
}

function openPixiv(illustId: string): void {
    window.open(`https://www.pixiv.net/artworks/${illustId}`, '_blank', 'noopener');
}

function pixivTagUrl(name: string): string {
    return `https://www.pixiv.net/tags/${encodeURIComponent(name)}/artworks`;
}

watch([status, type, tagId, userId, sort], () => {
    void loadList(true);
});

watch([viewMode, gridColumns], () => {
    persistViewPreferences(VIEW_MODE_KEY, GRID_COLUMNS_KEY, viewMode.value, gridColumns.value);
});

watch(maxGridColumns, (max) => {
    if (gridColumns.value > max) {
        gridColumns.value = max;
    }
    if (appliedGridColumns.value > max) {
        appliedGridColumns.value = max;
    }
});

watch(detailPage, () => {
    if (detail.value?.illust) {
        heroLoading.value = true;
    }
});

watch(pagePreviewOpen, (open) => {
    if (!import.meta.client) {
        return;
    }

    document.body.style.overflow = open ? 'hidden' : '';
});

watch(detailOpen, (open) => {
    if (!open) {
        pagePreviewOpen.value = false;
    }
});

watch(() => fetchStatus.value?.running, (running, previous) => {
    if (previous && !running) {
        void loadStats();
    }
});

useHead({
    title: () => `${t('pixivLibrary.title')} · PictureX`,
});

onMounted(() => {
    loadViewPreference();
    void loadStats();
    void loadList(true);
    void loadFetchStatus();
    fetchTimer = setInterval(() => {
        void loadFetchStatus();
    }, 2500);
    window.addEventListener('keydown', onPreviewKeydown);

    if (gridWrap.value) {
        gridObserver = new ResizeObserver((entries) => {
            gridWrapWidth.value = entries[0]?.contentRect.width ?? gridWrap.value?.clientWidth ?? 0;
        });
        gridObserver.observe(gridWrap.value);
        gridWrapWidth.value = gridWrap.value.clientWidth;
    }
});

onBeforeUnmount(() => {
    if (fetchTimer) {
        clearInterval(fetchTimer);
        fetchTimer = null;
    }
    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }

    window.removeEventListener('keydown', onPreviewKeydown);
    document.body.style.overflow = '';

    gridObserver?.disconnect();
    gridObserver = null;
});
</script>

<template>
    <div class="pixiv-library px-page-fill">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    PIXIV
                </p>
                <h1 class="px-page-title">
                    {{ t('pixivLibrary.title') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('pixivLibrary.subtitle') }}
                </p>
            </div>
            <div class="px-header-actions">
                <a-button :loading="syncBusy" :disabled="syncBusy" @click="syncDatabase">
                    <template #icon>
                        <SyncOutlined />
                    </template>
                    {{ t('pixivLibrary.syncNow') }}
                </a-button>
                <a-button :aria-label="t('common.refresh')" @click="loadStats">
                    <template #icon>
                        <ReloadOutlined />
                    </template>
                </a-button>
            </div>
        </header>

        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />
        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="clearErrors" />

        <section v-if="stats" class="pixiv-stats px-surface">
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.total) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsTotal') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.fetched) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsFetched') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.placeholder) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsPlaceholder') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.invalid) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsInvalid') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.users) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsUsers') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.tags) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsTags') }}</span>
            </div>
            <div class="pixiv-stats__item">
                <span class="pixiv-stats__value">{{ formatNumber(stats.ugoira) }}</span>
                <span class="pixiv-stats__label">{{ t('pixivLibrary.statsUgoira') }}</span>
            </div>
            <p class="pixiv-stats__meta">
                {{ stats.lastSyncedAt
                    ? t('pixivLibrary.lastSynced', { time: formatDateTime(stats.lastSyncedAt) })
                    : t('pixivLibrary.neverSynced') }}
            </p>
        </section>

        <section class="pixiv-manage px-surface">
            <div class="pixiv-manage__head">
                <h2 class="pixiv-manage__title">
                    {{ t('pixivLibrary.autoFetchTitle') }}
                </h2>
                <a-tag :color="fetchTagColor">
                    {{ fetchStateText }}
                </a-tag>
                <span v-if="activeFetch" class="pixiv-manage__album">{{ activeFetch.albumName }}</span>
                <span v-if="activeFetch && activeFetch.total > 0" class="pixiv-manage__count">
                    {{ t('pixivLibrary.autoFetchProgress', {
                        processed: formatNumber(activeFetch.processed),
                        total: formatNumber(activeFetch.total),
                    }) }}
                </span>
                <a-button
                    v-if="!fetchStatus?.paused"
                    size="small"
                    :loading="pauseBusy"
                    @click="pauseFetch"
                >
                    {{ t('pixivLibrary.autoFetchPause') }}
                </a-button>
                <a-button
                    v-else
                    size="small"
                    type="primary"
                    :loading="pauseBusy"
                    @click="resumeFetch"
                >
                    {{ t('pixivLibrary.autoFetchResume') }}
                </a-button>
                <a-button size="small" :loading="fetchBusy" :disabled="fetchStatus?.paused" @click="triggerFetch">
                    {{ t('pixivLibrary.autoFetchStart') }}
                </a-button>
            </div>

            <a-progress
                v-if="activeFetch && activeFetch.total > 0"
                :percent="fetchPercent"
                :status="fetchStatus?.running ? 'active' : 'normal'"
                size="small"
            />

            <p v-if="(fetchStatus?.queued.length ?? 0) > 0" class="px-hint">
                {{ t('pixivLibrary.autoFetchQueued', { count: fetchStatus?.queued.length ?? 0 }) }}
            </p>
            <p class="px-hint">
                {{ t('pixivLibrary.manageHint') }}
            </p>
        </section>

        <section class="pixiv-filters px-surface">
            <div class="pixiv-filters__row">
                <a-input
                    v-model:value="searchInput"
                    allow-clear
                    :placeholder="t('pixivLibrary.searchPlaceholder')"
                    :maxlength="200"
                    class="pixiv-filters__search"
                    @update:value="onSearchInput"
                    @press-enter="loadList(true)"
                />
                <a-select
                    v-model:value="status"
                    :options="statusOptions"
                    class="pixiv-filters__select"
                    :aria-label="t('pixivLibrary.statusAll')"
                />
                <a-select
                    v-model:value="type"
                    :options="typeOptions"
                    class="pixiv-filters__select"
                    :aria-label="t('pixivLibrary.filterType')"
                />
                <a-select
                    v-model:value="sort"
                    :options="sortOptions"
                    class="pixiv-filters__select"
                    :aria-label="t('pixivLibrary.filterSort')"
                />
            </div>
            <div class="pixiv-filters__row">
                <a-select
                    v-model:value="tagId"
                    :options="tagOptions"
                    show-search
                    option-filter-prop="label"
                    class="pixiv-filters__select pixiv-filters__select--wide"
                    :aria-label="t('pixivLibrary.filterTag')"
                />
                <a-select
                    v-model:value="userId"
                    :options="artistOptions"
                    show-search
                    option-filter-prop="label"
                    class="pixiv-filters__select pixiv-filters__select--wide"
                    :aria-label="t('pixivLibrary.filterArtist')"
                />
                <a-button @click="resetFilters">
                    {{ t('pixivLibrary.filterReset') }}
                </a-button>
                <div class="pixiv-view" role="group" :aria-label="t('album.viewMode')">
                    <a-button
                        size="small"
                        :type="viewMode === 'masonry' ? 'primary' : 'text'"
                        :aria-label="t('album.viewMasonry')"
                        :aria-pressed="viewMode === 'masonry'"
                        @click="setViewMode('masonry')"
                    >
                        <LayoutOutlined />
                    </a-button>
                    <a-button
                        size="small"
                        :type="viewMode === 'grid' ? 'primary' : 'text'"
                        :aria-label="t('album.viewGrid')"
                        :aria-pressed="viewMode === 'grid'"
                        @click="setViewMode('grid')"
                    >
                        <TableOutlined />
                    </a-button>
                    <a-button
                        size="small"
                        :type="viewMode === 'list' ? 'primary' : 'text'"
                        :aria-label="t('album.viewList')"
                        :aria-pressed="viewMode === 'list'"
                        @click="setViewMode('list')"
                    >
                        <UnorderedListOutlined />
                    </a-button>
                </div>
                <div v-if="viewMode === 'grid'" class="pixiv-grid-size">
                    <a-button
                        size="small"
                        type="text"
                        :aria-label="t('album.gridColumnsDecrease')"
                        :disabled="gridColumns <= MIN_GRID_COLUMNS"
                        @click="bumpGridColumns(-1)"
                    >
                        <MinusOutlined />
                    </a-button>
                    <span class="pixiv-grid-size__value">{{ gridColumns }}</span>
                    <a-button
                        size="small"
                        type="text"
                        :aria-label="t('album.gridColumnsIncrease')"
                        :disabled="gridColumns >= maxGridColumns"
                        @click="bumpGridColumns(1)"
                    >
                        <PlusOutlined />
                    </a-button>
                </div>
                <span class="pixiv-filters__count">
                    {{ t('pixivLibrary.resultCount', { count: formatNumber(total) }) }}
                </span>
            </div>
        </section>

        <div ref="gridWrap" class="pixiv-grid-wrap px-page-fill__body">
            <VirtualMasonry
                :key="viewMode"
                :items="layoutItems"
                :gap="layoutGap"
                :min-column-width="minColumnWidth"
                :meta-height="metaHeight"
                :mode="viewMode"
                :column-count="viewMode === 'grid' ? appliedGridColumns : 0"
                :list-row-height="listRowHeight"
                :loading="loading && !initialLoading"
                :initial-loading="initialLoading"
                :reset-key="renderKey"
                :overscan="viewMode === 'grid' ? 480 : 800"
                :aria-label="t('pixivLibrary.title')"
                @load-more="loadList(false)"
            >
                <template #default="{ item, height }">
                    <PixivListRow
                        v-if="viewMode === 'list'"
                        :item="item"
                        :height="height"
                        @open="openDetail"
                    />
                    <PixivGridTile
                        v-else-if="viewMode === 'grid'"
                        :item="item"
                        :height="height"
                        @open="openDetail"
                    />
                    <PixivMasonryTile
                        v-else
                        :item="item"
                        :height="height"
                        @open="openDetail"
                    />
                </template>
                <template #empty>
                    <div class="px-empty-state px-empty-state--fill">
                        <a-empty :description="t('pixivLibrary.empty')" />
                        <p class="px-hint">
                            {{ t('pixivLibrary.emptyHint') }}
                        </p>
                    </div>
                </template>
            </VirtualMasonry>

            <div v-if="initialLoading" class="px-loading-overlay">
                <a-spin />
            </div>
        </div>

        <a-drawer
            v-model:open="detailOpen"
            :title="detail?.illust?.title || detail?.illustId || t('pixivLibrary.detailTitle')"
            size="large"
            placement="right"
        >
            <template #extra>
                <div class="pixiv-detail__actions">
                    <a-button
                        v-if="detail"
                        size="small"
                        :loading="detailRefreshing"
                        :disabled="detailRefreshing"
                        @click="refreshDetail"
                    >
                        {{ detailRefreshing ? t('pixivLibrary.refreshing') : t('pixivLibrary.refreshDetail') }}
                    </a-button>
                    <a-button v-if="detail" size="small" @click="openPixiv(detail.illustId)">
                        {{ t('pixivLibrary.openPixiv') }}
                    </a-button>
                </div>
            </template>

            <div v-if="detailLoading" class="pixiv-detail__loading">
                <a-spin />
            </div>
            <a-alert v-else-if="detailError" type="error" show-icon :message="detailError" />
            <template v-else-if="detail">
                <a-alert
                    v-if="detail.invalid"
                    type="warning"
                    show-icon
                    :message="t('pixivLibrary.detailInvalid')"
                />
                <a-alert
                    v-else-if="detail.placeholder"
                    type="info"
                    show-icon
                    :message="t('pixivLibrary.detailPending')"
                />

                <template v-if="detail.illust">
                    <div class="pixiv-detail__hero" @click="openPagePreview(detailPage)">
                        <img
                            v-if="detailCover"
                            :src="detailCover"
                            :alt="detail.illust.title"
                            loading="eager"
                            decoding="async"
                            @load="heroLoading = false"
                            @error="heroLoading = false"
                        >
                        <div v-else class="pixiv-detail__hero-empty">
                            {{ t('pixivLibrary.detailNoImage') }}
                        </div>
                        <span v-if="detailPages.length > 1" class="pixiv-detail__counter">
                            {{ detailPage + 1 }} / {{ detailPages.length }}
                        </span>
                        <span v-if="heroLoading && detailCover" class="pixiv-detail__hero-loading">
                            <a-spin size="small" />
                        </span>
                    </div>

                    <div v-if="detailPages.length > 1" class="pixiv-detail__pages">
                        <button
                            v-for="page in detailPages"
                            :key="page.index"
                            type="button"
                            class="pixiv-detail__page"
                            :class="{ 'pixiv-detail__page--active': page.index === detailPage }"
                            :title="t('pixivLibrary.detailPage', { index: page.index + 1 })"
                            @click="openPagePreview(page.index)"
                        >
                            <img
                                :src="imageUrl(detail.illustId, page.index, 'square')"
                                alt=""
                                loading="lazy"
                            >
                        </button>
                    </div>

                    <dl class="pixiv-detail__meta">
                        <div class="pixiv-detail__meta-row">
                            <dt>{{ t('pixivLibrary.filterArtist') }}</dt>
                            <dd>
                                <a
                                    v-if="detail.illust.userId"
                                    :href="`https://www.pixiv.net/users/${detail.illust.userId}`"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {{ detail.illust.userName || detail.illust.userId }}
                                </a>
                                <span v-else>—</span>
                            </dd>
                        </div>
                        <div class="pixiv-detail__meta-row">
                            <dt>{{ t('pixivLibrary.detailStatsTitle') }}</dt>
                            <dd>
                                {{ t('pixivLibrary.detailStats', {
                                    views: formatNumber(detail.illust.totalView),
                                    bookmarks: formatNumber(detail.illust.totalBookmarks),
                                }) }}
                            </dd>
                        </div>
                        <div class="pixiv-detail__meta-row">
                            <dt>{{ t('pixivLibrary.detailCreated') }}</dt>
                            <dd>{{ formatDateTime(detail.illust.createDate) }}</dd>
                        </div>
                        <div class="pixiv-detail__meta-row">
                            <dt>{{ t('pixivLibrary.detailSize') }}</dt>
                            <dd>{{ detail.illust.width ?? '—' }} × {{ detail.illust.height ?? '—' }}</dd>
                        </div>
                    </dl>

                    <div v-if="detail.illust.tags.length > 0" class="pixiv-detail__section">
                        <h3 class="pixiv-detail__subtitle">
                            {{ t('pixivLibrary.detailTags') }}
                        </h3>
                        <div class="pixiv-detail__tags">
                            <a
                                v-for="tag in detail.illust.tags"
                                :key="tag.name"
                                :href="pixivTagUrl(tag.name)"
                                target="_blank"
                                rel="noreferrer"
                            >
                                <a-tag>{{ pickPixivTagName(tag) }}</a-tag>
                            </a>
                        </div>
                    </div>

                    <div v-if="detail.illust.caption" class="pixiv-detail__section">
                        <h3 class="pixiv-detail__subtitle">
                            {{ t('pixivLibrary.detailCaption') }}
                        </h3>
                        <p class="pixiv-detail__caption px-selectable">
                            {{ detail.illust.caption }}
                        </p>
                    </div>
                </template>

                <div class="pixiv-detail__section">
                    <h3 class="pixiv-detail__subtitle">
                        {{ t('pixivLibrary.detailLocals', { count: detail.locals.length }) }}
                    </h3>
                    <ul v-if="detail.locals.length > 0" class="pixiv-detail__locals">
                        <li v-for="local in detail.locals" :key="`${local.albumId}:${local.assetId}`">
                            <button type="button" class="pixiv-detail__local" @click="openLocal(local.albumId, local.assetId)">
                                <span class="pixiv-detail__local-name">{{ local.albumName }}</span>
                                <span class="pixiv-detail__local-file">{{ local.filename || local.assetId }}</span>
                                <span class="pixiv-detail__local-page">
                                    {{ t('pixivLibrary.detailPage', { index: local.pageIndex + 1 }) }}
                                </span>
                            </button>
                        </li>
                    </ul>
                    <p v-else class="px-hint">
                        {{ t('pixivLibrary.detailNoLocals') }}
                    </p>
                </div>
            </template>
        </a-drawer>

        <Teleport to="body">
            <div
                v-if="pagePreviewOpen && detail?.illust"
                class="pixiv-preview"
                role="dialog"
                aria-modal="true"
                @click.self="closePagePreview"
            >
                <img
                    :src="imageUrl(detail.illustId, pagePreviewIndex, 'large')"
                    :alt="detail.illust.title"
                    decoding="async"
                    @click.stop
                >
                <button
                    type="button"
                    class="pixiv-preview__close"
                    :aria-label="t('common.close')"
                    @click="closePagePreview"
                >
                    <CloseOutlined />
                </button>
                <button
                    v-if="pagePreviewIndex > 0"
                    type="button"
                    class="pixiv-preview__nav pixiv-preview__nav--prev"
                    :aria-label="t('asset.previous')"
                    @click="stepPagePreview(-1)"
                >
                    <LeftOutlined />
                </button>
                <button
                    v-if="pagePreviewIndex < detailPages.length - 1"
                    type="button"
                    class="pixiv-preview__nav pixiv-preview__nav--next"
                    :aria-label="t('asset.next')"
                    @click="stepPagePreview(1)"
                >
                    <RightOutlined />
                </button>
                <span class="pixiv-preview__count">
                    {{ pagePreviewIndex + 1 }} / {{ detailPages.length }}
                </span>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.pixiv-library {
    min-height: 0;
}

.pixiv-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-6);
    padding: var(--px-space-4);
}

.pixiv-stats__item {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    min-width: var(--px-space-16);
}

.pixiv-stats__value {
    font-size: var(--px-font-size-title);
    font-weight: var(--px-font-weight-semibold);
}

.pixiv-stats__label {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.pixiv-stats__meta {
    margin: 0 0 0 auto;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.pixiv-manage {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    padding: var(--px-space-4);
}

.pixiv-manage__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-2);
}

.pixiv-manage__title {
    margin: 0;
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.pixiv-manage__album {
    font-weight: var(--px-font-weight-medium);
}

.pixiv-manage__count {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.pixiv-filters {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    padding: var(--px-space-3);
}

.pixiv-filters__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-2);
}

.pixiv-filters__search {
    flex: 1;
    min-width: var(--px-space-16);
}

.pixiv-filters__select {
    min-width: calc(var(--px-space-16) * 1.4);
}

.pixiv-filters__select--wide {
    min-width: calc(var(--px-space-16) * 2.2);
}

.pixiv-filters__count {
    margin-left: auto;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.pixiv-view {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-1);
}

.pixiv-grid-size {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-1);
}

.pixiv-grid-size__value {
    min-width: var(--px-space-4);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
    text-align: center;
}

/* 手机：视图组与列数按钮放大到 40vp 触控目标 */
@media (max-width: 599px) {
    .pixiv-view :deep(.ant-btn),
    .pixiv-grid-size :deep(.ant-btn) {
        min-width: var(--px-control-height);
        min-height: var(--px-control-height);
    }
}

.pixiv-detail__actions {
    display: flex;
    gap: var(--px-space-2);
}

.pixiv-detail__loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-16);
}

.pixiv-detail__hero {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(var(--px-space-16) * 3);
    margin-bottom: var(--px-space-4);
    overflow: hidden;
    background: var(--px-color-bg-sunken);
    border-radius: var(--px-radius-lg);
    cursor: zoom-in;
}

.pixiv-detail__counter {
    position: absolute;
    top: var(--px-space-2);
    right: var(--px-space-2);
    padding: 0 var(--px-space-2);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-micro);
    background: var(--px-color-mask);
    border-radius: var(--px-radius-full);
}

.pixiv-detail__hero-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--px-color-mask);
}

.pixiv-detail__hero img {
    max-width: 100%;
    max-height: 56vh;
    object-fit: contain;
}

.pixiv-detail__hero-empty {
    padding: var(--px-space-8);
    color: var(--px-color-text-tertiary);
}

.pixiv-detail__pages {
    display: flex;
    gap: var(--px-space-2);
    margin-bottom: var(--px-space-4);
    overflow-x: auto;
}

.pixiv-detail__page {
    flex: none;
    width: calc(var(--px-space-16) * 1.1);
    padding: 0;
    overflow: hidden;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-md);
    cursor: pointer;
}

.pixiv-detail__page--active {
    border-color: var(--px-color-brand);
}

.pixiv-detail__page img {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 4;
    object-fit: cover;
}

.pixiv-detail__meta {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    margin: 0 0 var(--px-space-4);
}

.pixiv-detail__meta-row {
    display: grid;
    grid-template-columns: calc(var(--px-space-16) * 0.9) 1fr;
    gap: var(--px-space-2);
    font-size: var(--px-font-size-body);
}

.pixiv-detail__meta-row dt {
    color: var(--px-color-text-secondary);
}

.pixiv-detail__meta-row dd {
    margin: 0;
    overflow-wrap: anywhere;
}

.pixiv-detail__section {
    margin-bottom: var(--px-space-4);
}

.pixiv-detail__subtitle {
    margin: 0 0 var(--px-space-2);
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.pixiv-detail__tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-space-1);
}

.pixiv-detail__caption {
    max-height: calc(var(--px-space-16) * 3);
    margin: 0;
    padding: var(--px-space-2);
    overflow-y: auto;
    color: var(--px-color-text-secondary);
    line-height: var(--px-line-height-relaxed);
    background: var(--px-color-bg-sunken);
    border-radius: var(--px-radius-md);
    white-space: pre-wrap;
}

.pixiv-detail__locals {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
}

.pixiv-detail__local {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    width: 100%;
    padding: var(--px-space-2);
    text-align: left;
    background: var(--px-color-bg-sunken);
    border: var(--px-border-width) solid transparent;
    border-radius: var(--px-radius-md);
    cursor: pointer;
}

.pixiv-detail__local:hover,
.pixiv-detail__local:focus-visible {
    border-color: var(--px-color-brand);
}

.pixiv-detail__local-name {
    font-weight: var(--px-font-weight-medium);
}

.pixiv-detail__local-file,
.pixiv-detail__local-page {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.pixiv-detail__local-file {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.pixiv-preview {
    position: fixed;
    inset: 0;
    z-index: var(--px-z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--px-color-mask);
}

.pixiv-preview img {
    max-width: 92vw;
    max-height: 90vh;
    object-fit: contain;
}

.pixiv-preview__close,
.pixiv-preview__nav {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-lg);
    height: var(--px-control-height-lg);
    padding: 0;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-body-lg);
    background: var(--px-color-bg-surface);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-full);
    cursor: pointer;
}

.pixiv-preview__close {
    top: var(--px-space-4);
    right: var(--px-space-4);
}

.pixiv-preview__nav {
    top: 50%;
    transform: translateY(-50%);
}

.pixiv-preview__nav--prev {
    left: var(--px-space-4);
}

.pixiv-preview__nav--next {
    right: var(--px-space-4);
}

.pixiv-preview__count {
    position: absolute;
    bottom: var(--px-space-4);
    left: 50%;
    padding: 0 var(--px-space-2);
    color: var(--px-color-text-inverse);
    font-size: var(--px-font-size-caption);
    background: var(--px-color-bg-elevated);
    border-radius: var(--px-radius-full);
    transform: translateX(-50%);
}

@media (max-width: 599px) {
    .pixiv-stats {
        flex-wrap: nowrap;
        gap: var(--px-space-3);
        padding: var(--px-space-2) var(--px-space-3);
        overflow-x: auto;
    }

    .pixiv-stats__item {
        min-width: var(--px-space-12);
    }

    .pixiv-stats__meta,
    .pixiv-manage {
        display: none;
    }

    .pixiv-filters__count {
        margin-left: 0;
    }
}
</style>
