<script setup lang="ts">
import { ClearOutlined } from '@antdv-next/icons';
import type { AssetSummaryDto } from '~~/server/domain/asset-query';

interface DuplicateFileDto {
    id: string
    sourcePath: string
    filename: string
    size: number
    foundAt: string
}

interface DuplicateGroupDto {
    key: string
    count: number
    asset: AssetSummaryDto
    duplicates: DuplicateFileDto[]
}

const props = defineProps<{
    albumId: string
}>();

const emit = defineEmits<{
    changed: []
}>();

const { t } = useI18n();
const api = useApi();
const { formatBytes } = useFormat();

const groups = ref<DuplicateGroupDto[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const selected = ref<Set<string>>(new Set());
const deleting = ref(false);
const cleaning = ref(false);

function toggle(id: string): void {
    const next = new Set(selected.value);

    if (next.has(id)) {
        next.delete(id);
    }
    else {
        next.add(id);
    }

    selected.value = next;
}

async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    selected.value = new Set();

    try {
        const response = await api.albums[':albumId'].groups.duplicates.$get({
            param: { albumId: props.albumId },
            query: { limit: '100' },
        });
        const body = await response.json();

        groups.value = body.data;
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loading.value = false;
    }
}

async function removeFiles(ids: string[]): Promise<void> {
    if (ids.length === 0) {
        return;
    }

    deleting.value = true;
    error.value = '';

    try {
        for (const id of ids) {
            await api.albums[':albumId'].duplicates[':duplicateId'].$delete({
                param: { albumId: props.albumId, duplicateId: id },
            });
        }

        await load();
        emit('changed');
    }
    catch (removeError) {
        error.value = errorMessage(removeError);
    }
    finally {
        deleting.value = false;
    }
}

async function cleanupAll(): Promise<void> {
    cleaning.value = true;
    error.value = '';

    try {
        const response = await api.albums[':albumId'].duplicates.cleanup.$post({
            param: { albumId: props.albumId },
            json: { confirm: true },
        });
        const body = await response.json();
        const result = body.data as { groups: number, cleared: number };

        notice.value = t('asset.cleanupDone', {
            groups: result.groups,
            cleared: result.cleared,
        });

        await load();
        emit('changed');
    }
    catch (cleanupError) {
        error.value = errorMessage(cleanupError);
    }
    finally {
        cleaning.value = false;
    }
}

onMounted(load);
</script>

<template>
    <div class="duplicates">
        <div class="duplicates__toolbar">
            <span class="duplicates__summary">
                {{ t('album.dedupTitle') }} · {{ groups.length }}
            </span>
            <div class="duplicates__actions">
                <a-popconfirm
                    :title="t('asset.cleanupConfirm')"
                    :ok-text="t('common.delete')"
                    :cancel-text="t('common.cancel')"
                    :disabled="groups.length === 0"
                    @confirm="cleanupAll"
                >
                    <a-button danger :disabled="groups.length === 0" :loading="cleaning">
                        <template #icon>
                            <ClearOutlined />
                        </template>
                        {{ t('asset.cleanupAll') }}
                    </a-button>
                </a-popconfirm>
                <a-popconfirm
                    :title="t('asset.batchDeleteFilesConfirm', { count: selected.size })"
                    :ok-text="t('common.delete')"
                    :cancel-text="t('common.cancel')"
                    :disabled="selected.size === 0"
                    @confirm="removeFiles([...selected])"
                >
                    <a-button danger :disabled="selected.size === 0" :loading="deleting">
                        {{ t('asset.batchDeleteFiles') }} ({{ selected.size }})
                    </a-button>
                </a-popconfirm>
            </div>
        </div>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''">
            <template #action>
                <a-button size="small" @click="load">
                    {{ t('common.retry') }}
                </a-button>
            </template>
        </a-alert>
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />

        <div v-if="loading" class="duplicates__loading">
            <a-spin />
        </div>

        <a-empty v-else-if="groups.length === 0" :description="t('asset.noDuplicates')" />

        <template v-else>
            <section v-for="group in groups" :key="group.key" class="dup-group px-surface">
                <header class="dup-group__header">
                    <NuxtLink
                        :to="`/albums/${albumId}/assets/${group.asset.id}`"
                        class="dup-group__thumb-link"
                        :aria-label="t('asset.openViewer')"
                    >
                        <AssetThumbImage
                            class="dup-group__thumb"
                            :album-id="albumId"
                            :asset-id="group.asset.id"
                            :alt="group.asset.displayName"
                            :width="64"
                        />
                    </NuxtLink>
                    <div class="dup-group__main">
                        <h3 class="dup-group__name">
                            {{ group.asset.displayName }}
                        </h3>
                        <p class="dup-group__meta">
                            {{ t('asset.kept') }} · {{ formatBytes(group.asset.size) }}
                            · {{ t('asset.duplicateGroup', { count: group.count }) }}
                        </p>
                    </div>
                </header>

                <ul class="dup-group__files">
                    <li v-for="file in group.duplicates" :key="file.id" class="dup-file">
                        <a-checkbox
                            :checked="selected.has(file.id)"
                            @change="toggle(file.id)"
                        />
                        <div class="dup-file__main">
                            <span class="dup-file__name">{{ file.filename }}</span>
                            <span class="dup-file__path px-selectable">{{ file.sourcePath }}</span>
                        </div>
                        <span class="dup-file__size">{{ formatBytes(file.size) }}</span>
                        <a-popconfirm
                            :title="t('asset.deleteDuplicateConfirm', { name: file.filename })"
                            :ok-text="t('common.delete')"
                            :cancel-text="t('common.cancel')"
                            @confirm="removeFiles([file.id])"
                        >
                            <a-button danger size="small" type="text">
                                {{ t('asset.deleteDuplicateFile') }}
                            </a-button>
                        </a-popconfirm>
                    </li>
                </ul>
            </section>
        </template>
    </div>
</template>

<style scoped>
.duplicates {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-4);
}

.duplicates__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.duplicates__summary {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}

.duplicates__actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.duplicates__loading {
    display: flex;
    justify-content: center;
    padding: var(--px-space-10);
}

.dup-group {
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.dup-group__header {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    padding: var(--px-space-3) var(--px-space-4);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
}

.dup-group__thumb-link {
    display: block;
    flex: none;
    border-radius: var(--px-radius-sm);
    overflow: hidden;
    cursor: zoom-in;
}

.dup-group__thumb-link:focus-visible {
    outline: calc(var(--px-border-width) * 2) solid var(--px-color-brand);
}

.dup-group__thumb {
    width: var(--px-space-16);
    height: var(--px-space-16);
    border-radius: var(--px-radius-sm);
    object-fit: cover;
    background: var(--px-color-bg-sunken);
}

.dup-group__main {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    min-width: 0;
}

.dup-group__name {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--px-font-size-body-lg);
    font-weight: var(--px-font-weight-semibold);
}

.dup-group__meta {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.dup-group__files {
    list-style: none;
    margin: 0;
    padding: 0;
}

.dup-file {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    padding: var(--px-space-2) var(--px-space-4);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
}

.dup-file:last-child {
    border-bottom: none;
}

.dup-file__main {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    flex: 1;
    min-width: 0;
}

.dup-file__name {
    font-size: var(--px-font-size-body);
    color: var(--px-color-text-primary);
}

.dup-file__path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-micro);
    font-family: var(--px-font-family-mono);
}

.dup-file__size {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
    white-space: nowrap;
}
</style>
