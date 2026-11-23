<script setup lang="ts">
import { CloudOutlined, PictureOutlined, PlusOutlined, ReloadOutlined, RightOutlined } from '@antdv-next/icons';
import type { AlbumSummary } from '~~/server/album/album-store';

const { t } = useI18n();
const api = useApi();
const router = useRouter();
const { formatNumber } = useFormat();

const albums = ref<AlbumSummary[]>([]);
const globalCount = ref(0);
const pixivTotal = ref(0);
const pixivPending = ref(0);
const loading = ref(true);
const loadingMore = ref(false);
const page = ref(1);
const total = ref(0);
const error = ref('');

const createOpen = ref(false);
const pickerOpen = ref(false);
const pickerMode = ref<'directory' | 'album'>('directory');
const pickerInitial = ref<string | undefined>(undefined);
const createForm = reactive({ name: '', description: '', dir: '' });
const saving = ref(false);

const renameOpen = ref(false);
const renameTarget = ref<AlbumSummary | null>(null);
const renameName = ref('');
const renaming = ref(false);

const deleteOpen = ref(false);

const missingAlbums = computed(() => albums.value.filter(album => album.missing));
const corruptAlbums = computed(() => albums.value.filter(album => album.corrupt));
const deleteTarget = ref<AlbumSummary | null>(null);
const deleting = ref(false);

async function load(): Promise<void> {
    loading.value = true;
    error.value = '';

    try {
        const response = await api.albums.$get({ query: { page: '1', pageSize: '100' } });
        const body = await response.json();

        page.value = 1;
        total.value = body.pagination.total;
        albums.value = body.data;
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loading.value = false;
    }
}

async function loadMore(): Promise<void> {
    if (loadingMore.value || albums.value.length >= total.value) {
        return;
    }

    loadingMore.value = true;
    error.value = '';

    try {
        const next = page.value + 1;
        const response = await api.albums.$get({ query: { page: String(next), pageSize: '100' } });
        const body = await response.json();

        page.value = next;
        total.value = body.pagination.total;
        albums.value = [...albums.value, ...body.data];
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loadingMore.value = false;
    }
}

function openCreate(): void {
    createForm.name = '';
    createForm.description = '';
    createForm.dir = '';
    createOpen.value = true;
}

async function submitCreate(): Promise<void> {
    if (createForm.name.trim() === '') {
        return;
    }

    saving.value = true;
    error.value = '';

    try {
        const response = await api.albums.$post({
            json: {
                name: createForm.name.trim(),
                description: createForm.description.trim() || undefined,
                dir: createForm.dir.trim() || undefined,
            },
        });
        const body = await response.json();

        albums.value = [body.data, ...albums.value];
        total.value += 1;
        createOpen.value = false;
    }
    catch (createError) {
        error.value = errorMessage(createError);
    }
    finally {
        saving.value = false;
    }
}

function openDirectoryPicker(): void {
    pickerMode.value = 'directory';
    pickerInitial.value = createForm.dir.trim() || undefined;
    pickerOpen.value = true;
}

function openAlbumPicker(): void {
    pickerMode.value = 'album';
    pickerInitial.value = undefined;
    pickerOpen.value = true;
}

async function onPick(path: string): Promise<void> {
    if (pickerMode.value === 'directory') {
        createForm.dir = path;

        return;
    }

    error.value = '';

    try {
        const response = await api.albums.link.$post({ json: { dir: path } });
        const body = await response.json();
        const existed = albums.value.some(album => album.id === body.data.id);

        albums.value = [body.data, ...albums.value.filter(album => album.id !== body.data.id)];

        if (!existed) {
            total.value += 1;
        }
    }
    catch (linkError) {
        error.value = errorMessage(linkError);
    }
}

function openAlbum(id: string): void {
    void router.push(`/albums/${id}`);
}

function openDefaultAlbum(): void {
    void router.push('/library');
}

function openPixivLibrary(): void {
    void router.push('/pixiv');
}

async function loadDefaultAlbumStats(): Promise<void> {
    try {
        const response = await api.viewer.media.$get({ query: { limit: '1' } });
        const body = await response.json();

        globalCount.value = body.total;
    }
    catch {
        // 虚拟默认相册的统计失败不影响真实相册列表
    }
}

async function loadPixivStats(): Promise<void> {
    try {
        const response = await api.pixiv.library.stats.$get();
        const body = await response.json();

        pixivTotal.value = body.data.total;
        pixivPending.value = body.data.placeholder;
    }
    catch {
        // Pixiv 库尚未初始化时保持 0，不影响相册列表
    }
}

function requestRename(id: string): void {
    const target = albums.value.find(album => album.id === id);

    if (!target) {
        return;
    }

    renameTarget.value = target;
    renameName.value = target.name;
    renameOpen.value = true;
}

async function submitRename(): Promise<void> {
    const target = renameTarget.value;

    if (!target || renameName.value.trim() === '') {
        return;
    }

    renaming.value = true;
    error.value = '';

    try {
        const response = await api.albums[':albumId'].$patch({
            param: { albumId: target.id },
            json: { name: renameName.value.trim() },
        });
        const body = await response.json();

        albums.value = albums.value.map(album => (
            album.id === target.id ? { ...album, ...body.data } : album
        ));
        renameOpen.value = false;
    }
    catch (renameError) {
        error.value = errorMessage(renameError);
    }
    finally {
        renaming.value = false;
    }
}

function requestDelete(id: string): void {
    const target = albums.value.find(album => album.id === id);

    if (!target) {
        return;
    }

    deleteTarget.value = target;
    deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
    const target = deleteTarget.value;

    if (!target) {
        return;
    }

    deleting.value = true;
    error.value = '';

    try {
        await api.albums[':albumId'].$delete({ param: { albumId: target.id }, query: {} });
        albums.value = albums.value.filter(album => album.id !== target.id);
        total.value = Math.max(0, total.value - 1);
        deleteOpen.value = false;
        deleteTarget.value = null;
    }
    catch (deleteError) {
        error.value = errorMessage(deleteError);
    }
    finally {
        deleting.value = false;
    }
}

useHead({
    title: () => `${t('album.title')} · PictureX`,
});

onMounted(() => {
    void load();
    void loadDefaultAlbumStats();
    void loadPixivStats();
});
</script>

<template>
    <div class="px-page albums-page">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    PICTUREX
                </p>
                <h1 class="px-page-title">
                    {{ t('album.title') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('album.subtitle') }}
                </p>
            </div>
            <div class="albums-actions">
                <a-button :aria-label="t('common.refresh')" @click="load">
                    <template #icon>
                        <ReloadOutlined />
                    </template>
                </a-button>
                <a-button @click="openAlbumPicker">
                    {{ t('album.linkExisting') }}
                </a-button>
                <a-button type="primary" @click="openCreate">
                    <template #icon>
                        <PlusOutlined />
                    </template>
                    {{ t('album.create') }}
                </a-button>
            </div>
        </header>

        <a-alert
            v-if="error"
            type="error"
            show-icon
            closable
            :message="error"
            @close="error = ''"
        />

        <a-alert
            v-if="corruptAlbums.length > 0"
            type="error"
            show-icon
            :message="t('album.corruptBanner', { count: corruptAlbums.length })"
            :description="t('album.corruptBannerHint')"
        />
        <a-alert
            v-if="missingAlbums.length > 0"
            type="warning"
            show-icon
            :message="t('album.missingBanner', { count: missingAlbums.length })"
            :description="t('album.missingBannerHint')"
        />

        <div class="home-entries">
            <button type="button" class="default-album px-surface" @click="openDefaultAlbum">
                <span class="default-album__icon">
                    <PictureOutlined />
                </span>
                <span class="default-album__text">
                    <span class="default-album__title">{{ t('home.defaultAlbum') }}</span>
                    <span class="default-album__hint">{{ t('home.defaultAlbumHint', { count: formatNumber(globalCount) }) }}</span>
                </span>
                <RightOutlined class="default-album__arrow" />
            </button>
            <button type="button" class="default-album px-surface" @click="openPixivLibrary">
                <span class="default-album__icon">
                    <CloudOutlined />
                </span>
                <span class="default-album__text">
                    <span class="default-album__title">{{ t('home.pixivLibrary') }}</span>
                    <span class="default-album__hint">
                        {{ t('home.pixivLibraryHint', {
                            total: formatNumber(pixivTotal),
                            pending: formatNumber(pixivPending),
                        }) }}
                    </span>
                </span>
                <RightOutlined class="default-album__arrow" />
            </button>
        </div>

        <div v-if="loading" class="albums-loading">
            <a-spin />
        </div>

        <div v-else-if="albums.length === 0" class="albums-empty px-surface">
            <a-empty :description="t('album.empty')">
                <p class="albums-empty__hint">
                    {{ t('album.emptyHint') }}
                </p>
                <a-button type="primary" @click="openCreate">
                    {{ t('album.create') }}
                </a-button>
            </a-empty>
        </div>

        <div v-else class="albums-grid">
            <AlbumCard
                v-for="album in albums"
                :key="album.id"
                :album="album"
                :dir="album.dir"
                :missing="album.missing"
                :corrupt="album.corrupt"
                @open="openAlbum"
                @rename="requestRename"
                @delete="requestDelete"
            />
        </div>

        <div v-if="!loading && albums.length < total" class="albums-more">
            <a-button :loading="loadingMore" @click="loadMore">
                {{ t('common.loadMore') }}
            </a-button>
        </div>

        <a-modal
            v-model:open="createOpen"
            :title="t('album.createTitle')"
            :ok-text="t('common.create')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="saving"
            @ok="submitCreate"
        >
            <a-form layout="vertical">
                <a-form-item :label="t('album.nameLabel')" required>
                    <a-input
                        v-model:value="createForm.name"
                        :placeholder="t('album.namePlaceholder')"
                        :maxlength="120"
                        @press-enter="submitCreate"
                    />
                </a-form-item>
                <a-form-item :label="t('album.descriptionLabel')">
                    <a-textarea
                        v-model:value="createForm.description"
                        :placeholder="t('album.descriptionPlaceholder')"
                        :maxlength="2000"
                        :rows="3"
                    />
                </a-form-item>
                <a-form-item :label="t('album.customPath')">
                    <div class="albums-path-row">
                        <a-input
                            v-model:value="createForm.dir"
                            placeholder="D:/Photos/MyAlbum"
                            :maxlength="4096"
                            class="px-selectable"
                        />
                        <a-button @click="openDirectoryPicker">
                            {{ t('album.browse') }}
                        </a-button>
                    </div>
                    <p class="px-hint">
                        {{ t('album.customPathHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </a-modal>

        <a-modal
            v-model:open="renameOpen"
            :title="t('album.renameTitle')"
            :ok-text="t('common.save')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="renaming"
            @ok="submitRename"
        >
            <a-input
                v-model:value="renameName"
                :placeholder="t('album.namePlaceholder')"
                :maxlength="120"
                @press-enter="submitRename"
            />
        </a-modal>

        <a-modal
            v-model:open="deleteOpen"
            :title="t('album.unlinkTitle')"
            :ok-text="t('album.unlink')"
            :cancel-text="t('common.cancel')"
            :confirm-loading="deleting"
            @ok="confirmDelete"
        >
            <p class="albums-delete-text">
                {{ t('album.unlinkConfirm', { name: deleteTarget?.name ?? '' }) }}
            </p>
            <p class="px-hint">
                {{ t('album.unlinkHint') }}
            </p>
        </a-modal>

        <DirectoryPicker
            v-model:open="pickerOpen"
            :mode="pickerMode"
            :initial-path="pickerInitial"
            @select="onPick"
        />
    </div>
</template>

<style scoped>
.albums-page {
    min-height: 100%;
}

.albums-actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.albums-path-row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.albums-path-row :deep(.ant-input) {
    flex: 1;
}

.home-entries {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(calc(var(--px-space-16) * 5), 1fr));
    gap: var(--px-space-4);
}

.default-album {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    width: 100%;
    padding: var(--px-space-4);
    text-align: left;
    cursor: pointer;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-lg);
    transition: border-color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.default-album:hover,
.default-album:focus-visible {
    border-color: var(--px-color-brand);
}

.default-album__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-control-height-lg);
    height: var(--px-control-height-lg);
    color: var(--px-color-brand);
    font-size: var(--px-font-size-body-lg);
    background: var(--px-color-brand-soft);
    border-radius: var(--px-radius-md);
}

.default-album__text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--px-space-1);
    min-width: 0;
}

.default-album__title {
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.default-album__hint {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.default-album__arrow {
    color: var(--px-color-text-tertiary);
}

.albums-loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-16);
}

.albums-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--px-space-16);
}

.albums-empty__hint {
    margin: var(--px-space-1) 0 var(--px-space-4);
    color: var(--px-color-text-secondary);
}

.albums-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-layout-card-min), 1fr));
    gap: var(--px-space-4);
}

.albums-more {
    display: flex;
    justify-content: center;
    padding-top: var(--px-space-4);
}

.albums-delete-text {
    margin: 0;
    color: var(--px-color-text-secondary);
    line-height: var(--px-line-height-relaxed);
}
</style>
