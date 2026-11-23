<script setup lang="ts">
import {
    CheckSquareOutlined,
    CloseOutlined,
    DeleteOutlined,
    EditOutlined,
    FileImageOutlined,
    LayoutOutlined,
    MinusOutlined,
    PlusOutlined,
    ReloadOutlined,
    SearchOutlined,
    SyncOutlined,
    TableOutlined,
    TagOutlined,
    ThunderboltOutlined,
    UnorderedListOutlined,
} from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';
import type { AlbumListSnapshot } from '~/composables/useAlbumListSnapshot';
import { tokenPx } from '#shared/theme';
import {
    clampGridColumns as clampGridColumnsTo,
    GRID_VIEW_MODES,
    persistViewPreferences,
    readStoredGridColumns,
    readStoredViewMode,
    type GridViewMode,
} from '~/utils/view-preferences';

definePageMeta({
    layout: 'album',
});

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const router = useRouter();
const { resolvedTokens } = useTheme();

const albumId = computed(() => String(route.params.id));
const tagId = computed(() => (typeof route.query.tag === 'string' ? route.query.tag : undefined));
const pixivTagId = computed(() => (typeof route.query.pixivTag === 'string' ? route.query.pixivTag : undefined));
const { album, tags, load: loadContext } = useAlbumContext(albumId);
const { consume: consumeListMutations } = useAlbumListSync();
interface AlbumPixivTag {
    tagId: string
    name: string
    translatedName: string | null
    count: number
}

const pixivTags = ref<AlbumPixivTag[]>([]);
const {
    items: assets,
    loading,
    initialLoading,
    hasMore,
    cursor: assetsCursor,
    error,
    load: loadAssets,
    hydrate: hydrateAssets,
} = useCursorFeed<AssetSummaryDto>({
    fetchPage: async (nextCursor) => {
        const response = await api.albums[':albumId'].assets.$get({
            param: { albumId: albumId.value },
            query: assetQuery(nextCursor),
        });
        const body = await response.json();

        return {
            items: body.data,
            nextCursor: body.pagination.nextCursor,
            hasMore: body.pagination.hasMore,
        };
    },
    onPage: () => {
        loadedPageSize = pageSize.value;
    },
});

const { get: getListSnapshot, set: setListSnapshot, remove: removeListSnapshot } = useAlbumListSnapshot();
const masonryRef = ref<{ getScrollTop: () => number } | null>(null);
const initialScrollTop = ref(0);

const importOpen = ref(false);
const importPickerOpen = ref(false);
const importRoot = ref('');
const importResume = ref(true);
const importing = ref(false);
const importError = ref('');

const sort = ref<'newest' | 'oldest' | 'taken' | 'name' | 'pixiv'>('newest');
const search = ref('');
const favoritesOnly = ref(false);
const listSignature = computed(() => [
    sort.value,
    search.value.trim(),
    favoritesOnly.value ? '1' : '0',
    tagId.value ?? '',
    pixivTagId.value ?? '',
].join('|'));

type AlbumViewMode = GridViewMode;
const VIEW_MODE_KEY = 'picturex.album-view';
const GRID_COLUMNS_KEY = 'picturex.album-grid-columns';
const SORT_STORAGE_KEY = 'picturex.album-sort';
const SEARCH_STORAGE_KEY = 'picturex.album-search';
const FAVORITES_STORAGE_KEY = 'picturex.album-favorites';
const suppressListLoad = ref(false);
const MIN_GRID_COLUMNS = 2;
const MAX_GRID_COLUMNS = 32;
const gridWrap = ref<HTMLElement | null>(null);
const gridWrapWidth = ref(0);
/** 视口宽度参与列数上限计算；computed 内直接读 window 不会随窗口变化重算 */
const viewportWidth = ref(0);
const viewMode = ref<AlbumViewMode>('masonry');
const gridColumns = ref(5);
/** 布局实际使用的列数：滚轮/捏合时先只更新数字，停手后再一次性重排 */
const appliedGridColumns = ref(5);
const pageSize = computed(() => (
    viewMode.value === 'grid' ? 500 : viewMode.value === 'list' ? 300 : 120
));
let loadedPageSize = 0;
let gridApplyTimer: ReturnType<typeof setTimeout> | null = null;
let pinchState: { distance: number, columns: number } | null = null;
let gridObserver: ResizeObserver | null = null;

const selectMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const renameOpen = ref(false);
const renamePrefix = ref('');
const renameStart = ref<number | null>(1);
const renamePadding = ref<number | null>(3);
const renaming = ref(false);
const batchDeleting = ref(false);
const batchProgress = ref({ total: 0, done: 0 });
const batchTagOpen = ref(false);
const batchTagIds = ref<string[]>([]);
const batchTagging = ref(false);
const batchCovering = ref(false);
const notice = ref('');

const gap = computed(() => tokenPx(resolvedTokens.value, 'space-3', 12));
const minColumnWidth = computed(() => tokenPx(resolvedTokens.value, 'layout-tile-min', 200));
const metaHeight = computed(() => (
    tokenPx(resolvedTokens.value, 'control-height', 40) + tokenPx(resolvedTokens.value, 'space-2', 8)
));
const listRowHeight = computed(() => (
    tokenPx(resolvedTokens.value, 'space-16', 64) + tokenPx(resolvedTokens.value, 'space-2', 8)
));
const gridGap = computed(() => tokenPx(resolvedTokens.value, 'space-1', 4));
const minGridTileWidth = computed(() => tokenPx(resolvedTokens.value, 'space-6', 24));
const screenColumnCap = computed(() => {
    if (!import.meta.client) {
        return 12;
    }

    // 按物理像素分档：4K（含 150% 缩放）上限 32，1080p 上限 20
    const physicalWidth = Math.max(
        viewportWidth.value,
        (window.screen?.width ?? 0) * (window.devicePixelRatio || 1),
    );

    if (physicalWidth >= 3840) {
        return 32;
    }
    if (physicalWidth >= 2560) {
        return 24;
    }
    if (physicalWidth >= 1920) {
        return 20;
    }
    if (physicalWidth >= 1440) {
        return 16;
    }
    if (physicalWidth >= 1200) {
        return 12;
    }
    if (physicalWidth >= 840) {
        return 10;
    }
    if (physicalWidth >= 600) {
        return 8;
    }

    return 6;
});
const maxGridColumns = computed(() => {
    const width = gridWrapWidth.value > 0
        ? gridWrapWidth.value
        : import.meta.client ? window.innerWidth : 1080;

    return Math.max(
        MIN_GRID_COLUMNS,
        Math.min(
            MAX_GRID_COLUMNS,
            screenColumnCap.value,
            Math.floor((width + gridGap.value) / (minGridTileWidth.value + gridGap.value)),
        ),
    );
});
const layoutGap = computed(() => {
    if (viewMode.value === 'list') {
        return 0;
    }

    return viewMode.value === 'grid' ? gridGap.value : gap.value;
});

const tagFilterOptions = computed(() => tags.value.map(tag => ({
    value: tag.id,
    label: `${tag.name} (${tag.count})`,
})));

const pixivTagFilterOptions = computed(() => pixivTags.value.map(tag => ({
    value: tag.tagId,
    label: `${tag.translatedName || tag.name} (${tag.count})`,
})));

const listKey = computed(() => `${sort.value}|${tagId.value ?? ''}|${pixivTagId.value ?? ''}|${search.value.trim()}|${favoritesOnly.value}`);
const renderKey = computed(() => `${listKey.value}|${viewMode.value}`);
const emptyHint = computed(() => (
    search.value.trim() !== '' || Boolean(tagId.value) || Boolean(pixivTagId.value) || favoritesOnly.value
        ? t('album.noMatchHint')
        : t('album.photoEmptyHint')
));

// 筛选/排序变化后网格内容已不同，旧选中项可能已不可见，批量操作前必须清空
watch(listKey, () => {
    if (selectedIds.value.size > 0) {
        selectedIds.value = new Set();
    }
});

function pushFilterQuery(next: { tag?: string, pixivTag?: string }): void {
    const query: Record<string, string> = {};

    if (next.tag) {
        query.tag = next.tag;
    }
    if (next.pixivTag) {
        query.pixivTag = next.pixivTag;
    }

    void router.push({
        path: `/albums/${albumId.value}`,
        ...(Object.keys(query).length > 0 ? { query } : {}),
    });
}

const selectedTag = computed<string | undefined>({
    get: () => tagId.value,
    set: (value) => {
        pushFilterQuery({ tag: value, pixivTag: pixivTagId.value });
    },
});

const selectedPixivTag = computed<string | undefined>({
    get: () => pixivTagId.value,
    set: (value) => {
        pushFilterQuery({ tag: tagId.value, pixivTag: value });
    },
});

const sortOptions = computed(() => [
    { value: 'newest', label: t('album.sortNewest') },
    { value: 'oldest', label: t('album.sortOldest') },
    { value: 'taken', label: t('album.sortTaken') },
    { value: 'name', label: t('album.sortName') },
    ...(album.value?.settings.pixivEnabled
        ? [{ value: 'pixiv', label: t('album.sortPixiv') }]
        : []),
]);

const aiMenuItems = computed(() => [
    { key: 'zero-shot', label: t('settings.zeroShot') },
    { key: 'generative', label: t('settings.generative') },
    { key: 'external', label: t('settings.external') },
]);

function assetQuery(nextCursor?: string) {
    const [sortField, order]: ['addedAt' | 'takenAt' | 'filename' | 'pixivId', 'asc' | 'desc'] = sort.value === 'newest'
        ? ['addedAt', 'desc']
        : sort.value === 'oldest'
            ? ['addedAt', 'asc']
            : sort.value === 'taken'
                ? ['takenAt', 'desc']
                : sort.value === 'pixiv'
                    ? ['pixivId', 'desc']
                    : ['filename', 'asc'];

    return {
        limit: String(pageSize.value),
        sort: sortField,
        order,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        ...(tagId.value ? { tagId: tagId.value } : {}),
        ...(pixivTagId.value ? { pixivTag: pixivTagId.value } : {}),
        ...(search.value.trim() ? { q: search.value.trim() } : {}),
        ...(favoritesOnly.value ? { favorite: 'true' as const } : {}),
    };
}

async function loadPixivTags(): Promise<void> {
    if (!album.value?.settings.pixivEnabled) {
        pixivTags.value = [];

        return;
    }

    try {
        const response = await api.albums[':albumId'].pixiv.tags.$get({
            param: { albumId: albumId.value },
        });
        const body = await response.json();

        pixivTags.value = body.data;
    }
    catch {
        // 标签筛选是辅助能力：失败时保留应用标签，不影响照片列表
        pixivTags.value = [];
    }
}

watch(album, (value, previous) => {
    if (value?.settings.pixivEnabled !== previous?.settings.pixivEnabled) {
        void loadPixivTags();
    }

    // 启用 Pixiv 的相册默认按作品 ID 从大到小；用户手动选过排序时尊重已保存值
    if (!value) {
        return;
    }

    if (!value.settings.pixivEnabled) {
        if (pixivTagId.value) {
            pushFilterQuery({ tag: tagId.value });
        }
        if (sort.value === 'pixiv') {
            sort.value = 'newest';
        }

        return;
    }

    // 启用 Pixiv 的相册默认按作品 ID 从大到小；用户手动选过排序时尊重已保存值
    if (
        !previous
        && value.settings.pixivEnabled
        && sort.value === 'newest'
        && (!import.meta.client || localStorage.getItem(`${SORT_STORAGE_KEY}:${albumId.value}`) === null)
    ) {
        sort.value = 'pixiv';
    }
}, { immediate: true });

async function reload(force = false): Promise<void> {
    initialLoading.value = true;

    try {
        await Promise.all([loadContext(force), loadAssets(true)]);
        void loadPixivTags();
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
        initialLoading.value = false;
    }
}

function viewerListQuery(): Record<string, string> {
    const query: Record<string, string> = {
        sort: assetQuery().sort,
        order: assetQuery().order,
    };

    if (tagId.value) {
        query.tag = tagId.value;
    }
    if (pixivTagId.value) {
        query.pixivTag = pixivTagId.value;
    }
    if (search.value.trim()) {
        query.q = search.value.trim();
    }
    if (favoritesOnly.value) {
        query.favorite = '1';
    }

    return query;
}

function openAsset(assetId: string): void {
    void router.push({
        path: `/albums/${albumId.value}/assets/${assetId}`,
        query: viewerListQuery(),
    });
}

async function removeAsset(assetId: string): Promise<void> {
    try {
        await api.albums[':albumId'].assets[':assetId'].$delete({
            param: { albumId: albumId.value, assetId },
        });
        assets.value = assets.value.filter(asset => asset.id !== assetId);
        await Promise.all([loadContext(true), loadAssets(true)]);
    }
    catch (removeError) {
        error.value = errorMessage(removeError);
    }
}

const selectedAssets = computed(() => assets.value.filter(item => selectedIds.value.has(item.id)));
const batchPercent = computed(() => (
    batchProgress.value.total > 0 ? Math.round((batchProgress.value.done / batchProgress.value.total) * 100) : 0
));
const renamePreview = computed(() => {
    const list = selectedAssets.value;
    const first = list.at(0);
    const last = list.at(-1);

    if (!first || !last) {
        return '';
    }

    const build = (index: number, asset: AssetSummaryDto): string => {
        const number = String((renameStart.value ?? 1) + index).padStart(renamePadding.value ?? 3, '0');
        const ext = asset.ext ? `.${asset.ext}` : '';

        return `${renamePrefix.value.trim()}${number}${ext}`;
    };

    return t('asset.renamePreview', { first: build(0, first), last: build(list.length - 1, last) });
});

function toggleSelectMode(): void {
    selectMode.value = !selectMode.value;
    selectedIds.value = new Set();
    notice.value = '';
}

function toggleSelect(assetId: string): void {
    const next = new Set(selectedIds.value);

    if (next.has(assetId)) {
        next.delete(assetId);
    }
    else {
        next.add(assetId);
    }

    selectedIds.value = next;
}

function selectAllVisible(): void {
    selectedIds.value = new Set(assets.value.map(item => item.id));
}

function openRename(): void {
    notice.value = '';
    renameOpen.value = true;
}

async function renameSelected(): Promise<void> {
    // 按网格顺序编号，与重命名预览保持一致（Set 顺序是点击顺序）
    const ids = selectedAssets.value.map(item => item.id);

    if (ids.length === 0) {
        return;
    }

    renaming.value = true;
    error.value = '';

    try {
        const updated: AssetSummaryDto[] = [];
        let nextStart = renameStart.value ?? 1;

        for (let index = 0; index < ids.length; index += 500) {
            const chunk = ids.slice(index, index + 500);
            const response = await api.albums[':albumId'].assets.$patch({
                param: { albumId: albumId.value },
                json: {
                    ids: chunk,
                    prefix: renamePrefix.value.trim(),
                    start: nextStart,
                    padding: renamePadding.value ?? 3,
                },
            });
            const body: { data: AssetSummaryDto[] } = await response.json();

            updated.push(...body.data);
            nextStart += chunk.length;
        }

        const byId = new Map(updated.map(item => [item.id, item]));

        assets.value = assets.value.map(item => byId.get(item.id) ?? item);
        notice.value = t('asset.renameApplied', { count: updated.length });
        renameOpen.value = false;
        selectedIds.value = new Set();
        await loadContext(true);
    }
    catch (renameError) {
        error.value = errorMessage(renameError);
    }
    finally {
        renaming.value = false;
    }
}

async function deleteSelected(): Promise<void> {
    const ids = [...selectedIds.value];

    if (ids.length === 0) {
        return;
    }

    batchDeleting.value = true;
    error.value = '';
    batchProgress.value = { total: ids.length, done: 0 };

    try {
        // 后端单次最多 1000 条，自动滚动加载后全选可能远超上限
        for (let index = 0; index < ids.length; index += 1000) {
            const chunk = ids.slice(index, index + 1000);

            await api.albums[':albumId'].assets['batch-delete'].$post({
                param: { albumId: albumId.value },
                json: { ids: chunk, confirm: true },
            });
            batchProgress.value = { total: ids.length, done: index + chunk.length };
        }

        selectedIds.value = new Set();
        await reload();
    }
    catch (deleteError) {
        error.value = errorMessage(deleteError);
        await reload();
    }
    finally {
        batchDeleting.value = false;
        batchProgress.value = { total: 0, done: 0 };
    }
}

function openBatchTags(): void {
    batchTagIds.value = [];
    batchTagOpen.value = true;
}

async function applyBatchTags(): Promise<void> {
    const ids = [...selectedIds.value];

    if (ids.length === 0 || batchTagIds.value.length === 0) {
        return;
    }

    batchTagging.value = true;
    error.value = '';

    try {
        let linked = 0;

        // 后端单次最多 500 条
        for (let index = 0; index < ids.length; index += 500) {
            const response = await api.albums[':albumId'].assets['batch-tags'].$post({
                param: { albumId: albumId.value },
                json: { ids: ids.slice(index, index + 500), addTagIds: batchTagIds.value },
            });
            const body = await response.json();

            linked += body.data.linked;
        }

        notice.value = t('asset.batchTagDone', { count: linked });
        batchTagOpen.value = false;
        selectedIds.value = new Set();
        await loadContext(true);
    }
    catch (tagError) {
        error.value = errorMessage(tagError);
    }
    finally {
        batchTagging.value = false;
    }
}

async function setCoverFromSelection(): Promise<void> {
    // Set 保持点选顺序：把最先选中的那张设为封面
    const [first] = [...selectedIds.value];

    if (!first) {
        return;
    }

    batchCovering.value = true;
    error.value = '';

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: albumId.value },
            json: { coverAssetId: first },
        });
        notice.value = t('asset.coverSaved');
        await loadContext(true);
    }
    catch (coverError) {
        error.value = errorMessage(coverError);
    }
    finally {
        batchCovering.value = false;
    }
}

async function startAi(info: { key: string | number }): Promise<void> {
    const mode = String(info.key);

    if (mode !== 'zero-shot' && mode !== 'generative' && mode !== 'external') {
        return;
    }

    error.value = '';

    try {
        await api.albums[':albumId'].ai.tag.$post({
            param: { albumId: albumId.value },
            json: { mode },
        });
        await router.push(`/albums/${albumId.value}/jobs`);
    }
    catch (aiError) {
        error.value = errorMessage(aiError);
    }
}

function openImport(): void {
    importError.value = '';
    importOpen.value = true;
}

async function startImport(): Promise<void> {
    if (importRoot.value.trim() === '') {
        importError.value = t('album.importRootMissing');

        return;
    }

    importing.value = true;
    importError.value = '';

    try {
        await api.albums[':albumId'].imports.$post({
            param: { albumId: albumId.value },
            json: { rootPath: importRoot.value.trim(), resume: importResume.value },
        });
        importOpen.value = false;
        await router.push(`/albums/${albumId.value}/jobs`);
    }
    catch (startError) {
        importError.value = errorMessage(startError);
    }
    finally {
        importing.value = false;
    }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(search, () => {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }

    if (suppressListLoad.value) {
        return;
    }

    searchTimer = setTimeout(() => {
        void loadAssets(true);
    }, 300);
});

watch([sort, tagId, pixivTagId, favoritesOnly], () => {
    if (suppressListLoad.value) {
        return;
    }

    void loadAssets(true);
});

/** 按相册记住排序/搜索/收藏筛选，离开再回来不会退回默认顺序 */
watch([sort, search, favoritesOnly], () => {
    if (!import.meta.client || suppressListLoad.value) {
        return;
    }

    const id = albumId.value;

    localStorage.setItem(`${SORT_STORAGE_KEY}:${id}`, sort.value);
    localStorage.setItem(`${SEARCH_STORAGE_KEY}:${id}`, search.value);
    localStorage.setItem(`${FAVORITES_STORAGE_KEY}:${id}`, favoritesOnly.value ? '1' : '0');
});

function restoreListPreferences(): void {
    if (!import.meta.client) {
        return;
    }

    const id = albumId.value;
    const storedSort = localStorage.getItem(`${SORT_STORAGE_KEY}:${id}`);

    suppressListLoad.value = true;

    if (storedSort === 'newest' || storedSort === 'oldest' || storedSort === 'taken' || storedSort === 'name' || storedSort === 'pixiv') {
        sort.value = storedSort;
    }

    search.value = localStorage.getItem(`${SEARCH_STORAGE_KEY}:${id}`) ?? '';
    favoritesOnly.value = localStorage.getItem(`${FAVORITES_STORAGE_KEY}:${id}`) === '1';

    // 等本次响应式刷新和 onMounted 的首次加载排完再恢复自动加载
    setTimeout(() => {
        suppressListLoad.value = false;
    }, 0);
}

async function toggleFavorite(assetId: string, favorite: boolean): Promise<void> {
    try {
        const response = await api.albums[':albumId'].assets[':assetId'].$patch({
            param: { albumId: albumId.value, assetId },
            json: { favorite },
        });
        const body = await response.json();

        if (!favorite && favoritesOnly.value) {
            assets.value = assets.value.filter(item => item.id !== assetId);
        }
        else {
            assets.value = assets.value.map(item => (item.id === assetId ? body.data : item));
        }
    }
    catch (favoriteError) {
        error.value = errorMessage(favoriteError);
    }
}

function clampGridColumns(value: number): number {
    return clampGridColumnsTo(value, MIN_GRID_COLUMNS, maxGridColumns.value);
}

function defaultGridColumns(): number {
    if (!import.meta.client) {
        return 5;
    }

    const width = window.innerWidth;

    if (width < 600) {
        return 2;
    }
    if (width < 840) {
        return 3;
    }
    if (width < 1280) {
        return 4;
    }

    return 5;
}

function setGridColumns(value: number): void {
    gridColumns.value = clampGridColumns(value);
}

function bumpGridColumns(delta: number): void {
    setGridColumns(gridColumns.value + delta);
}

function applyGridColumnsSoon(): void {
    if (!import.meta.client) {
        appliedGridColumns.value = gridColumns.value;

        return;
    }

    if (gridApplyTimer) {
        clearTimeout(gridApplyTimer);
    }

    // 滚轮/捏合是连续事件；停手 90ms 后再重排，避免每次按键都 O(n) 重建数万条布局。
    // 不用 rAF：后台标签页 rAF 会被冻结，尾沿延迟用 setTimeout 才可靠。
    gridApplyTimer = setTimeout(() => {
        gridApplyTimer = null;
        appliedGridColumns.value = gridColumns.value;
    }, 90);
}

function setViewMode(mode: AlbumViewMode): void {
    if (viewMode.value === mode) {
        return;
    }

    viewMode.value = mode;

    // 切到矩阵时立刻按当前列数布局，别先按旧列数闪一下
    appliedGridColumns.value = gridColumns.value;

    // 矩阵一屏要铺的条目多得多，切过去时补一页更大的数据
    if (pageSize.value > loadedPageSize) {
        void loadAssets(true);
    }
}

function loadViewPreferences(): void {
    viewMode.value = readStoredViewMode(VIEW_MODE_KEY, GRID_VIEW_MODES, 'masonry');
    gridColumns.value = readStoredGridColumns(
        GRID_COLUMNS_KEY,
        MIN_GRID_COLUMNS,
        MAX_GRID_COLUMNS,
        defaultGridColumns(),
    );
    appliedGridColumns.value = gridColumns.value;
}

function onGridWheel(event: WheelEvent): void {
    if (viewMode.value !== 'grid' || !(event.ctrlKey || event.metaKey || event.altKey)) {
        return;
    }
    if (event.deltaY === 0) {
        return;
    }

    event.preventDefault();
    // 向上滚放大（列数变少），向下滚缩小（列数变多）
    bumpGridColumns(event.deltaY < 0 ? -1 : 1);
}

function touchDistance(touches: TouchList): number {
    const first = touches.item(0);
    const second = touches.item(1);

    if (!first || !second) {
        return 0;
    }

    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function onGridTouchStart(event: TouchEvent): void {
    if (viewMode.value !== 'grid' || event.touches.length !== 2) {
        pinchState = null;

        return;
    }

    pinchState = {
        distance: touchDistance(event.touches),
        columns: gridColumns.value,
    };
}

function onGridTouchMove(event: TouchEvent): void {
    if (viewMode.value !== 'grid' || !pinchState || event.touches.length !== 2) {
        return;
    }

    const distance = touchDistance(event.touches);

    if (distance <= 0 || pinchState.distance <= 0) {
        return;
    }

    if (event.cancelable) {
        event.preventDefault();
    }

    const next = Math.round(pinchState.columns * (pinchState.distance / distance));

    if (next !== gridColumns.value) {
        setGridColumns(next);
    }
}

function onGridTouchEnd(event: TouchEvent): void {
    if (event.touches.length < 2) {
        pinchState = null;
    }
}

watch([viewMode, gridColumns], () => {
    persistViewPreferences(VIEW_MODE_KEY, GRID_COLUMNS_KEY, viewMode.value, gridColumns.value);
});

watch(gridColumns, () => {
    applyGridColumnsSoon();
});

watch(maxGridColumns, (max) => {
    if (gridColumns.value > max) {
        gridColumns.value = max;
    }
});

function onViewportResize(): void {
    viewportWidth.value = window.innerWidth;
}

useHead({
    title: () => `${album.value?.name ?? t('album.title')} · PictureX`,
});

function applyPendingListMutations(items: AssetSummaryDto[]): AssetSummaryDto[] {
    const { removals, patches } = consumeListMutations(albumId.value);

    if (removals.size === 0 && patches.size === 0) {
        return items;
    }

    const next = items
        .filter(item => !removals.has(item.id))
        .map(item => patches.get(item.id) ?? item);

    // 收藏筛选下取消收藏后，该资产应立即从当前列表消失
    return favoritesOnly.value ? next.filter(item => item.favorite) : next;
}

function restoreListSnapshot(): boolean {
    const snapshot = getListSnapshot(albumId.value);

    if (!snapshot || snapshot.signature !== listSignature.value) {
        // 筛选条件已变化或没有快照：丢弃队列，按新条件重新加载
        consumeListMutations(albumId.value);
        removeListSnapshot(albumId.value);

        return false;
    }

    hydrateAssets({
        items: applyPendingListMutations(snapshot.items),
        nextCursor: snapshot.nextCursor,
        hasMore: snapshot.hasMore,
    });
    loadedPageSize = pageSize.value;
    initialScrollTop.value = snapshot.scrollTop;
    void loadContext(true);

    return true;
}

function saveListSnapshot(): void {
    const snapshot: AlbumListSnapshot = {
        signature: listSignature.value,
        items: assets.value,
        nextCursor: assetsCursor.value,
        hasMore: hasMore.value,
        scrollTop: masonryRef.value?.getScrollTop() ?? 0,
    };

    setListSnapshot(albumId.value, snapshot);
}

onMounted(() => {
    loadViewPreferences();
    restoreListPreferences();
    viewportWidth.value = window.innerWidth;
    window.addEventListener('resize', onViewportResize);

    if (gridWrap.value) {
        gridObserver = new ResizeObserver((entries) => {
            gridWrapWidth.value = entries[0]?.contentRect.width ?? gridWrap.value?.clientWidth ?? 0;
        });
        gridObserver.observe(gridWrap.value);
        gridWrapWidth.value = gridWrap.value.clientWidth;
    }

    if (!restoreListSnapshot()) {
        void reload();
    }
});

onBeforeRouteLeave((to) => {
    // 只有进入单图查看器才保留现场；退出相册/切到其它模块时释放内存
    if (to.path.startsWith(`/albums/${albumId.value}/assets/`)) {
        saveListSnapshot();
    }
    else {
        removeListSnapshot(albumId.value);
    }
});

onBeforeUnmount(() => {
    window.removeEventListener('resize', onViewportResize);
    gridObserver?.disconnect();
    gridObserver = null;

    if (gridApplyTimer) {
        clearTimeout(gridApplyTimer);
        gridApplyTimer = null;
    }

    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
});
</script>

<template>
    <div class="album-page px-page-fill">
        <header class="album-header">
            <div class="album-header__top">
                <div class="px-page-header__main">
                    <h1 class="px-page-title">
                        {{ album?.name ?? '…' }}
                    </h1>
                    <p class="px-page-subtitle">
                        {{ album ? t('album.statAssets', { count: album.assetCount }) : '' }}
                    </p>
                </div>

                <div class="px-header-actions">
                    <a-dropdown :trigger="['click']" :menu="{ items: aiMenuItems, onClick: startAi }">
                        <a-button>
                            <template #icon>
                                <ThunderboltOutlined />
                            </template>
                            {{ t('album.aiTag') }}
                        </a-button>
                    </a-dropdown>
                    <a-button :aria-label="t('asset.batchManage')" @click="toggleSelectMode">
                        <template #icon>
                            <CloseOutlined v-if="selectMode" />
                            <CheckSquareOutlined v-else />
                        </template>
                        <template v-if="!selectMode">
                            {{ t('asset.batchManage') }}
                        </template>
                    </a-button>
                    <a-button :aria-label="t('common.refresh')" :loading="initialLoading" @click="reload(true)">
                        <template #icon>
                            <ReloadOutlined />
                        </template>
                    </a-button>
                    <a-button type="primary" :aria-label="t('a11y.importButton')" @click="openImport">
                        <template #icon>
                            <SyncOutlined />
                        </template>
                        {{ t('album.import') }}
                    </a-button>
                </div>
            </div>

            <div class="album-filters">
                <a-input
                    v-model:value="search"
                    :placeholder="t('album.searchPlaceholder')"
                    allow-clear
                    class="album-filters__search"
                >
                    <template #prefix>
                        <SearchOutlined />
                    </template>
                </a-input>
                <a-select
                    v-model:value="selectedTag"
                    :options="tagFilterOptions"
                    :placeholder="t('album.filterByTag')"
                    allow-clear
                    option-filter-prop="label"
                    class="album-filters__tag"
                />
                <a-select
                    v-if="album?.settings.pixivEnabled"
                    v-model:value="selectedPixivTag"
                    :options="pixivTagFilterOptions"
                    :placeholder="t('album.filterByPixivTag')"
                    allow-clear
                    option-filter-prop="label"
                    class="album-filters__tag"
                />
                <a-checkbox v-model:checked="favoritesOnly" class="album-filters__favorite">
                    {{ t('album.favoritesOnly') }}
                </a-checkbox>
                <a-select
                    v-model:value="sort"
                    :options="sortOptions"
                    class="album-filters__sort"
                />
                <div class="album-view" role="group" :aria-label="t('album.viewMode')">
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
                        :title="t('album.gridHint')"
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
                <div
                    v-if="viewMode === 'grid'"
                    class="album-grid-size"
                    :title="t('album.gridMax', { max: maxGridColumns })"
                >
                    <a-button
                        size="small"
                        type="text"
                        :aria-label="t('album.gridColumnsDecrease')"
                        :disabled="gridColumns <= MIN_GRID_COLUMNS"
                        @click="bumpGridColumns(-1)"
                    >
                        <MinusOutlined />
                    </a-button>
                    <span class="album-grid-size__value">{{ gridColumns }}</span>
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
            </div>

            <div v-if="selectMode" class="album-batch px-surface">
                <span class="album-batch__count">
                    {{ t('asset.selectedCount', { count: selectedIds.size }) }}
                </span>
                <a-button size="small" @click="selectAllVisible">
                    {{ t('a11y.selectAll') }}
                </a-button>
                <a-button size="small" :disabled="selectedIds.size === 0" @click="openBatchTags">
                    <template #icon>
                        <TagOutlined />
                    </template>
                    {{ t('asset.batchTag') }}
                </a-button>
                <a-button size="small" :disabled="selectedIds.size === 0" @click="openRename">
                    <template #icon>
                        <EditOutlined />
                    </template>
                    {{ t('asset.batchRename') }}
                </a-button>
                <a-button
                    size="small"
                    :disabled="selectedIds.size === 0"
                    :loading="batchCovering"
                    @click="setCoverFromSelection"
                >
                    <template #icon>
                        <FileImageOutlined />
                    </template>
                    {{ t('asset.batchSetCover') }}
                </a-button>
                <a-popconfirm
                    :title="t('asset.batchDeleteConfirm', { count: selectedIds.size })"
                    :ok-text="t('common.delete')"
                    :cancel-text="t('common.cancel')"
                    :disabled="selectedIds.size === 0"
                    @confirm="deleteSelected"
                >
                    <a-button size="small" danger :disabled="selectedIds.size === 0" :loading="batchDeleting">
                        <template #icon>
                            <DeleteOutlined />
                        </template>
                        {{ t('asset.batchDelete') }}
                    </a-button>
                </a-popconfirm>
                <span class="album-batch__spacer" />
                <a-button size="small" type="text" @click="toggleSelectMode">
                    {{ t('common.cancel') }}
                </a-button>
            </div>

            <a-progress
                v-if="batchDeleting && batchProgress.total > 0"
                :percent="batchPercent"
                size="small"
                :format="() => `${batchProgress.done} / ${batchProgress.total}`"
            />
        </header>

        <a-alert
            v-if="notice"
            type="success"
            show-icon
            closable
            :message="notice"
            @close="notice = ''"
        />

        <a-alert
            v-if="error"
            type="error"
            show-icon
            closable
            :message="error"
            @close="error = ''"
        >
            <template #action>
                <a-button size="small" @click="reload(true)">
                    {{ t('common.retry') }}
                </a-button>
            </template>
        </a-alert>

        <div
            ref="gridWrap"
            class="album-grid-wrap px-page-fill__body"
            :class="{
                'album-grid-wrap--grid': viewMode === 'grid',
                'album-grid-wrap--list': viewMode === 'list',
            }"
            @wheel="onGridWheel"
            @touchstart="onGridTouchStart"
            @touchmove="onGridTouchMove"
            @touchend="onGridTouchEnd"
            @touchcancel="onGridTouchEnd"
        >
            <Transition name="album-view" mode="out-in">
                <VirtualMasonry
                    ref="masonryRef"
                    :key="viewMode"
                    :initial-scroll-top="initialScrollTop"
                    :items="assets"
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
                    :aria-label="t('a11y.assetGrid')"
                    @load-more="loadAssets(false)"
                >
                    <template #default="{ item, width, height }">
                        <AssetListRow
                            v-if="viewMode === 'list'"
                            :asset="item"
                            :album-id="albumId"
                            :height="height"
                            :selectable="selectMode"
                            :selected="selectedIds.has(item.id)"
                            @open="openAsset"
                            @delete="removeAsset"
                            @toggle="toggleSelect"
                            @favorite="toggleFavorite"
                        />
                        <AssetGridTile
                            v-else-if="viewMode === 'grid'"
                            :asset="item"
                            :album-id="albumId"
                            :width="width"
                            :height="height"
                            :selectable="selectMode"
                            :selected="selectedIds.has(item.id)"
                            @open="openAsset"
                            @toggle="toggleSelect"
                        />
                        <AssetTile
                            v-else
                            :asset="item"
                            :album-id="albumId"
                            :width="width"
                            :height="height"
                            :selectable="selectMode"
                            :selected="selectedIds.has(item.id)"
                            @open="openAsset"
                            @delete="removeAsset"
                            @toggle="toggleSelect"
                            @favorite="toggleFavorite"
                        />
                    </template>
                    <template #empty>
                        <div class="px-empty-state px-empty-state--fill">
                            <a-empty :description="emptyHint" />
                        </div>
                    </template>
                </VirtualMasonry>
            </Transition>

            <div v-if="initialLoading" class="px-loading-overlay">
                <a-spin />
            </div>
        </div>

        <a-modal
            v-model:open="importOpen"
            :title="t('album.importTitle')"
            :ok-text="t('album.import')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="importing"
            @ok="startImport"
        >
            <div class="import-form">
                <p class="import-form__hint">
                    {{ t('album.importHint') }}
                </p>
                <div class="import-form__row">
                    <a-input
                        v-model:value="importRoot"
                        :placeholder="t('album.importRootPlaceholder')"
                        :maxlength="4096"
                    />
                    <a-button @click="importPickerOpen = true">
                        {{ t('album.browse') }}
                    </a-button>
                </div>
                <label class="import-form__resume">
                    <a-switch v-model:checked="importResume" size="small" />
                    <span>{{ t('album.importResume') }}</span>
                </label>
                <a-alert v-if="importError" type="error" :message="importError" show-icon />
            </div>
        </a-modal>

        <a-modal
            v-model:open="batchTagOpen"
            :title="t('asset.batchTagTitle')"
            :ok-text="t('common.confirm')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="batchTagging"
            :ok-button-props="{ disabled: batchTagIds.length === 0 }"
            @ok="applyBatchTags"
        >
            <a-select
                v-model:value="batchTagIds"
                mode="multiple"
                :options="tagFilterOptions"
                :placeholder="t('asset.batchTagPlaceholder')"
                option-filter-prop="label"
                class="batch-tag-select"
            />
        </a-modal>

        <a-modal
            v-model:open="renameOpen"
            :title="t('asset.batchRename')"
            :ok-text="t('common.confirm')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="renaming"
            @ok="renameSelected"
        >
            <div class="rename-form">
                <label class="rename-form__field">
                    <span>{{ t('asset.renamePrefix') }}</span>
                    <a-input v-model:value="renamePrefix" :maxlength="80" allow-clear />
                </label>
                <label class="rename-form__field">
                    <span>{{ t('asset.renameStart') }}</span>
                    <a-input-number v-model:value="renameStart" :min="0" :max="1000000000" />
                </label>
                <label class="rename-form__field">
                    <span>{{ t('asset.renamePadding') }}</span>
                    <a-input-number v-model:value="renamePadding" :min="1" :max="6" />
                </label>
                <p class="rename-form__preview">
                    {{ renamePreview }}
                </p>
            </div>
        </a-modal>

        <DirectoryPicker
            v-model:open="importPickerOpen"
            mode="directory"
            :initial-path="importRoot || undefined"
            @select="importRoot = $event"
        />
    </div>
</template>

<style scoped>
.album-header {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.album-header__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.album-filters {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.album-filters__search {
    width: calc(var(--px-layout-card-min) - var(--px-space-1));
    max-width: 100%;
}

.album-filters__tag {
    width: calc(var(--px-layout-card-min) / 2);
    min-width: var(--px-layout-tile-min);
    max-width: 100%;
}

.album-filters__sort {
    min-width: calc(var(--px-layout-card-min) / 2 - var(--px-space-2));
}

.album-filters__favorite {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}

.album-view,
.album-grid-size {
    display: flex;
    align-items: center;
    gap: var(--px-space-1);
    padding: var(--px-space-1);
    border-radius: var(--px-radius-full);
    background: var(--px-color-bg-sunken);
}

.album-view :deep(.ant-btn) {
    border-radius: var(--px-radius-full);
}

/* 手机：视图组与列数按钮放大到 40vp 触控目标 */
@media (max-width: 599px) {
    .album-view :deep(.ant-btn),
    .album-grid-size :deep(.ant-btn) {
        min-width: var(--px-control-height);
        min-height: var(--px-control-height);
    }
}

.album-grid-size {
    padding-inline: var(--px-space-2);
    color: var(--px-color-text-secondary);
}

.album-grid-size__value {
    min-width: var(--px-space-5);
    text-align: center;
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-caption);
}

.album-grid-wrap--grid {
    touch-action: pan-y;
}

.album-view-enter-active,
.album-view-leave-active {
    transition:
        opacity var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        transform var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.album-view-enter-from {
    opacity: 0;
    transform: translateY(var(--px-space-1));
}

.album-view-leave-to {
    opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
    .album-view-enter-active,
    .album-view-leave-active {
        transition: none;
    }
}

.import-form {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.import-form__hint {
    margin: 0;
    color: var(--px-color-text-secondary);
    line-height: var(--px-line-height-relaxed);
}

.import-form__row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.import-form__row :deep(.ant-input) {
    flex: 1;
}

.import-form__resume {
    display: inline-flex;
    align-items: center;
    gap: var(--px-space-2);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}

.album-batch {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
    padding: var(--px-space-2) var(--px-space-3);
}

.album-batch__count {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.album-batch__spacer {
    flex: 1;
}

/* 手机：批量操作按钮放大到 40vp 触控目标，与视图切换保持一致 */
@media (max-width: 599px) {
    .album-batch :deep(.ant-btn) {
        min-height: var(--px-control-height);
    }
}

.batch-tag-select {
    width: 100%;
}

.rename-form {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.rename-form__field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}

.rename-form__field :deep(.ant-input-number) {
    width: calc(var(--px-layout-card-min) / 2);
}

.rename-form__preview {
    margin: 0;
    padding: var(--px-space-2) var(--px-space-3);
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-secondary);
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-caption);
    overflow-wrap: anywhere;
}
</style>
