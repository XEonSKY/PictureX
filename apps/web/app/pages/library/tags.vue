<script setup lang="ts">
import type { TagImportItem, TagRow } from '~~/shared/tags';

definePageMeta({
    layout: 'library',
});

const { t } = useI18n();
const api = useApi();
const router = useRouter();
const tags = ref<TagRow[]>([]);
const loadError = ref('');

async function loadTags(): Promise<void> {
    try {
        const response = await api.viewer.tags.$get();
        const body = await response.json();

        tags.value = body.data ?? [];
        loadError.value = '';
    }
    catch (tagError) {
        loadError.value = tagError instanceof Error ? tagError.message : String(tagError);
    }
}

const adapter = {
    reload: loadTags,
    create: async (input: { name: string, color?: string }) => {
        await api.viewer.tags.$post({ json: input });
    },
    update: async (tagId: string, patch: { name?: string, color?: string }) => {
        await api.viewer.tags[':tagId'].$patch({ param: { tagId }, json: patch });
    },
    remove: async (tagId: string) => {
        await api.viewer.tags[':tagId'].$delete({ param: { tagId } });
    },
    batchDelete: async (ids: string[]) => {
        const response = await api.viewer.tags['batch-delete'].$post({ json: { ids } });
        const body = await response.json();

        return body.data.removed;
    },
    merge: async (sourceIds: string[], targetId: string) => {
        const response = await api.viewer.tags.merge.$post({ json: { sourceIds, targetId } });
        const body = await response.json();

        return body.data;
    },
    recolor: async (mode: 'auto' | 'random') => {
        const response = await api.viewer.tags.colors.$post({ json: { mode, onlyEmpty: mode === 'auto' } });
        const body = await response.json();

        return body.data.updated;
    },
    deleteAll: async () => {
        const response = await api.viewer.tags['delete-all'].$post({ json: { confirm: true } });
        const body = await response.json();

        return body.data.removed;
    },
    importTags: async (items: TagImportItem[]) => {
        const response = await api.viewer.tags.import.$post({ json: { tags: items } });
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

const displayError = computed(() => loadError.value || error.value);
const displayNotice = computed(() => notice.value);

function clearErrors(): void {
    loadError.value = '';
    error.value = '';
}

function clearNotice(): void {
    notice.value = '';
}

/** 点击标签 = 到全局图库按该标签筛选 */
function openTag(row: TagRow): void {
    void router.push({ path: '/library', query: { tag: row.id } });
}

useHead({
    title: () => `${t('library.tagsTitle')} · PictureX`,
});

onMounted(async () => {
    await loadTags();
});
</script>

<template>
    <div class="px-page px-page--compact">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    PictureX
                </p>
                <h1 class="px-page-title">
                    {{ t('library.tagsTitle') }}
                </h1>
                <p class="px-page-subtitle">
                    {{ t('library.tagsSubtitle') }}
                </p>
            </div>
            <div class="px-header-actions">
                <span class="px-header-meta">
                    {{ t('library.tagCount', { count: tags.length }) }}
                </span>
            </div>
        </header>

        <a-alert
            v-if="displayError"
            type="error"
            show-icon
            closable
            :message="displayError"
            @close="clearErrors"
        />
        <a-alert
            v-if="displayNotice"
            type="success"
            show-icon
            closable
            :message="displayNotice"
            @close="clearNotice"
        />

        <TagManager
            v-model:new-name="newName"
            v-model:new-color="newColor"
            :tags="tags"
            :busy="busy"
            :creating="creating"
            :importing="importing"
            export-href="/api/v1/viewer/tags/export"
            :open-hint="t('library.tagsOpenHint')"
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
