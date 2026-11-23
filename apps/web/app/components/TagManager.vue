<script setup lang="ts">
import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, SearchOutlined, UploadOutlined } from '@antdv-next/icons';
import type { TagImportItem, TagRow } from '~~/shared/tags';
import { MAX_TAG_NAME_LENGTH, parseTagImport } from '~~/shared/tags';

const props = withDefaults(defineProps<{
    tags: TagRow[]
    busy: string | null
    creating?: boolean
    importing?: boolean
    exportHref: string
    /** 点击标签的提示（相册内跳到照片，全局跳到图库） */
    openHint: string
    /** 是否允许删除/合并标签；需要只读展示时显式传 false */
    allowDestructive?: boolean
    /** allowDestructive=false 时展示的说明 */
    readonlyHint?: string
    /** 删除全部标签的确认文案；不传时使用相册默认文案 */
    deleteAllHint?: string
}>(), {
    creating: false,
    importing: false,
    allowDestructive: true,
});

const emit = defineEmits<{
    create: []
    update: [{ id: string, name: string, color?: string }]
    remove: [id: string]
    batchDelete: [ids: string[]]
    merge: [{ sourceIds: string[], targetId: string }]
    recolor: [mode: 'auto' | 'random']
    deleteAll: []
    import: [tags: TagImportItem[]]
    importInvalid: []
    open: [tag: TagRow]
}>();

const newName = defineModel<string>('newName', { default: '' });
const newColor = defineModel<string | undefined>('newColor');

const { t } = useI18n();

const selected = ref<Set<string>>(new Set());
const mergeTarget = ref<string | undefined>(undefined);
const editOpen = ref(false);
const editing = ref<{ id: string, name: string, color?: string } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const query = ref('');
const sortMode = ref<'usage' | 'name' | 'created'>('usage');
const page = ref(1);
const pageSize = ref(50);

const sortOptions = computed(() => [
    { value: 'usage', label: t('album.tagSortUsage') },
    { value: 'name', label: t('album.tagSortName') },
    { value: 'created', label: t('album.tagSortCreated') },
]);

/** 客户端筛选/排序/分页：标签总数可能上千，避免一次渲染全部行 */
const filteredTags = computed(() => {
    const needle = query.value.trim().toLocaleLowerCase();
    const rows = (needle === ''
        ? [...props.tags]
        : props.tags.filter(tag => tag.name.toLocaleLowerCase().includes(needle)));

    rows.sort((left, right) => {
        if (sortMode.value === 'name') {
            return left.name.localeCompare(right.name);
        }
        if (sortMode.value === 'created') {
            return (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.name.localeCompare(right.name);
        }

        return right.count - left.count || left.name.localeCompare(right.name);
    });

    return rows;
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredTags.value.length / pageSize.value)));
const visibleTags = computed(() => {
    const start = (page.value - 1) * pageSize.value;

    return filteredTags.value.slice(start, start + pageSize.value);
});

const selectedCount = computed(() => selected.value.size);
const filteredSelectedCount = computed(() => filteredTags.value.filter(tag => selected.value.has(tag.id)).length);
const allSelected = computed(() => filteredTags.value.length > 0
  && filteredSelectedCount.value === filteredTags.value.length);
const someSelected = computed(() => filteredSelectedCount.value > 0 && !allSelected.value);
const mergeOptions = computed(() => filteredTags.value.map(tag => ({ value: tag.id, label: tag.name })));
const mergeTargetName = computed(() => props.tags.find(tag => tag.id === mergeTarget.value)?.name ?? '');

watch([query, sortMode], () => {
    page.value = 1;
});

watch([filteredTags, pageSize], () => {
    if (page.value > pageCount.value) {
        page.value = pageCount.value;
    }
});

watch(() => props.tags, (rows) => {
    const ids = new Set(rows.map(tag => tag.id));
    const next = new Set([...selected.value].filter(id => ids.has(id)));

    if (next.size !== selected.value.size) {
        selected.value = next;
    }
    if (mergeTarget.value && !ids.has(mergeTarget.value)) {
        mergeTarget.value = undefined;
    }
    if (selected.value.size < 2) {
        mergeTarget.value = undefined;
    }
    else if (!mergeTarget.value) {
        mergeTarget.value = [...selected.value][0];
    }
});

watch(selected, () => {
    if (mergeTarget.value && !selected.value.has(mergeTarget.value)) {
        mergeTarget.value = [...selected.value][0];
    }
    else if (!mergeTarget.value && selected.value.size >= 2) {
        mergeTarget.value = [...selected.value][0];
    }

    if (selected.value.size < 2) {
        mergeTarget.value = undefined;
    }
});

function toggle(tagId: string): void {
    const next = new Set(selected.value);

    if (next.has(tagId)) {
        next.delete(tagId);
    }
    else {
        next.add(tagId);
    }

    selected.value = next;
}

function toggleAll(): void {
    const next = new Set(selected.value);

    if (allSelected.value) {
        for (const tag of filteredTags.value) {
            next.delete(tag.id);
        }
    }
    else {
        for (const tag of filteredTags.value) {
            next.add(tag.id);
        }
    }

    selected.value = next;
}

function submitCreate(): void {
    if (newName.value.trim() === '' || props.creating) {
        return;
    }

    emit('create');
}

function openEdit(tag: TagRow): void {
    editing.value = {
        id: tag.id,
        name: tag.name,
        color: tag.color === '' ? undefined : tag.color,
    };
    editOpen.value = true;
}

function saveEdit(): void {
    const draft = editing.value;

    if (!draft || draft.name.trim() === '') {
        return;
    }

    emit('update', { id: draft.id, name: draft.name.trim(), color: draft.color });
    editOpen.value = false;
}

function pickImportFile(): void {
    fileInput.value?.click();
}

async function onImportFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    input.value = '';

    if (!file) {
        return;
    }

    try {
        const parsed = parseTagImport(JSON.parse(await file.text()));

        if (!parsed || parsed.length === 0) {
            emit('importInvalid');

            return;
        }

        emit('import', parsed);
    }
    catch {
        emit('importInvalid');
    }
}

function openTag(tag: TagRow): void {
    emit('open', tag);
}

function onPageChange(nextPage: number, nextPageSize: number): void {
    page.value = nextPage;
    pageSize.value = nextPageSize;
}

function deleteSelected(): void {
    emit('batchDelete', [...selected.value]);
}

function mergeSelected(): void {
    if (!mergeTarget.value || selected.value.size < 2) {
        return;
    }

    emit('merge', { sourceIds: [...selected.value], targetId: mergeTarget.value });
}
</script>

<template>
    <div class="tag-manager">
        <div class="tag-manager__toolbar">
            <a-button :loading="importing" @click="pickImportFile">
                <template #icon>
                    <UploadOutlined />
                </template>
                {{ t('album.importTags') }}
            </a-button>
            <input
                ref="fileInput"
                type="file"
                accept="application/json,.json"
                hidden
                @change="onImportFile"
            >
            <a-button :href="exportHref">
                <template #icon>
                    <DownloadOutlined />
                </template>
                {{ t('album.exportTags') }}
            </a-button>
            <template v-if="tags.length > 0">
                <a-button :loading="busy === 'auto-color'" @click="emit('recolor', 'auto')">
                    {{ t('album.tagAutoColor') }}
                </a-button>
                <a-popconfirm
                    :title="t('album.tagRandomColorConfirm')"
                    :ok-text="t('common.confirm')"
                    :cancel-text="t('common.cancel')"
                    @confirm="emit('recolor', 'random')"
                >
                    <a-button :loading="busy === 'random-color'">
                        {{ t('album.tagRandomColor') }}
                    </a-button>
                </a-popconfirm>
                <a-popconfirm
                    v-if="allowDestructive"
                    :title="deleteAllHint ?? t('album.tagDeleteAllConfirm', { count: tags.length })"
                    :ok-text="t('common.delete')"
                    :cancel-text="t('common.cancel')"
                    @confirm="emit('deleteAll')"
                >
                    <a-button danger :loading="busy === 'delete-all'">
                        {{ t('album.tagDeleteAll') }}
                    </a-button>
                </a-popconfirm>
            </template>
        </div>

        <p v-if="!allowDestructive && readonlyHint" class="tag-manager__readonly">
            {{ readonlyHint }}
        </p>

        <section class="tag-manager__section px-surface">
            <h2 class="tag-manager__heading">
                {{ t('album.tagCreate') }}
            </h2>
            <div class="tag-manager__create">
                <a-input
                    v-model:value="newName"
                    :maxlength="MAX_TAG_NAME_LENGTH"
                    :placeholder="t('album.tagName')"
                    class="tag-manager__name"
                    @press-enter="submitCreate"
                />
                <a-color-picker
                    v-model:value="newColor"
                    value-format="hex"
                    allow-clear
                    :disabled-alpha="true"
                />
                <a-button
                    type="primary"
                    :loading="creating"
                    :disabled="newName.trim() === ''"
                    @click="submitCreate"
                >
                    <template #icon>
                        <PlusOutlined />
                    </template>
                    {{ t('album.tagCreate') }}
                </a-button>
            </div>
        </section>

        <section class="tag-manager__section px-surface">
            <div class="tag-manager__list-head">
                <h2 class="tag-manager__heading">
                    {{ t('album.tags') }}
                </h2>

                <div v-if="tags.length > 0 && allowDestructive" class="tag-manager__bulk">
                    <a-checkbox :checked="allSelected" :indeterminate="someSelected" @change="toggleAll">
                        {{ t('album.selectAllTags') }}
                    </a-checkbox>
                    <span v-if="selectedCount > 0" class="tag-manager__count">
                        {{ t('album.selectedTags', { count: selectedCount }) }}
                    </span>
                    <template v-if="selectedCount >= 2">
                        <a-select
                            v-model:value="mergeTarget"
                            :options="mergeOptions"
                            size="small"
                            class="tag-manager__target"
                            :placeholder="t('album.mergeTarget')"
                        />
                        <a-popconfirm
                            :title="t('album.mergeConfirm', { name: mergeTargetName })"
                            :ok-text="t('common.confirm')"
                            :cancel-text="t('common.cancel')"
                            @confirm="mergeSelected"
                        >
                            <a-button size="small" :loading="busy === 'merge'" :disabled="!mergeTarget">
                                {{ t('album.mergeTags') }}
                            </a-button>
                        </a-popconfirm>
                    </template>
                    <a-popconfirm
                        v-if="selectedCount > 0"
                        :title="t('album.batchDeleteTagsConfirm', { count: selectedCount })"
                        :ok-text="t('common.delete')"
                        :cancel-text="t('common.cancel')"
                        @confirm="deleteSelected"
                    >
                        <a-button size="small" danger :loading="busy === 'batch'">
                            {{ t('album.batchDeleteTags') }}
                        </a-button>
                    </a-popconfirm>
                </div>
            </div>

            <div v-if="tags.length > 0" class="tag-manager__filters">
                <a-input
                    v-model:value="query"
                    allow-clear
                    :placeholder="t('album.tagSearchPlaceholder')"
                    class="tag-manager__search"
                >
                    <template #prefix>
                        <SearchOutlined />
                    </template>
                </a-input>
                <a-select
                    v-model:value="sortMode"
                    :options="sortOptions"
                    class="tag-manager__sort"
                />
                <span class="tag-manager__count">
                    {{ t('album.tagFilteredCount', { shown: filteredTags.length, total: tags.length }) }}
                </span>
            </div>

            <p v-if="tags.length === 0" class="px-hint">
                {{ t('album.tagEmpty') }}
            </p>
            <p v-else-if="filteredTags.length === 0" class="px-hint">
                {{ t('album.tagSearchEmpty') }}
            </p>

            <ul v-else class="tag-manager__rows">
                <li
                    v-for="tag in visibleTags"
                    :key="tag.id"
                    class="tag-manager__row"
                    :class="{ 'tag-manager__row--readonly': !allowDestructive }"
                    :title="openHint"
                    @click="openTag(tag)"
                >
                    <a-checkbox
                        v-if="allowDestructive"
                        :checked="selected.has(tag.id)"
                        :aria-label="t('album.selectTag', { name: tag.name })"
                        @click.stop
                        @change="toggle(tag.id)"
                    />
                    <span class="tag-manager__swatch" :style="{ background: tag.color || 'transparent' }" />
                    <span class="tag-manager__name-wrap">
                        <span class="tag-manager__tag-name">{{ tag.name }}</span>
                    </span>
                    <a-tag>{{ tag.count }}</a-tag>
                    <a-button :aria-label="t('common.edit')" @click.stop="openEdit(tag)">
                        <template #icon>
                            <EditOutlined />
                        </template>
                    </a-button>
                    <a-popconfirm
                        v-if="allowDestructive"
                        :title="t('album.tagDeleteConfirm', { name: tag.name })"
                        :ok-text="t('common.delete')"
                        :cancel-text="t('common.cancel')"
                        @confirm="emit('remove', tag.id)"
                    >
                        <a-button danger :aria-label="t('common.delete')" :loading="busy === tag.id" @click.stop>
                            <template #icon>
                                <DeleteOutlined />
                            </template>
                        </a-button>
                    </a-popconfirm>
                </li>
            </ul>

            <a-pagination
                v-if="filteredTags.length > pageSize"
                class="tag-manager__pagination"
                size="small"
                :current="page"
                :page-size="pageSize"
                :total="filteredTags.length"
                :page-size-options="[50, 100, 200]"
                show-size-changer
                @change="onPageChange"
            />

            <p class="px-hint">
                {{ openHint }}
            </p>
        </section>

        <a-modal
            v-model:open="editOpen"
            :title="t('album.tagEditTitle')"
            :ok-text="t('common.save')"
            :cancel-text="t('common.cancel')"
            :ok-button-props="{ disabled: !editing?.name.trim() }"
            @ok="saveEdit"
        >
            <a-form v-if="editing" layout="vertical" class="tag-manager__edit">
                <a-form-item :label="t('album.tagName')">
                    <a-input v-model:value="editing.name" :maxlength="MAX_TAG_NAME_LENGTH" />
                </a-form-item>
                <a-form-item :label="t('album.tagColor')">
                    <a-color-picker v-model:value="editing.color" value-format="hex" allow-clear :disabled-alpha="true" />
                </a-form-item>
            </a-form>
        </a-modal>
    </div>
</template>

<style scoped>
.tag-manager {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.tag-manager__toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.tag-manager__readonly {
    margin: 0;
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.tag-manager__section {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
    padding: var(--px-space-4);
}

.tag-manager__heading {
    margin: 0;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-subtitle);
    font-weight: var(--px-font-weight-semibold);
}

.tag-manager__create {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.tag-manager__name {
    flex: 1;
    min-width: var(--px-layout-tile-min);
}

.tag-manager__list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.tag-manager__bulk {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.tag-manager__count {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.tag-manager__filters {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.tag-manager__search {
    flex: 1;
    min-width: var(--px-layout-tile-min);
}

.tag-manager__sort {
    flex: 0 0 auto;
    min-width: var(--px-space-16);
}

.tag-manager__pagination {
    align-self: flex-end;
}

.tag-manager__target {
    min-width: var(--px-space-16);
}

.tag-manager__rows {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
}

.tag-manager__row {
    display: grid;
    grid-template-columns: auto var(--px-space-4) minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--px-space-3);
    width: auto;
    margin-inline: calc(var(--px-space-2) * -1);
    padding: var(--px-space-1) var(--px-space-2);
    border-radius: var(--px-radius-sm);
    cursor: pointer;
    transition: background-color var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.tag-manager__row--readonly {
    grid-template-columns: var(--px-space-4) minmax(0, 1fr) auto auto;
}

.tag-manager__row:hover,
.tag-manager__row:focus-within {
    background: var(--px-color-bg-hover);
}

.tag-manager__row:active {
    background: var(--px-color-brand-soft);
}

.tag-manager__swatch {
    width: var(--px-space-4);
    height: var(--px-space-4);
    border: var(--px-border-width) solid var(--px-color-border-strong);
    border-radius: var(--px-radius-sm);
}

.tag-manager__name-wrap {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    min-width: 0;
}

.tag-manager__tag-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--px-color-text-primary);
    font-size: var(--px-font-size-body);
}

.tag-manager__edit {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}
</style>
