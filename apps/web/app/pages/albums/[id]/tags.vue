<script setup lang="ts">
import type { TagImportItem, TagRow } from '~~/shared/tags';

definePageMeta({
    layout: 'album',
});

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const router = useRouter();
const albumId = computed(() => String(route.params.id ?? ''));
const { tags, album, error: contextError, load } = useAlbumContext(albumId);

const title = computed(() => t('album.moduleTags'));
const exportHref = computed(() => `/api/v1/albums/${albumId.value}/tags/export`);

const adapter = {
    reload: () => load(true),
    create: async (input: { name: string, color?: string }) => {
        await api.albums[':albumId'].tags.$post({
            param: { albumId: albumId.value },
            json: input,
        });
    },
    update: async (tagId: string, patch: { name?: string, color?: string }) => {
        await api.albums[':albumId'].tags[':tagId'].$patch({
            param: { albumId: albumId.value, tagId },
            json: patch,
        });
    },
    remove: async (tagId: string) => {
        await api.albums[':albumId'].tags[':tagId'].$delete({
            param: { albumId: albumId.value, tagId },
        });
    },
    batchDelete: async (ids: string[]) => {
        const response = await api.albums[':albumId'].tags['batch-delete'].$post({
            param: { albumId: albumId.value },
            json: { ids },
        });
        const body = await response.json();

        return body.data.removed;
    },
    merge: async (sourceIds: string[], targetId: string) => {
        const response = await api.albums[':albumId'].tags.merge.$post({
            param: { albumId: albumId.value },
            json: { sourceIds, targetId },
        });
        const body = await response.json();

        return body.data;
    },
    recolor: async (mode: 'auto' | 'random') => {
        const response = await api.albums[':albumId'].tags.colors.$post({
            param: { albumId: albumId.value },
            json: { mode, onlyEmpty: mode === 'auto' },
        });
        const body = await response.json();

        return body.data.updated;
    },
    deleteAll: async () => {
        const response = await api.albums[':albumId'].tags['delete-all'].$post({
            param: { albumId: albumId.value },
            json: { confirm: true },
        });
        const body = await response.json();

        return body.data.removed;
    },
    importTags: async (items: TagImportItem[]) => {
        const response = await api.albums[':albumId'].tags.import.$post({
            param: { albumId: albumId.value },
            json: { tags: items },
        });
        const body = await response.json();

        return body.data;
    },
};

const {
    busy,
    creating,
    importing,
    newName,
    newColor,
    error,
    notice,
    create,
    update,
    remove,
    batchDelete,
    merge,
    recolor,
    deleteAll,
    importTags,
    importInvalid,
} = useTagManager(adapter);

/** 点击标签 = 在照片页按该标签筛选 */
function openTag(row: TagRow): void {
    void router.push({ path: `/albums/${albumId.value}`, query: { tag: row.id } });
}

function clearError(): void {
    error.value = '';
}

function clearNotice(): void {
    notice.value = '';
}

useHead({
    title: () => `${title.value} · ${album.value?.name ?? t('album.title')} · PictureX`,
});

onMounted(() => {
    void load();
});
</script>

<template>
    <div class="px-page px-page--compact">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    {{ album?.name ?? '' }}
                </p>
                <h1 class="px-page-title">
                    {{ title }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('album.tagsSubtitle') }}
                </p>
            </div>
        </header>

        <a-alert v-if="error || contextError" type="error" show-icon closable :message="error || contextError" @close="clearError" />
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="clearNotice" />

        <TagManager
            v-model:new-name="newName"
            v-model:new-color="newColor"
            :tags="tags"
            :busy="busy"
            :creating="creating"
            :importing="importing"
            :export-href="exportHref"
            :open-hint="t('album.tagOpenHint')"
            @create="create"
            @update="update"
            @remove="remove"
            @batch-delete="batchDelete"
            @merge="merge"
            @recolor="recolor"
            @delete-all="deleteAll"
            @import="importTags"
            @import-invalid="importInvalid"
            @open="openTag"
        />
    </div>
</template>
