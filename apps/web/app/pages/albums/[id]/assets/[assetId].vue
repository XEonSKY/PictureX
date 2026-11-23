<script setup lang="ts">
import {
    ArrowLeftOutlined,
    ArrowRightOutlined,
    CloseOutlined,
    DeleteOutlined,
    DownloadOutlined,
    EditOutlined,
    FullscreenOutlined,
    InfoCircleOutlined,
    PictureOutlined,
    PlayCircleOutlined,
    QuestionCircleOutlined,
    ReloadOutlined,
    StarFilled,
    StarOutlined,
    ZoomInOutlined,
    ZoomOutOutlined,
} from '@antdv-next/icons';
import { formatPixivDisplayName, isPixivAiGenerated, pickPixivTagName } from '~~/shared/pixiv';
import { resolveViewerShortcut, stepZoom } from '~/utils/viewer';
import type { SimilarAssetDto, SimilarGroupDto } from '~/utils/similar-groups';
import type { TagRecord } from '~~/server/album/album-store';
import type { AssetDetailDto, AssetSummaryDto } from '~~/server/domain/asset-query';
import type { AssetPixivContextDto, PixivLocalPage } from '~~/server/pixiv/types';

interface AssetNeighborsDto {
    previous: AssetSummaryDto | null
    next: AssetSummaryDto | null
    previousItems: AssetSummaryDto[]
    nextItems: AssetSummaryDto[]
    index: number
    total: number
    scope: string
}

definePageMeta({
    layout: 'album',
    // 查看器内切图依赖路由参数更新，页面过渡会延迟同一查看器的新图挂载
    pageTransition: false,
});

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const router = useRouter();
const { formatBytes, formatDateTime, formatDuration, formatNumber } = useFormat();

const albumId = computed(() => String(route.params.id));
const { album, load: reloadAlbumContext } = useAlbumContext(albumId);
const { removeAsset: removeAssetFromList, patchAsset: patchAssetInList } = useAlbumListSync();
const assetId = computed(() => String(route.params.assetId));

const asset = ref<AssetDetailDto | null>(null);
const pendingAsset = ref<AssetSummaryDto | null>(null);
// 当前正在看的资产：本地切图时先于路由更新，所有内容 URL 都按它生成
const viewingId = ref(assetId.value);
const nav = ref<AssetNeighborsDto | null>(null);
const allTags = ref<TagRecord[]>([]);
const similar = ref<SimilarAssetDto[]>([]);
const loading = ref(true);
const error = ref('');
const imageFailed = ref(false);
const imageLoaded = ref(false);
const imageElement = ref<HTMLImageElement | null>(null);
const previewReady = ref(false);
const previewElement = ref<HTMLImageElement | null>(null);
const showBusy = ref(false);
let busyTimer: ReturnType<typeof setTimeout> | null = null;
const livePlaying = ref(false);
const coverSaving = ref(false);
const favoriteSaving = ref(false);
const pendingTag = ref<string | undefined>(undefined);
const notice = ref('');

const ugoiraCanvas = ref<HTMLCanvasElement | null>(null);
const {
    loading: ugoiraLoading,
    playing: ugoiraPlaying,
    failed: ugoiraFailed,
    toggle: toggleUgoira,
    stop: stopUgoira,
} = useUgoiraPlayer(ugoiraCanvas);

const pixiv = ref<AssetPixivContextDto | null>(null);
const pixivLoading = ref(false);
const pixivSyncing = ref(false);
const pixivError = ref('');
const pixivNotice = ref('');
let pixivToken = 0;

const pixivEnabled = computed(() => album.value?.settings.pixivEnabled === true);
const pixivAutoDownload = computed(() => album.value?.settings.pixivAutoDownload === true);
const pixivIllust = computed(() => (pixiv.value?.pixiv ? pixiv.value.illust : null));
const pixivPageIndex = computed(() => (pixiv.value?.pixiv ? pixiv.value.pageIndex : -1));
const pixivMissing = computed(() => (pixiv.value?.pixiv ? pixiv.value.missingPages : []));
const pixivAuthRequired = computed(() => Boolean(pixiv.value?.pixiv && pixiv.value.authRequired));
const pixivInvalid = computed(() => Boolean(pixiv.value?.pixiv && pixiv.value.invalid));
const canPlayUgoira = computed(() => Boolean(pixivIllust.value?.ugoira));
const ugoiraUrl = computed(() => (
    `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/pixiv/ugoira`
));

const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
const dragging = ref(false);
const swiping = ref(false);
const swipeOffsetX = ref(0);
let swipeStart: { x: number, y: number, at: number } | null = null;
const SWIPE_THRESHOLD = 60;
const deleteOpen = ref(false);
const deleting = ref(false);
const infoOpen = ref(false);
const shortcutsOpen = ref(false);
let wideInfoQuery: MediaQueryList | null = null;

function onWideInfoChange(event: MediaQueryListEvent): void {
    infoOpen.value = event.matches;

    if (event.matches) {
        void hydrateInfo();
    }
}
const renameOpen = ref(false);
const renameValue = ref('');
const renaming = ref(false);

let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

const fileUrl = computed(() => `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/file`);
const liveUrl = computed(() => `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/live`);
const previewUrl = computed(() => `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/thumbnail?size=512`);
const displayName = computed(() => (
    pendingAsset.value?.displayName
    ?? asset.value?.displayName
    ?? pendingAsset.value?.filename
    ?? asset.value?.filename
    ?? '…'
));
const previewFileUrl = computed(() => `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/preview`);
const streamUrl = computed(() => `/api/v1/albums/${albumId.value}/assets/${viewingId.value}/stream`);
const isVideo = computed(() => asset.value?.kind === 'video');
const hasLive = computed(() => Boolean(asset.value?.live));
const PREVIEW_EXTENSIONS = new Set(['heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'pef', 'srw', 'raw']);
const hasPreview = computed(() => (
    pendingAsset.value
        ? PREVIEW_EXTENSIONS.has(pendingAsset.value.ext.toLowerCase())
        : Boolean(asset.value?.preview)
));
const displayUrl = computed(() => (hasPreview.value ? previewFileUrl.value : fileUrl.value));
const downloadName = computed(() => asset.value?.filename ?? pendingAsset.value?.filename ?? 'picturex');
const previewDownloadName = computed(() => downloadName.value.replace(/\.[^.]+$/u, '') + '.jpg');

const fromSimilar = computed(() => route.query.from === 'similar');
const groupId = computed(() => (typeof route.query.group === 'string' ? route.query.group : ''));
function routeFilterValue(key: string): string {
    return typeof route.query[key] === 'string' ? route.query[key] : '';
}

// 写回地址栏时保持照片页的查询参数名（tag/pixivTag），否则翻页后筛选会丢失
const listRouteQuery = computed<Record<string, string>>(() => {
    const query: Record<string, string> = {
        sort: routeFilterValue('sort') || 'addedAt',
        order: route.query.order === 'asc' ? 'asc' : 'desc',
    };
    const tag = routeFilterValue('tag');
    const pixivTag = routeFilterValue('pixivTag');
    const q = routeFilterValue('q');

    if (tag) {
        query.tag = tag;
    }
    if (pixivTag) {
        query.pixivTag = pixivTag;
    }
    if (q) {
        query.q = q;
    }
    if (route.query.favorite === '1' || route.query.favorite === 'true') {
        query.favorite = '1';
    }

    return query;
});

// neighbors API 使用服务端字段名（tagId / favorite=true）
const listApiQuery = computed<Record<string, string>>(() => {
    const query: Record<string, string> = {
        sort: listRouteQuery.value.sort ?? 'addedAt',
        order: listRouteQuery.value.order ?? 'desc',
    };

    if (listRouteQuery.value.tag) {
        query.tagId = listRouteQuery.value.tag;
    }
    if (listRouteQuery.value.pixivTag) {
        query.pixivTag = listRouteQuery.value.pixivTag;
    }
    if (listRouteQuery.value.q) {
        query.q = listRouteQuery.value.q;
    }
    if (listRouteQuery.value.favorite) {
        query.favorite = 'true';
    }

    return query;
});
// 本地相邻序列：连续点击时直接推进，不等上一张的详情/路由就绪
const trail = shallowRef<AssetSummaryDto[]>([]);
const trailIndex = ref(-1);
const previousAsset = computed(() => trail.value[trailIndex.value - 1] ?? null);
const nextAsset = computed(() => trail.value[trailIndex.value + 1] ?? null);

const availableTags = computed(() => {
    const linked = new Set((asset.value?.tags ?? []).map(tag => tag.id));

    return allTags.value
        .filter(tag => !linked.has(tag.id))
        .map(tag => ({ value: tag.id, label: tag.name }));
});

const metaEntries = computed(() => {
    if (!asset.value) {
        return [];
    }

    return Object.entries(asset.value.meta).map(([key, value]) => ({
        key,
        value: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
    }));
});

function resetTransform(): void {
    scale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    swipeOffsetX.value = 0;
}

/** 命中缓存/水合前已经解码完成时 load 事件可能早于监听器，主动补一次状态 */
function syncImageLoaded(): void {
    const image = imageElement.value;

    if (image?.complete && image.naturalWidth > 0) {
        imageLoaded.value = true;
    }
}

function syncPreviewReady(): void {
    const preview = previewElement.value;

    if (preview?.complete && preview.naturalWidth > 0) {
        previewReady.value = true;
    }
}

function onPreviewLoad(): void {
    previewReady.value = true;
}

const targetIsVideo = computed(() => pendingAsset.value?.kind === 'video' || isVideo.value);

function clearBusy(): void {
    if (busyTimer) {
        clearTimeout(busyTimer);
        busyTimer = null;
    }

    showBusy.value = false;
}

// 预览源变化时先隐藏旧缩略图；若 120ms 内预览/原图都未就绪，再显示加载动画
watch(previewUrl, () => {
    previewReady.value = false;
    clearBusy();
    busyTimer = setTimeout(() => {
        busyTimer = null;

        if (!imageLoaded.value && !previewReady.value && !targetIsVideo.value && !imageFailed.value) {
            showBusy.value = true;
        }
    }, 120);
    void nextTick(syncPreviewReady);
}, { immediate: true });

watch([imageLoaded, previewReady, targetIsVideo, imageFailed], () => {
    if (imageLoaded.value || previewReady.value || targetIsVideo.value || imageFailed.value) {
        clearBusy();
    }
});

let loadToken = 0;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let urlTimer: ReturnType<typeof setTimeout> | null = null;
const DETAIL_LOAD_DELAY_MS = 180;
const URL_SYNC_DELAY_MS = 320;

function cancelUrlSync(): void {
    if (urlTimer) {
        clearTimeout(urlTimer);
        urlTimer = null;
    }
}

/** 快速切图时只更新本地列表/预览，停止后再请求当前图详情，避免请求堆积 */
function scheduleLoad(targetId?: string): void {
    if (loadTimer) {
        clearTimeout(loadTimer);
    }

    loadTimer = setTimeout(() => {
        loadTimer = null;
        void load(targetId);
    }, DETAIL_LOAD_DELAY_MS);
}

/** 连续切图只合并成一次 replace，URL 在停止切换后才更新一次 */
function scheduleUrlSync(): void {
    cancelUrlSync();
    urlTimer = setTimeout(() => {
        urlTimer = null;

        const targetId = viewingId.value;

        if (targetId === assetId.value) {
            if (asset.value?.id === targetId) {
                pendingAsset.value = null;
                imageLoaded.value = true;
            }

            return;
        }

        void router.replace({
            path: `/albums/${albumId.value}/assets/${targetId}`,
            query: nav.value?.scope === 'similar' && groupId.value
                ? { from: 'similar', group: groupId.value }
                : listRouteQuery.value,
        });
    }, URL_SYNC_DELAY_MS);
}

// 标签与相似分组在查看器生命周期内复用，避免每次切图重复请求
let tagsCache: { albumId: string, tags: TagRecord[] } | null = null;
let similarCache: { albumId: string, at: number, groups: SimilarGroupDto[] } | null = null;
const SIMILAR_CACHE_MS = 60_000;

async function ensureTags(): Promise<TagRecord[]> {
    if (tagsCache?.albumId === albumId.value) {
        return tagsCache.tags;
    }

    const response = await api.albums[':albumId'].tags.$get({ param: { albumId: albumId.value } });
    const body = await response.json();
    const tags = body.data as TagRecord[];

    tagsCache = { albumId: albumId.value, tags };

    return tags;
}

async function ensureGroups(): Promise<SimilarGroupDto[]> {
    const now = Date.now();

    if (similarCache?.albumId === albumId.value && now - similarCache.at < SIMILAR_CACHE_MS) {
        return similarCache.groups;
    }

    const response = await api.albums[':albumId'].groups.similar.$get({
        param: { albumId: albumId.value },
        query: { limit: '50' },
    });
    const body = await response.json();
    const groups = body.data as SimilarGroupDto[];

    similarCache = { albumId: albumId.value, at: now, groups };

    return groups;
}

function neighborsFromTrail(index: number): AssetNeighborsDto {
    const previousItems = trail.value.slice(Math.max(0, index - 250), index).reverse();
    const nextItems = trail.value.slice(index + 1, index + 251);

    return {
        previous: previousItems[0] ?? null,
        next: nextItems[0] ?? null,
        previousItems,
        nextItems,
        index,
        total: nav.value?.total ?? trail.value.length,
        scope: nav.value?.scope ?? 'album',
    };
}

async function hydrateInfo(): Promise<void> {
    if (!infoOpen.value) {
        return;
    }

    const id = viewingId.value;

    try {
        const [tags, groups] = await Promise.all([ensureTags(), ensureGroups()]);

        if (!infoOpen.value || viewingId.value !== id) {
            return;
        }

        const hit = groups.find(group => group.assets.some(item => item.id === id));

        allTags.value = tags;
        similar.value = hit ? hit.assets.filter(item => item.id !== id) : [];
    }
    catch (infoError) {
        error.value = errorMessage(infoError);
    }
}

function toggleInfo(): void {
    infoOpen.value = !infoOpen.value;

    if (infoOpen.value) {
        void hydrateInfo();
    }
}

function localPageFor(index: number): PixivLocalPage | null {
    if (!pixiv.value?.pixiv) {
        return null;
    }

    return pixiv.value.localPages.find(page => page.index === index) ?? null;
}

function pixivThumbUrl(assetId: string): string {
    return `/api/v1/albums/${albumId.value}/assets/${assetId}/thumbnail?size=256`;
}

function localThumb(index: number): string | null {
    const page = localPageFor(index);

    return page ? pixivThumbUrl(page.assetId) : null;
}

function pageClick(index: number): void {
    const page = localPageFor(index);

    if (page) {
        openPixivPage(page);
    }
    else {
        void syncPixiv();
    }
}

function pixivStubAsset(page: PixivLocalPage): AssetSummaryDto {
    const illust = pixivIllust.value;
    const name = illust
        ? formatPixivDisplayName(illust.title, page.index, illust.pageCount)
        : page.filename;

    return {
        id: page.assetId,
        filename: page.filename,
        displayName: name,
        ext: page.filename.split('.').pop()?.toLowerCase() ?? '',
        mime: '',
        kind: 'image',
        size: 0,
        width: null,
        height: null,
        durationMs: null,
        takenAt: null,
        addedAt: new Date().toISOString(),
        deletedAt: null,
        favorite: false,
    };
}

function openPixivPage(page: PixivLocalPage): void {
    if (page.assetId === viewingId.value) {
        return;
    }

    stopUgoira();
    go(pixivStubAsset(page));
}

function pixivTagUrl(name: string): string {
    return `https://www.pixiv.net/tags/${encodeURIComponent(name)}/artworks`;
}

async function loadPixiv(targetId: string, options: { force?: boolean } = {}): Promise<void> {
    if (!pixivEnabled.value) {
        pixiv.value = null;
        pixivError.value = '';

        return;
    }

    const token = ++pixivToken;
    pixivLoading.value = true;
    pixivError.value = '';
    pixivNotice.value = '';

    try {
        const param = { albumId: albumId.value, assetId: targetId };
        const response = options.force
            ? await api.albums[':albumId'].assets[':assetId'].pixiv.$get({ param, query: { refresh: '1' } })
            : await api.albums[':albumId'].assets[':assetId'].pixiv.$get({ param, query: {} });
        const body: { data: AssetPixivContextDto } = await response.json();

        if (token !== pixivToken) {
            return;
        }

        pixiv.value = body.data;

        if (asset.value && body.data.pixiv && body.data.illust) {
            asset.value = {
                ...asset.value,
                displayName: formatPixivDisplayName(
                    body.data.illust.title,
                    body.data.pageIndex,
                    body.data.illust.pageCount,
                ),
            };
        }

        if (
            body.data.pixiv
            && body.data.missingPages.length > 0
            && pixivAutoDownload.value
            && !body.data.authRequired
            && !body.data.invalid
        ) {
            void syncPixiv();
        }
    }
    catch (pixivLoadError) {
        if (token === pixivToken) {
            pixiv.value = null;
            pixivError.value = errorMessage(pixivLoadError);
        }
    }
    finally {
        if (token === pixivToken) {
            pixivLoading.value = false;
        }
    }
}

async function syncPixiv(): Promise<void> {
    if (pixivSyncing.value || !pixiv.value?.pixiv) {
        return;
    }

    const targetId = viewingId.value;
    pixivSyncing.value = true;
    pixivError.value = '';
    pixivNotice.value = '';

    try {
        const response = await api.albums[':albumId'].assets[':assetId'].pixiv.sync.$post({
            param: { albumId: albumId.value, assetId: targetId },
            json: { download: true },
        });
        const body: { data: AssetPixivContextDto } = await response.json();

        if (viewingId.value !== targetId) {
            return;
        }

        pixiv.value = body.data;

        if (body.data.pixiv) {
            if (body.data.downloadedPages.length > 0) {
                pixivNotice.value = t('asset.pixivDownloadDone', { count: body.data.downloadedPages.length });
                await reloadAlbumContext(true);
            }
            if (body.data.downloadErrors.length > 0) {
                pixivNotice.value = t('asset.pixivDownloadPartial', { count: body.data.downloadErrors.length });
            }
            if (body.data.authRequired) {
                pixivError.value = t('errors.pixiv_auth_required');
            }
        }
    }
    catch (pixivSyncError) {
        pixivError.value = errorMessage(pixivSyncError);
    }
    finally {
        pixivSyncing.value = false;
    }
}

function refreshPixiv(): void {
    void loadPixiv(viewingId.value, { force: true });
}

function playPixivAnimation(): void {
    const frames = pixivIllust.value?.ugoira?.frames ?? [];

    if (frames.length > 0) {
        void toggleUgoira(ugoiraUrl.value, frames);
    }
}

async function load(targetId?: string): Promise<void> {
    const token = ++loadToken;
    const requestedAlbumId = albumId.value;
    const requestedAssetId = targetId ?? assetId.value;
    const initial = asset.value === null;

    // 切图时保留上一张画面，只做静默更新；只有首次进入才显示 spinner
    loading.value = initial;
    error.value = '';

    const trailPosition = trail.value.findIndex(item => item.id === requestedAssetId);
    // 目标仍在本地窗口中部时直接复用，避免每次切图都拉 500 条邻居元数据
    const reuseIndex = trailPosition >= 8 && trailPosition <= trail.value.length - 9 ? trailPosition : -1;
    const needInfo = infoOpen.value;

    try {
        const detailPromise = api.albums[':albumId'].assets[':assetId'].$get({
            param: { albumId: requestedAlbumId, assetId: requestedAssetId },
        });
        const tagsPromise = needInfo ? ensureTags() : Promise.resolve([] as TagRecord[]);
        const neighborsPromise = reuseIndex >= 0
            ? Promise.resolve(null)
            : api.albums[':albumId'].assets[':assetId'].neighbors.$get({
                param: { albumId: requestedAlbumId, assetId: requestedAssetId },
                query: fromSimilar.value && groupId.value
                    ? { from: 'similar', group: groupId.value, span: '250' }
                    : { ...listApiQuery.value, span: '250' },
            }).then(async (response) => {
                const body = await response.json();

                return body.data;
            });
        const similarPromise = needInfo ? ensureGroups() : Promise.resolve([] as SimilarGroupDto[]);
        // 先给全部 Promise 挂上处理器，详情失败时其余请求也不会变成未处理拒绝
        const enhancements = Promise.allSettled([tagsPromise, neighborsPromise, similarPromise]);

        let detail: AssetDetailDto | null = null;

        const response = await detailPromise;
        const body = await response.json();

        detail = body.data;

        if (!detail) {
            throw new Error(t('errors.invalid_response'));
        }

        // 连续切图时只提交最后点击的目标，中间目标直接丢弃
        if (pendingAsset.value && pendingAsset.value.id !== requestedAssetId) {
            return;
        }
        if (token !== loadToken) {
            return;
        }

        // 详情一到就换图，标签/邻居/相似列表稍后补上
        asset.value = detail;
        viewingId.value = detail.id;
        stopUgoira();
        void loadPixiv(detail.id);

        if (pendingAsset.value?.id === detail.id) {
            pendingAsset.value = null;
        }

        loading.value = false;
        await nextTick();
        syncImageLoaded();
        syncPreviewReady();

        const [tagsResult, neighborsResult, similarResult] = await enhancements;

        if (pendingAsset.value && pendingAsset.value.id !== requestedAssetId) {
            return;
        }
        if (token !== loadToken) {
            return;
        }

        const tags = tagsResult?.status === 'fulfilled' ? tagsResult.value : allTags.value;
        const neighbors = reuseIndex >= 0
            ? neighborsFromTrail(reuseIndex)
            : neighborsResult?.status === 'fulfilled'
                ? neighborsResult.value
                : null;
        const groups = similarResult?.status === 'fulfilled' ? similarResult.value : [];
        const hit = groups.find(group => group.assets.some(item => item.id === requestedAssetId));
        const previousItems = neighbors?.previousItems ?? [];

        nav.value = neighbors;
        allTags.value = needInfo ? tags : [];
        similar.value = needInfo && hit ? hit.assets.filter(item => item.id !== requestedAssetId) : [];

        if (reuseIndex >= 0) {
            trailIndex.value = reuseIndex;
        }
        else {
            trail.value = [...previousItems.slice().reverse(), detail, ...(neighbors?.nextItems ?? [])];
            trailIndex.value = previousItems.length;
        }
    }
    catch (loadError) {
        if (token !== loadToken) {
            return;
        }

        error.value = errorMessage(loadError);

        if (pendingAsset.value?.id === requestedAssetId) {
            pendingAsset.value = null;
        }
        if (asset.value?.id !== requestedAssetId) {
            asset.value = null;
            nav.value = null;
            trail.value = [];
            trailIndex.value = -1;
        }
    }
    finally {
        if (token === loadToken) {
            loading.value = false;
        }
    }
}

function navigate(target: AssetSummaryDto): void {
    // 立即切到目标；详情与 URL 都在停止切换后合并提交
    stopUgoira();
    pendingAsset.value = target;
    viewingId.value = target.id;
    imageFailed.value = false;
    imageLoaded.value = false;
    livePlaying.value = false;
    error.value = '';
    notice.value = '';
    resetTransform();
    scheduleLoad(target.id);
    scheduleUrlSync();
}

function go(target: AssetSummaryDto | null | undefined): void {
    if (!target) {
        return;
    }

    const index = trail.value.findIndex(item => item.id === target.id);

    if (index >= 0) {
        trailIndex.value = index;
    }
    else {
        trail.value = [];
        trailIndex.value = -1;
    }

    navigate(target);
}

function step(delta: -1 | 1): void {
    const index = trailIndex.value + delta;
    const target = trail.value[index];

    if (!target) {
        return;
    }

    trailIndex.value = index;
    navigate(target);
}

function zoomIn(): void {
    scale.value = stepZoom(scale.value, 1);
}

function zoomOut(): void {
    scale.value = stepZoom(scale.value, -1);

    if (scale.value <= 1) {
        translateX.value = 0;
        translateY.value = 0;
    }
}

function onWheel(event: WheelEvent): void {
    if (event.deltaY < 0) {
        zoomIn();
    }
    else {
        zoomOut();
    }
}

function releasePointer(event: PointerEvent): void {
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        catch {
            // 合成事件/已释放的指针忽略
        }
    }
}

function capturePointer(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) {
        return;
    }

    try {
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    catch {
        // 合成事件没有真实指针时忽略
    }
}

function onPointerDown(event: PointerEvent): void {
    if (scale.value <= 1) {
        return;
    }

    dragging.value = true;
    dragStart = {
        x: event.clientX,
        y: event.clientY,
        tx: translateX.value,
        ty: translateY.value,
    };
    capturePointer(event);
}

function onPointerMove(event: PointerEvent): void {
    if (!dragging.value) {
        return;
    }

    translateX.value = dragStart.tx + (event.clientX - dragStart.x);
    translateY.value = dragStart.ty + (event.clientY - dragStart.y);
}

function onPointerUp(event: PointerEvent): void {
    dragging.value = false;
    releasePointer(event);
}

function onPointerCancel(event: PointerEvent): void {
    dragging.value = false;
    releasePointer(event);
}

function onTouchStart(event: TouchEvent): void {
    if (scale.value > 1 || event.touches.length !== 1) {
        return;
    }
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select')) {
        return;
    }

    const touch = event.touches[0];

    if (!touch) {
        return;
    }

    swiping.value = true;
    swipeOffsetX.value = 0;
    swipeStart = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now(),
    };
}

function onTouchMove(event: TouchEvent): void {
    if (!swiping.value || !swipeStart) {
        return;
    }

    const touch = event.touches[0];

    if (!touch) {
        return;
    }

    const dx = touch.clientX - swipeStart.x;
    const dy = touch.clientY - swipeStart.y;

    if (Math.abs(dx) > Math.abs(dy)) {
        swipeOffsetX.value = Math.max(-90, Math.min(90, dx * 0.45));
    }
}

function onTouchEnd(event: TouchEvent): void {
    if (!swiping.value || !swipeStart) {
        return;
    }

    const touch = event.changedTouches[0] ?? event.touches[0];
    const start = swipeStart;
    const dx = (touch?.clientX ?? start.x) - start.x;
    const dy = (touch?.clientY ?? start.y) - start.y;

    swiping.value = false;
    swipeStart = null;
    swipeOffsetX.value = 0;

    if (Math.abs(dx) >= SWIPE_THRESHOLD
      && Math.abs(dx) > Math.abs(dy) * 1.4
      && Date.now() - start.at < 600) {
        step(dx < 0 ? 1 : -1);
    }
}

function onTouchCancel(): void {
    swiping.value = false;
    swipeStart = null;
    swipeOffsetX.value = 0;
}

async function addTag(tagId: string | undefined): Promise<void> {
    if (!tagId) {
        return;
    }

    const targetId = viewingId.value;

    try {
        await api.albums[':albumId'].assets[':assetId'].tags.$post({
            param: { albumId: albumId.value, assetId: targetId },
            json: { tagId },
        });
        pendingTag.value = undefined;

        if (viewingId.value === targetId) {
            await load(targetId);
        }

        void reloadAlbumContext(true);
    }
    catch (tagError) {
        error.value = errorMessage(tagError);
    }
}

async function removeTag(tagId: string): Promise<void> {
    const targetId = viewingId.value;

    try {
        await api.albums[':albumId'].assets[':assetId'].tags[':tagId'].$delete({
            param: { albumId: albumId.value, assetId: targetId, tagId },
        });

        if (viewingId.value === targetId) {
            await load(targetId);
        }

        void reloadAlbumContext(true);
    }
    catch (tagError) {
        error.value = errorMessage(tagError);
    }
}

async function confirmDelete(): Promise<void> {
    deleting.value = true;

    try {
        await api.albums[':albumId'].assets[':assetId'].$delete({
            param: { albumId: albumId.value, assetId: viewingId.value },
        });
        deleteOpen.value = false;
        removeAssetFromList(albumId.value, viewingId.value);
        void reloadAlbumContext(true);
        await returnToAlbum();
    }
    catch (deleteError) {
        error.value = errorMessage(deleteError);
    }
    finally {
        deleting.value = false;
    }
}

async function toggleFavorite(): Promise<void> {
    const target = asset.value;

    if (!target) {
        return;
    }

    const targetId = target.id;

    favoriteSaving.value = true;
    error.value = '';

    try {
        const response = await api.albums[':albumId'].assets[':assetId'].$patch({
            param: { albumId: albumId.value, assetId: targetId },
            json: { favorite: !target.favorite },
        });
        const body = await response.json();

        if (asset.value?.id === targetId) {
            asset.value = { ...asset.value, favorite: body.data.favorite };
        }
        patchAssetInList(albumId.value, body.data);
    }
    catch (favoriteError) {
        error.value = errorMessage(favoriteError);
    }
    finally {
        favoriteSaving.value = false;
    }
}

async function setCover(): Promise<void> {
    if (!asset.value) {
        return;
    }

    coverSaving.value = true;
    error.value = '';

    try {
        await api.albums[':albumId'].$patch({
            param: { albumId: albumId.value },
            json: { coverAssetId: viewingId.value },
        });
        notice.value = t('asset.coverSaved');
        await reloadAlbumContext(true);
    }
    catch (coverError) {
        error.value = errorMessage(coverError);
    }
    finally {
        coverSaving.value = false;
    }
}

let renameTargetId = '';

function openRename(): void {
    renameTargetId = viewingId.value;
    renameValue.value = asset.value?.filename ?? '';
    renameOpen.value = true;
}

async function confirmRename(): Promise<void> {
    const filename = renameValue.value.trim();
    const targetId = renameTargetId || viewingId.value;

    if (filename === '' || filename === asset.value?.filename) {
        renameOpen.value = false;

        return;
    }

    renaming.value = true;

    try {
        const response = await api.albums[':albumId'].assets[':assetId'].$patch({
            param: { albumId: albumId.value, assetId: targetId },
            json: { filename },
        });
        const body = await response.json();

        renameOpen.value = false;
        patchAssetInList(albumId.value, body.data);

        if (viewingId.value === targetId) {
            await load(targetId);
        }
    }
    catch (renameError) {
        error.value = errorMessage(renameError);
    }
    finally {
        renaming.value = false;
    }
}

function albumReturnQuery(): Record<string, string> {
    const query: Record<string, string> = {};

    if (listRouteQuery.value.tag) {
        query.tag = listRouteQuery.value.tag;
    }
    if (listRouteQuery.value.pixivTag) {
        query.pixivTag = listRouteQuery.value.pixivTag;
    }

    return query;
}

function returnToAlbum(): Promise<unknown> {
    return router.push({
        path: `/albums/${albumId.value}`,
        ...(Object.keys(albumReturnQuery()).length > 0 ? { query: albumReturnQuery() } : {}),
    });
}

function close(): void {
    void returnToAlbum();
}

function onKeydown(event: KeyboardEvent): void {
    const shortcut = resolveViewerShortcut(event, {
        shortcutsOpen: shortcutsOpen.value,
        deleteOpen: deleteOpen.value,
        renameOpen: renameOpen.value,
        infoOpen: infoOpen.value,
        canPlayUgoira: canPlayUgoira.value,
        hasLive: hasLive.value,
        favoriteSaving: favoriteSaving.value,
    });

    if (!shortcut) {
        return;
    }
    if (shortcut.preventDefault) {
        event.preventDefault();
    }

    switch (shortcut.action) {
        case 'close-shortcuts':
            shortcutsOpen.value = false;
            break;
        case 'close-delete':
            deleteOpen.value = false;
            break;
        case 'close-rename':
            renameOpen.value = false;
            break;
        case 'close-info':
            infoOpen.value = false;
            break;
        case 'close-viewer':
            close();
            break;
        case 'open-shortcuts':
            shortcutsOpen.value = true;
            break;
        case 'prev':
            step(-1);
            break;
        case 'next':
            step(1);
            break;
        case 'zoom-in':
            zoomIn();
            break;
        case 'zoom-out':
            zoomOut();
            break;
        case 'reset':
            resetTransform();
            break;
        case 'toggle-info':
            toggleInfo();
            break;
        case 'toggle-favorite':
            void toggleFavorite();
            break;
        case 'play-ugoira':
            playPixivAnimation();
            break;
        case 'toggle-live':
            livePlaying.value = !livePlaying.value;
            break;
    }
}

watch(assetId, (id) => {
    const pending = pendingAsset.value;

    // 本地切图提交 URL 时，详情请求已在队列里
    if (pending?.id === id) {
        viewingId.value = id;

        return;
    }
    if (pending) {
        pendingAsset.value = null;
        cancelUrlSync();
    }

    viewingId.value = id;

    // URL 同步到已经加载完成的资产，不需要再次请求
    if (asset.value?.id === id) {
        return;
    }

    error.value = '';
    notice.value = '';
    imageFailed.value = false;
    imageLoaded.value = false;
    livePlaying.value = false;
    resetTransform();
    scheduleLoad(id);
});

// 预载前后各最多 15 张缩略图；原图只串行预载紧邻各 3 张，避免 HDD 被并发读取占满
const preloadedPreviews = new Map<string, HTMLImageElement>();
const preloadedOriginals = new Map<string, HTMLImageElement>();
const originalQueue: { id: string, url: string }[] = [];
let activeOriginal: { id: string, url: string, image: HTMLImageElement } | null = null;
let originalPreloadTimer: ReturnType<typeof setTimeout> | null = null;

/** 取消不再需要的预载：移除 src 让浏览器终止尚未完成的请求 */
function prunePreloaded(map: Map<string, HTMLImageElement>, keep: Set<string>): void {
    for (const [id, image] of map) {
        if (keep.has(id)) {
            continue;
        }

        image.removeAttribute('src');
        map.delete(id);
    }
}

function cancelActiveOriginal(): { id: string, url: string } | null {
    if (!activeOriginal) {
        return null;
    }

    const active = activeOriginal;

    active.image.removeAttribute('src');
    activeOriginal = null;

    return { id: active.id, url: active.url };
}

function pumpOriginalPreloads(): void {
    if (activeOriginal) {
        return;
    }

    while (originalQueue.length > 0) {
        const next = originalQueue.shift();

        if (!next || preloadedOriginals.has(next.id)) {
            continue;
        }

        const image = new Image();
        const active = { id: next.id, url: next.url, image };

        image.decoding = 'async';
        activeOriginal = active;
        image.onload = () => {
            if (activeOriginal !== active) {
                return;
            }

            activeOriginal = null;
            preloadedOriginals.set(next.id, image);
            pumpOriginalPreloads();
        };
        image.onerror = () => {
            if (activeOriginal !== active) {
                return;
            }

            activeOriginal = null;
            image.removeAttribute('src');
            pumpOriginalPreloads();
        };
        image.src = next.url;

        return;
    }
}

function pruneOriginalPreloads(keep: Set<string>): void {
    const active = cancelActiveOriginal();

    originalQueue.length = 0;
    prunePreloaded(preloadedOriginals, keep);

    if (active && keep.has(active.id) && !preloadedOriginals.has(active.id)) {
        originalQueue.push(active);
    }
}

function enqueueOriginalPreloads(items: AssetSummaryDto[]): void {
    const keep = new Set(items.map(item => item.id));

    originalQueue.length = 0;

    if (activeOriginal && !keep.has(activeOriginal.id)) {
        const active = cancelActiveOriginal();

        if (active && keep.has(active.id)) {
            originalQueue.push(active);
        }
    }

    for (const item of items) {
        if (
            item.kind === 'video'
            || preloadedOriginals.has(item.id)
            || activeOriginal?.id === item.id
            || originalQueue.some(queued => queued.id === item.id)
        ) {
            continue;
        }

        const preview = PREVIEW_EXTENSIONS.has(item.ext.toLowerCase()) ? '/preview' : '/file';

        originalQueue.push({
            id: item.id,
            url: `/api/v1/albums/${albumId.value}/assets/${item.id}${preview}`,
        });
    }

    pumpOriginalPreloads();
}

function releasePreloaded(): void {
    originalQueue.length = 0;
    cancelActiveOriginal();
    prunePreloaded(preloadedPreviews, new Set());
    prunePreloaded(preloadedOriginals, new Set());
}

watch(nav, (value) => {
    if (!value) {
        return;
    }

    // 元数据窗口用于连续切换，缩略图预载前后各 15 张
    const neighbours = [
        ...(value.previousItems ?? []).slice(0, 15),
        ...(value.nextItems ?? []).slice(0, 15),
    ];
    const previewWanted = new Set(neighbours.map(item => item.id));
    const originalWanted = new Set([
        ...(value.previousItems ?? []).slice(0, 3),
        ...(value.nextItems ?? []).slice(0, 3),
    ].map(item => item.id));

    // 新窗口之外的旧预载立即取消，快速切图/换相册时不再继续下载上一页缩略图
    prunePreloaded(preloadedPreviews, previewWanted);
    pruneOriginalPreloads(originalWanted);

    for (const neighbour of neighbours) {
        if (!neighbour || preloadedPreviews.has(neighbour.id)) {
            continue;
        }

        const image = new Image();

        image.decoding = 'async';
        // 预载只读已有缓存，缺图时不触发原图解码（避免一次导航拉起 30 张 HDD 随机读取）
        image.src = `/api/v1/albums/${albumId.value}/assets/${neighbour.id}/thumbnail?size=512&generate=0`;
        preloadedPreviews.set(neighbour.id, image);
    }

    while (preloadedPreviews.size > 40) {
        const oldest = preloadedPreviews.keys().next().value;

        if (!oldest) {
            break;
        }

        preloadedPreviews.get(oldest)?.removeAttribute('src');
        preloadedPreviews.delete(oldest);
    }
}, { immediate: true });

watch(imageLoaded, (loaded) => {
    if (originalPreloadTimer) {
        clearTimeout(originalPreloadTimer);
        originalPreloadTimer = null;
    }

    if (!loaded || !nav.value) {
        return;
    }

    // 原图较大：等当前图稳定后再按“下一张、上一张、再下一张…”串行预载
    originalPreloadTimer = setTimeout(() => {
        originalPreloadTimer = null;

        if (!nav.value || !imageLoaded.value) {
            return;
        }

        const previous = (nav.value.previousItems ?? []).slice(0, 3);
        const next = (nav.value.nextItems ?? []).slice(0, 3);
        const ordered: typeof previous = [];

        for (let index = 0; index < Math.max(previous.length, next.length); index += 1) {
            const ahead = next[index];
            const behind = previous[index];

            if (ahead) {
                ordered.push(ahead);
            }
            if (behind) {
                ordered.push(behind);
            }
        }

        enqueueOriginalPreloads(ordered);
    }, 400);
});

useHead({
    title: () => `${asset.value?.displayName ?? t('asset.viewer')} · PictureX`,
});

watch(pixivEnabled, (enabled) => {
    if (enabled) {
        void loadPixiv(viewingId.value);
    }
    else {
        pixiv.value = null;
        pixivError.value = '';
        stopUgoira();
    }
});

onMounted(() => {
    window.addEventListener('keydown', onKeydown);
    // 指针在舞台外释放时也要结束手势，避免滑动/拖拽状态卡住
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    wideInfoQuery = window.matchMedia('(min-width: 1280px)');
    infoOpen.value = wideInfoQuery.matches;
    wideInfoQuery.addEventListener('change', onWideInfoChange);

    void load();
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    wideInfoQuery?.removeEventListener('change', onWideInfoChange);
    wideInfoQuery = null;

    if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
    }
    if (originalPreloadTimer) {
        clearTimeout(originalPreloadTimer);
        originalPreloadTimer = null;
    }
    releasePreloaded();
    cancelUrlSync();
    if (busyTimer) {
        clearTimeout(busyTimer);
        busyTimer = null;
    }
});
</script>

<template>
    <div class="viewer" :aria-label="t('a11y.viewer')">
        <header class="viewer__bar">
            <button type="button" class="viewer__icon-button" :aria-label="t('a11y.closeViewer')" @click="close">
                <ArrowLeftOutlined />
            </button>
            <div class="viewer__title">
                <span class="viewer__name">{{ displayName }}</span>
            </div>
            <div class="viewer__tools">
                <button type="button" class="viewer__icon-button" :aria-label="t('asset.zoomOut')" @click="zoomOut">
                    <ZoomOutOutlined />
                </button>
                <span class="viewer__zoom">{{ Math.round(scale * 100) }}%</span>
                <button type="button" class="viewer__icon-button" :aria-label="t('asset.zoomIn')" @click="zoomIn">
                    <ZoomInOutlined />
                </button>
                <button type="button" class="viewer__icon-button" :aria-label="t('a11y.zoomReset')" @click="resetTransform">
                    <FullscreenOutlined />
                </button>
                <button
                    v-if="hasLive"
                    type="button"
                    class="viewer__icon-button"
                    :class="{ 'viewer__icon-button--active': livePlaying }"
                    :aria-label="t('asset.playLive')"
                    @click="livePlaying = !livePlaying"
                >
                    <PlayCircleOutlined />
                </button>
                <button
                    v-if="canPlayUgoira"
                    type="button"
                    class="viewer__icon-button"
                    :class="{ 'viewer__icon-button--active': ugoiraPlaying }"
                    :aria-label="ugoiraPlaying ? t('asset.pixivPauseAnimation') : t('asset.pixivPlayAnimation')"
                    @click="playPixivAnimation"
                >
                    <PlayCircleOutlined />
                </button>
                <button
                    type="button"
                    class="viewer__icon-button"
                    :class="{ 'viewer__icon-button--active': asset?.favorite }"
                    :aria-label="asset?.favorite ? t('asset.unfavorite') : t('asset.favorite')"
                    :disabled="favoriteSaving"
                    @click="toggleFavorite"
                >
                    <StarFilled v-if="asset?.favorite" />
                    <StarOutlined v-else />
                </button>
                <button
                    type="button"
                    class="viewer__icon-button"
                    :aria-label="t('asset.setCover')"
                    :disabled="coverSaving"
                    @click="setCover"
                >
                    <PictureOutlined />
                </button>
                <button type="button" class="viewer__icon-button" :aria-label="t('asset.shortcuts')" @click="shortcutsOpen = true">
                    <QuestionCircleOutlined />
                </button>
                <button type="button" class="viewer__icon-button viewer__info-toggle" :aria-label="t('asset.infoButton')" @click="toggleInfo">
                    <InfoCircleOutlined />
                </button>
                <a :href="fileUrl" :download="downloadName" class="viewer__icon-button" :aria-label="t('asset.downloadOriginal')">
                    <DownloadOutlined />
                </a>
                <button type="button" class="viewer__icon-button viewer__icon-button--danger" :aria-label="t('asset.delete')" @click="deleteOpen = true">
                    <DeleteOutlined />
                </button>
            </div>
        </header>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <div class="viewer__body" :class="{ 'viewer__body--info': infoOpen }">
            <div
                class="viewer__stage"
                :class="{ 'viewer__stage--dragging': dragging || swiping }"
                @wheel.prevent="onWheel"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerCancel"
                @touchstart="onTouchStart"
                @touchmove="onTouchMove"
                @touchend="onTouchEnd"
                @touchcancel="onTouchCancel"
                @dblclick="resetTransform"
            >
                <img
                    v-if="!livePlaying && !isVideo && !imageFailed && !ugoiraPlaying"
                    ref="previewElement"
                    :src="previewUrl"
                    alt=""
                    class="viewer__preview"
                    :class="{ 'viewer__preview--visible': previewReady && !imageLoaded }"
                    draggable="false"
                    @load="onPreviewLoad"
                    @error="previewReady = false"
                >
                <div
                    class="viewer__canvas"
                    :style="{ transform: `translate3d(${translateX + swipeOffsetX}px, ${translateY}px, 0) scale(${scale})` }"
                >
                    <video
                        v-if="livePlaying"
                        :src="liveUrl"
                        class="viewer__media"
                        controls
                        autoplay
                        playsinline
                        @ended="livePlaying = false"
                    />
                    <video
                        v-else-if="isVideo"
                        :src="streamUrl"
                        class="viewer__media"
                        controls
                        playsinline
                    />
                    <canvas
                        v-else-if="ugoiraPlaying"
                        ref="ugoiraCanvas"
                        class="viewer__media viewer__ugoira"
                        :aria-label="t('asset.pixivUgoira')"
                    />
                    <template v-else-if="!imageFailed">
                        <img
                            ref="imageElement"
                            :src="displayUrl"
                            :alt="asset?.filename ?? ''"
                            class="viewer__media"
                            :class="{ 'viewer__media--hidden': !imageLoaded }"
                            fetchpriority="high"
                            draggable="false"
                            decoding="async"
                            @load="imageLoaded = true"
                            @error="imageFailed = true"
                        >
                    </template>
                    <div v-else class="viewer__unsupported">
                        <p>{{ t('asset.previewUnsupported') }}</p>
                        <a :href="fileUrl" :download="downloadName">{{ t('asset.downloadOriginal') }}</a>
                        <a v-if="hasPreview" :href="previewFileUrl" :download="previewDownloadName">{{ t('asset.downloadPreview') }}</a>
                    </div>
                </div>

                <button
                    v-if="previousAsset"
                    type="button"
                    class="viewer__nav viewer__nav--prev"
                    :aria-label="t('a11y.previousImage')"
                    @click.stop="step(-1)"
                >
                    <ArrowLeftOutlined />
                </button>
                <button
                    v-if="nextAsset"
                    type="button"
                    class="viewer__nav viewer__nav--next"
                    :aria-label="t('a11y.nextImage')"
                    @click.stop="step(1)"
                >
                    <ArrowRightOutlined />
                </button>

                <div v-if="loading || showBusy || ugoiraLoading" class="viewer__loading">
                    <a-spin />
                </div>

                <p class="viewer__hint">
                    {{ ugoiraFailed ? t('asset.pixivAnimationError') : t('asset.viewerHint') }}
                </p>
            </div>

            <div v-if="infoOpen" class="viewer__scrim" @click="infoOpen = false" />

            <aside
                v-if="infoOpen"
                class="viewer__info"
                :class="{ 'viewer__info--open': infoOpen }"
                :aria-label="t('a11y.infoPanel')"
            >
                <button type="button" class="viewer__panel-close" :aria-label="t('asset.closeInfo')" @click="infoOpen = false">
                    <CloseOutlined />
                </button>
                <p class="viewer__panel-title">
                    {{ t('asset.infoButton') }}
                </p>
                <section class="viewer__section">
                    <h2 class="viewer__section-title">
                        {{ t('asset.tags') }}
                    </h2>
                    <div class="viewer__tags">
                        <a-tag
                            v-for="tag in asset?.tags ?? []"
                            :key="tag.id"
                            :color="tag.color || undefined"
                            closable
                            @close="removeTag(tag.id)"
                        >
                            {{ tag.name }}
                        </a-tag>
                        <span v-if="(asset?.tags ?? []).length === 0" class="viewer__empty">
                            {{ t('asset.noTags') }}
                        </span>
                    </div>
                    <a-select
                        v-model:value="pendingTag"
                        :options="availableTags"
                        :placeholder="t('asset.addTagPlaceholder')"
                        class="viewer__tag-select"
                        @change="addTag"
                    />
                </section>

                <section v-if="pixivEnabled" class="viewer__section viewer__pixiv">
                    <div class="viewer__section-head">
                        <h2 class="viewer__section-title">
                            {{ t('asset.pixivTitle') }}
                        </h2>
                        <button
                            type="button"
                            class="viewer__icon-button"
                            :aria-label="t('asset.pixivRefresh')"
                            @click="refreshPixiv"
                        >
                            <ReloadOutlined />
                        </button>
                    </div>

                    <p v-if="pixivLoading" class="viewer__empty">
                        {{ t('asset.pixivLoading') }}
                    </p>
                    <a-alert v-else-if="pixivError" type="error" show-icon :message="pixivError" />

                    <template v-else-if="pixiv && pixiv.pixiv">
                        <a-alert v-if="pixivInvalid" type="warning" show-icon :message="t('asset.pixivInvalid')" />
                        <a-alert v-if="pixiv.stale" type="warning" show-icon :message="t('asset.pixivStale')" />
                        <a-alert v-if="pixivNotice" type="success" show-icon :message="pixivNotice" />

                        <template v-if="pixivAuthRequired">
                            <a-alert type="warning" show-icon :message="t('asset.pixivAuthHint')" />
                            <div class="viewer__pixiv-actions">
                                <a-button size="small" @click="router.push('/settings/pixiv')">
                                    {{ t('asset.pixivLogin') }}
                                </a-button>
                                <a
                                    :href="`https://www.pixiv.net/artworks/${pixiv.illustId}`"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {{ t('asset.pixivOpenPage') }}
                                </a>
                            </div>
                        </template>

                        <template v-if="pixivIllust">
                            <div class="viewer__pixiv-head">
                                <a
                                    :href="`https://www.pixiv.net/artworks/${pixiv.illustId}`"
                                    target="_blank"
                                    rel="noreferrer"
                                    class="viewer__pixiv-title"
                                >
                                    {{ pixivIllust.title }}
                                </a>
                                <div class="viewer__pixiv-badges">
                                    <a-tag v-if="pixivIllust.xRestrict > 0" color="red">
                                        {{ t('asset.pixivRestricted') }}
                                    </a-tag>
                                    <a-tag v-if="pixivIllust.type === 'ugoira'">
                                        {{ t('asset.pixivUgoira') }}
                                    </a-tag>
                                    <a-tag v-if="isPixivAiGenerated(pixivIllust.illustAiType)">
                                        {{ t('asset.pixivAiGenerated') }}
                                    </a-tag>
                                </div>
                            </div>

                            <p class="viewer__pixiv-author">
                                <a
                                    v-if="pixivIllust.userId"
                                    :href="`https://www.pixiv.net/users/${pixivIllust.userId}`"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {{ pixivIllust.userName }}
                                </a>
                                <span v-else>{{ pixivIllust.userName }}</span>
                                <a
                                    :href="`https://www.pixiv.net/artworks/${pixiv.illustId}`"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {{ t('asset.pixivOpenPage') }}
                                </a>
                            </p>

                            <p class="viewer__pixiv-stats">
                                {{ t('asset.pixivStats', {
                                    views: formatNumber(pixivIllust.totalView),
                                    bookmarks: formatNumber(pixivIllust.totalBookmarks),
                                }) }}
                            </p>

                            <dl class="viewer__meta">
                                <div class="viewer__meta-row">
                                    <dt>{{ t('asset.pixivCreated') }}</dt>
                                    <dd>{{ formatDateTime(pixivIllust.createDate) }}</dd>
                                </div>
                                <div class="viewer__meta-row">
                                    <dt>{{ t('asset.pixivSize') }}</dt>
                                    <dd>
                                        {{ pixivIllust.width ?? '—' }} × {{ pixivIllust.height ?? '—' }}
                                    </dd>
                                </div>
                            </dl>

                            <template v-if="pixivIllust.tags.length > 0">
                                <div class="viewer__pixiv-pages-head">
                                    <h3 class="viewer__pixiv-subtitle">
                                        {{ t('asset.pixivTagsTitle') }}
                                    </h3>
                                </div>
                                <div class="viewer__tags">
                                    <a
                                        v-for="tag in pixivIllust.tags"
                                        :key="tag.name"
                                        :href="pixivTagUrl(tag.name)"
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        <a-tag>{{ pickPixivTagName(tag) }}</a-tag>
                                    </a>
                                </div>
                            </template>

                            <div class="viewer__pixiv-pages-head">
                                <h3 class="viewer__pixiv-subtitle">
                                    {{ t('asset.pixivPages') }}
                                </h3>
                                <span class="px-hint">{{ t('asset.pixivPagesHint') }}</span>
                            </div>
                            <div class="viewer__pixiv-pages">
                                <button
                                    v-for="page in pixivIllust.pages"
                                    :key="page.index"
                                    type="button"
                                    class="viewer__pixiv-page"
                                    :class="{
                                        'viewer__pixiv-page--active': page.index === pixivPageIndex,
                                        'viewer__pixiv-page--missing': localThumb(page.index) === null,
                                    }"
                                    @click="pageClick(page.index)"
                                >
                                    <img
                                        v-if="localThumb(page.index)"
                                        :src="localThumb(page.index) ?? ''"
                                        alt=""
                                        loading="lazy"
                                    >
                                    <span v-else class="viewer__pixiv-missing">
                                        {{ t('asset.pixivMissing') }}
                                    </span>
                                    <span class="viewer__pixiv-page-index">{{ page.index + 1 }}</span>
                                </button>
                            </div>

                            <div v-if="pixivMissing.length > 0" class="viewer__pixiv-actions">
                                <a-button
                                    size="small"
                                    :loading="pixivSyncing"
                                    :disabled="pixivAuthRequired"
                                    @click="syncPixiv"
                                >
                                    {{ t('asset.pixivDownloadMissing') }}
                                </a-button>
                                <span v-if="pixivSyncing" class="px-hint">
                                    {{ t('asset.pixivDownloading') }}
                                </span>
                            </div>

                            <template v-if="pixivIllust.caption">
                                <h3 class="viewer__pixiv-subtitle">
                                    {{ t('asset.pixivCaption') }}
                                </h3>
                                <p class="viewer__pixiv-caption px-selectable">
                                    {{ pixivIllust.caption }}
                                </p>
                            </template>
                        </template>

                        <template v-else-if="pixiv.localPages.length > 0">
                            <div class="viewer__pixiv-pages">
                                <button
                                    v-for="page in pixiv.localPages"
                                    :key="page.index"
                                    type="button"
                                    class="viewer__pixiv-page"
                                    :class="{ 'viewer__pixiv-page--active': page.index === pixivPageIndex }"
                                    @click="openPixivPage(page)"
                                >
                                    <img :src="pixivThumbUrl(page.assetId)" alt="" loading="lazy">
                                    <span class="viewer__pixiv-page-index">{{ page.index + 1 }}</span>
                                </button>
                            </div>
                        </template>

                        <p v-else class="viewer__empty">
                            {{ t('asset.pixivNoIllust') }}
                        </p>
                    </template>

                    <p v-else-if="pixiv && !pixiv.pixiv" class="viewer__empty">
                        {{ t('asset.pixivNoIllust') }}
                    </p>
                </section>

                <section class="viewer__section">
                    <h2 class="viewer__section-title">
                        {{ t('asset.metaTitle') }}
                    </h2>
                    <dl class="viewer__meta">
                        <div class="viewer__meta-row">
                            <dt>{{ t('asset.filename') }}</dt>
                            <dd class="px-selectable viewer__filename">
                                <span>{{ asset?.filename ?? '—' }}</span>
                                <button
                                    type="button"
                                    class="viewer__rename"
                                    :aria-label="t('asset.renameTitle')"
                                    @click="openRename"
                                >
                                    <EditOutlined />
                                </button>
                            </dd>
                        </div>
                        <div class="viewer__meta-row">
                            <dt>{{ t('asset.fileSize') }}</dt>
                            <dd>{{ asset ? formatBytes(asset.size) : '—' }}</dd>
                        </div>
                        <div class="viewer__meta-row">
                            <dt>{{ t('asset.mime') }}</dt>
                            <dd>{{ asset?.mime ?? '—' }}</dd>
                        </div>
                        <div v-if="asset?.durationMs" class="viewer__meta-row">
                            <dt>{{ t('asset.duration') }}</dt>
                            <dd>{{ formatDuration(asset.durationMs) }}</dd>
                        </div>
                        <div class="viewer__meta-row">
                            <dt>{{ t('asset.takenAt') }}</dt>
                            <dd>{{ formatDateTime(asset?.takenAt) }}</dd>
                        </div>
                        <div class="viewer__meta-row">
                            <dt>{{ t('asset.addedAt') }}</dt>
                            <dd>{{ formatDateTime(asset?.addedAt) }}</dd>
                        </div>
                    </dl>
                    <details class="viewer__details">
                        <summary class="viewer__section-title viewer__details-summary">
                            {{ t('asset.technicalInfo') }}
                        </summary>
                        <dl class="viewer__meta">
                            <div class="viewer__meta-row">
                                <dt>{{ t('asset.sha256') }}</dt>
                                <dd class="viewer__mono px-selectable">
                                    {{ asset?.sha256 ?? '—' }}
                                </dd>
                            </div>
                            <div class="viewer__meta-row">
                                <dt>{{ t('asset.phash') }}</dt>
                                <dd class="viewer__mono px-selectable">
                                    {{ asset?.phash ?? '—' }}
                                </dd>
                            </div>
                            <div class="viewer__meta-row">
                                <dt>{{ t('asset.storagePath') }}</dt>
                                <dd class="viewer__mono px-selectable">
                                    {{ asset?.storageKey ?? '—' }}
                                </dd>
                            </div>
                        </dl>
                    </details>
                </section>

                <section class="viewer__section">
                    <details v-if="metaEntries.length > 0" class="viewer__details">
                        <summary class="viewer__section-title viewer__details-summary">
                            {{ t('asset.exif') }} · {{ metaEntries.length }}
                        </summary>
                        <dl class="viewer__meta">
                            <div v-for="entry in metaEntries" :key="entry.key" class="viewer__meta-row">
                                <dt>{{ entry.key }}</dt>
                                <dd class="px-selectable">
                                    {{ entry.value }}
                                </dd>
                            </div>
                        </dl>
                    </details>
                    <p v-else class="viewer__empty">
                        {{ t('asset.noExif') }}
                    </p>
                </section>

                <section class="viewer__section">
                    <h2 class="viewer__section-title">
                        {{ t('asset.similar') }}
                    </h2>
                    <p class="viewer__hint-text">
                        {{ t('asset.similarHint') }}
                    </p>
                    <div v-if="similar.length > 0" class="viewer__similar">
                        <button
                            v-for="item in similar"
                            :key="item.id"
                            type="button"
                            class="viewer__similar-item"
                            @click="go(item)"
                        >
                            <img
                                :src="`/api/v1/albums/${albumId}/assets/${item.id}/thumbnail?size=256`"
                                :alt="item.filename"
                                loading="lazy"
                            >
                            <span>{{ t('asset.distanceValue', { distance: item.distance }) }}</span>
                        </button>
                    </div>
                    <p v-else class="viewer__empty">
                        {{ t('asset.noSimilar') }}
                    </p>
                </section>
            </aside>
        </div>

        <a-modal
            v-model:open="renameOpen"
            :title="t('asset.renameTitle')"
            :ok-text="t('common.save')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="renaming"
            @ok="confirmRename"
        >
            <a-input v-model:value="renameValue" :maxlength="200" allow-clear />
        </a-modal>

        <a-modal
            v-model:open="shortcutsOpen"
            :title="t('asset.shortcuts')"
            :footer="null"
        >
            <dl class="viewer__shortcuts">
                <div class="viewer__shortcut">
                    <dt><kbd>W</kbd><kbd>↑</kbd></dt>
                    <dd>{{ t('asset.shortcutZoomIn') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>S</kbd><kbd>↓</kbd></dt>
                    <dd>{{ t('asset.shortcutZoomOut') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>A</kbd><kbd>←</kbd></dt>
                    <dd>{{ t('asset.shortcutPrev') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>D</kbd><kbd>→</kbd></dt>
                    <dd>{{ t('asset.shortcutNext') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>0</kbd><kbd>R</kbd></dt>
                    <dd>{{ t('asset.shortcutReset') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>I</kbd></dt>
                    <dd>{{ t('asset.shortcutInfo') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>F</kbd></dt>
                    <dd>{{ t('asset.shortcutFavorite') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>Space</kbd></dt>
                    <dd>{{ t('asset.shortcutPlay') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>?</kbd></dt>
                    <dd>{{ t('asset.shortcutHelp') }}</dd>
                </div>
                <div class="viewer__shortcut">
                    <dt><kbd>Esc</kbd></dt>
                    <dd>{{ t('asset.shortcutClose') }}</dd>
                </div>
            </dl>
        </a-modal>

        <a-modal
            v-model:open="deleteOpen"
            :title="t('asset.delete')"
            :ok-text="t('common.delete')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="deleting"
            @ok="confirmDelete"
        >
            <p class="viewer__delete-text">
                {{ t('asset.deleteConfirm', { name: asset?.filename ?? '' }) }}
            </p>
        </a-modal>
    </div>
</template>

<style scoped>
.viewer {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
    height: calc(100vh - var(--px-space-16));
    min-height: 0;
}

.viewer__bar {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    min-height: calc(var(--px-control-height) + var(--px-space-3));
    padding: 0 var(--px-space-3);
    border: var(--px-border-width) solid var(--px-color-border-strong);
    border-radius: var(--px-radius-md);
    background: var(--px-color-bg-surface);
    box-shadow: var(--px-shadow-surface);
}

.viewer__title {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
}

.viewer__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--px-font-weight-semibold);
    line-height: var(--px-line-height-tight);
}

.viewer__tools {
    display: flex;
    align-items: center;
    gap: var(--px-space-1);
}

.viewer__icon-button {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height);
    height: var(--px-control-height);
    border: none;
    border-radius: var(--px-radius-sm);
    background: transparent;
    color: var(--px-color-text-secondary);
    cursor: pointer;
    transition: background-color var(--px-motion-duration-fast) var(--px-motion-easing-standard),
        color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.viewer__icon-button:hover {
    background: var(--px-color-bg-hover);
    color: var(--px-color-text-primary);
}

.viewer__icon-button--danger:hover {
    color: var(--px-color-danger);
}

.viewer__icon-button--active {
    background: var(--px-color-brand-soft);
    color: var(--px-color-brand);
}

.viewer__zoom {
    min-width: var(--px-space-10);
    text-align: center;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
    font-family: var(--px-font-family-mono);
}

.viewer__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--px-space-3);
    flex: 1;
    min-height: 0;
}

/* 1024px 以上信息面板作为侧栏；1280px 以下默认收起，按钮打开 */
@media (min-width: 1024px) {
    .viewer__body--info {
        grid-template-columns: minmax(0, 1fr) calc(var(--px-layout-card-min) * 1.55);
    }
}

@media (min-width: 1280px) {
    .viewer__body--info {
        grid-template-columns: minmax(0, 1fr) calc(var(--px-layout-card-min) * 1.75);
    }
}

.viewer__stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: var(--px-radius-md);
    background:
        radial-gradient(70% 70% at 50% 0%, var(--px-color-brand-softer), transparent 70%),
        var(--px-color-bg-sunken);
    touch-action: none;
    cursor: grab;
}

.viewer__stage--dragging {
    cursor: grabbing;
}

/* 拖拽/平移期间必须关掉过渡，否则画面会追着指针延迟 */
.viewer__stage--dragging .viewer__canvas {
    transition: none;
    will-change: transform;
}

.viewer__canvas {
    position: relative;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: 100%;
    transition: transform var(--px-motion-duration-fast) var(--px-motion-easing-standard);
    will-change: transform;
}

.viewer__preview {
    position: absolute;
    inset: 0;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: contain;
    opacity: 0;
    pointer-events: none;
}

/* 缩略图就绪后才显示并隐藏旧原图，避免不同比例图片残留 */
.viewer__preview--visible {
    opacity: 1;
}

.viewer__media {
    max-width: 100%;
    max-height: calc(100vh - var(--px-space-16) - var(--px-space-16));
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
}

.viewer__media--hidden {
    opacity: 0;
}

.viewer__unsupported {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--px-space-2);
    color: var(--px-color-text-secondary);
}

.viewer__nav {
    position: absolute;
    z-index: 2;
    top: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-lg);
    height: var(--px-control-height-lg);
    border: none;
    border-radius: var(--px-radius-full);
    background: color-mix(in srgb, var(--px-color-bg-surface) 84%, transparent);
    color: var(--px-color-text-primary);
    box-shadow: var(--px-shadow-surface);
    cursor: pointer;
    transform: translateY(-50%);
    opacity: 0.7;
    transition: opacity var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.viewer__nav:hover {
    opacity: 1;
}

.viewer__nav--prev {
    left: var(--px-space-4);
}

.viewer__nav--next {
    right: var(--px-space-4);
}

.viewer__hint {
    position: absolute;
    z-index: 2;
    left: 50%;
    bottom: var(--px-space-3);
    margin: 0;
    padding: var(--px-space-1) var(--px-space-3);
    border-radius: var(--px-radius-full);
    background: color-mix(in srgb, var(--px-color-bg-surface) 78%, transparent);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
    transform: translateX(-50%);
    pointer-events: none;
}

.viewer__loading {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
}

.viewer__info {
    display: none;
    flex-direction: column;
    gap: var(--px-space-3);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--px-space-5);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-md);
    background: var(--px-color-bg-surface);
    box-shadow: var(--px-shadow-surface);
}

.viewer__info--open {
    display: flex;
}

/* 桌面侧栏用工具栏按钮显隐；抽屉专属元素只在小屏出现 */
.viewer__scrim,
.viewer__panel-close,
.viewer__panel-title {
    display: none;
}

.viewer__panel-title {
    margin: 0;
    font-size: var(--px-font-size-subtitle);
    font-weight: var(--px-font-weight-semibold);
    color: var(--px-color-text-primary);
}

.viewer__panel-close {
    position: absolute;
    top: var(--px-space-2);
    right: var(--px-space-2);
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    border: none;
    border-radius: var(--px-radius-sm);
    background: transparent;
    color: var(--px-color-text-secondary);
    cursor: pointer;
}

.viewer__section {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.viewer__section + .viewer__section {
    padding-top: var(--px-space-3);
    border-top: var(--px-border-width) solid var(--px-color-border);
}

.viewer__section-title {
    margin: 0;
    font-size: var(--px-font-size-caption);
    font-weight: var(--px-font-weight-semibold);
    letter-spacing: var(--px-letter-spacing-wide);
    text-transform: uppercase;
    color: var(--px-color-text-tertiary);
}

.viewer__tags {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.viewer__tag-select {
    width: 100%;
}

.viewer__section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-2);
}

.viewer__pixiv {
    gap: var(--px-space-3);
}

.viewer__pixiv-head {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
}

.viewer__pixiv-title {
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-body);
    font-weight: var(--px-font-weight-semibold);
    overflow-wrap: anywhere;
}

.viewer__pixiv-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-space-1);
}

.viewer__pixiv-author {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--px-space-2);
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.viewer__pixiv-stats,
.viewer__pixiv-caption {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.viewer__pixiv-caption {
    max-height: calc(var(--px-space-16) * 4);
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.viewer__pixiv-subtitle {
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
    font-weight: var(--px-font-weight-semibold);
}

.viewer__pixiv-pages-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--px-space-2);
}

.viewer__pixiv-pages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--px-space-12) * 1.5), 1fr));
    gap: var(--px-space-2);
}

.viewer__pixiv-page {
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    padding: 0;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-tertiary);
    cursor: pointer;
}

.viewer__pixiv-page--active {
    border-color: var(--px-color-brand);
}

.viewer__pixiv-page img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.viewer__pixiv-missing {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: var(--px-font-size-micro);
}

.viewer__pixiv-page-index {
    position: absolute;
    right: var(--px-space-1);
    bottom: var(--px-space-1);
    padding: 0 var(--px-space-1);
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-elevated);
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-micro);
}

.viewer__pixiv-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-2);
}

.viewer__shortcuts {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    margin: 0;
}

.viewer__shortcut {
    display: grid;
    grid-template-columns: calc(var(--px-space-16) * 1.4) minmax(0, 1fr);
    align-items: center;
    gap: var(--px-space-2);
}

.viewer__shortcut dt {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-space-1);
}

.viewer__shortcut dd {
    margin: 0;
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.viewer__shortcut kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--px-space-5);
    padding: 0 var(--px-space-1);
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-xs);
    background: var(--px-color-bg-elevated);
    color: var(--px-color-text-primary);
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-micro);
}

.viewer__ugoira {
    display: block;
}

.viewer__empty {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.viewer__hint-text {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
}

.viewer__details {
    margin: 0;
}

.viewer__details-summary {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    padding: var(--px-space-1) 0;
    cursor: pointer;
    list-style: none;
}

.viewer__details-summary::-webkit-details-marker {
    display: none;
}

.viewer__details-summary::after {
    content: '›';
    margin-inline-start: auto;
    color: var(--px-color-text-tertiary);
    transition: transform var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.viewer__details[open] > .viewer__details-summary::after {
    transform: rotate(90deg);
}

.viewer__details[open] > .viewer__meta {
    margin-top: var(--px-space-2);
}

.viewer__meta {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    margin: 0;
}

.viewer__meta-row {
    display: grid;
    grid-template-columns: calc(var(--px-space-16) * 1.4) minmax(0, 1fr);
    gap: var(--px-space-2);
    padding: var(--px-space-2) 0;
    border-bottom: var(--px-border-width) solid var(--px-color-border);
}

.viewer__meta-row:last-child {
    border-bottom: none;
}

.viewer__meta-row dt {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.viewer__meta-row dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: var(--px-font-size-caption);
    color: var(--px-color-text-secondary);
}

.viewer__filename {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.viewer__filename > span {
    min-width: 0;
    overflow-wrap: anywhere;
}

.viewer__rename {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--px-control-height-sm);
    height: var(--px-control-height-sm);
    border: none;
    border-radius: var(--px-radius-xs);
    background: none;
    color: var(--px-color-text-tertiary);
    cursor: pointer;
}

.viewer__rename:hover {
    background: var(--px-color-bg-sunken);
    color: var(--px-color-text-primary);
}

.viewer__mono {
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-micro) !important;
}

.viewer__similar {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--px-layout-card-min) / 2.8), 1fr));
    gap: var(--px-space-3);
}

.viewer__similar-item {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    padding: 0;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-sm);
    background: var(--px-color-bg-surface);
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
    cursor: pointer;
    overflow: hidden;
}

.viewer__similar-item img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    display: block;
}

.viewer__similar-item span {
    padding: 0 var(--px-space-1) var(--px-space-1);
}

.viewer__delete-text {
    margin: 0;
    color: var(--px-color-text-secondary);
    line-height: var(--px-line-height-relaxed);
}

@media (max-width: 1023px) {
    .viewer {
        height: auto;
        min-height: calc(100vh - var(--px-space-8));
    }

    .viewer__body {
        grid-template-columns: minmax(0, 1fr);
    }

    .viewer__stage {
        height: calc(100vh - var(--px-space-16));
    }

    .viewer__media {
        max-height: calc(100vh - var(--px-space-16) - var(--px-space-10));
    }

    .viewer__info-toggle {
        display: inline-flex;
    }

    .viewer__info {
        position: fixed;
        inset: auto 0 0;
        display: none;
        max-height: 76vh;
        padding: var(--px-space-5) var(--px-space-4) calc(var(--px-space-5) + env(safe-area-inset-bottom));
        border-width: var(--px-border-width) 0 0;
        border-radius: var(--px-radius-lg) var(--px-radius-lg) 0 0;
        z-index: var(--px-z-modal);
    }

    .viewer__info--open {
        display: flex;
    }

    .viewer__panel-close,
    .viewer__panel-title {
        display: block;
    }

    .viewer__panel-close {
        display: inline-flex;
    }

    .viewer__scrim {
        position: fixed;
        inset: 0;
        display: block;
        background: color-mix(in srgb, var(--px-color-text-primary) 45%, transparent);
        z-index: calc(var(--px-z-modal) - 1);
    }
}

/* 小屏标题栏贴住导航栏与屏幕两边，去掉卡片式圆角/阴影 */
@media (max-width: 839px) {
    .viewer__bar {
        border-width: 0 0 calc(var(--px-border-width) * 2);
        border-color: var(--px-color-border-strong);
        border-radius: 0;
        box-shadow: none;
    }
}

@media (min-width: 600px) and (max-width: 839px) {
    .viewer {
        margin: calc(-1 * var(--px-space-8)) calc(-1 * var(--px-space-8)) 0;
    }
}

@media (max-width: 599px) {
    .viewer {
        margin: calc(-1 * var(--px-space-4)) calc(-1 * var(--px-space-4)) 0;
    }

    /* 工具按钮在小屏放不下时只在工具条内部滚动，不让整页出现横向滚动条 */
    .viewer__tools {
        flex: 0 1 auto;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
    }

    .viewer__tools::-webkit-scrollbar {
        display: none;
    }
}
</style>
