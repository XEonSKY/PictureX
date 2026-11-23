<script setup lang="ts">
import { ArrowUpOutlined, FolderOpenOutlined, ReloadOutlined } from '@antdv-next/icons';

interface DirectoryEntry {
    name: string
    path: string
    isAlbum: boolean
    hidden: boolean
}

interface Listing {
    path: string
    parent: string | null
    isAlbum: boolean
    entries: DirectoryEntry[]
}

interface RootEntry {
    path: string
    name: string
    isAlbum: boolean
}

const props = defineProps<{
    open: boolean
    mode: 'directory' | 'album'
    initialPath?: string
}>();

const emit = defineEmits<{
    'update:open': [value: boolean]
    'select': [path: string]
}>();

const { t } = useI18n();
const api = useApi();

const listing = ref<Listing | null>(null);
const roots = ref<RootEntry[]>([]);
const loading = ref(false);
const error = ref('');
const manual = ref('');
const showHidden = ref(false);

const LAST_PATH_KEY = 'picturex.pickerPath';

const title = computed(() => (props.mode === 'album' ? t('picker.titleAlbum') : t('picker.title')));

const canChoose = computed(() => {
    if (!listing.value || loading.value) {
        return false;
    }

    return props.mode === 'directory' || listing.value.isAlbum;
});

const crumbs = computed(() => {
    const path = listing.value?.path ?? '';

    if (path === '') {
        return [];
    }

    const parts = path.split(/[\\/]+/u).filter(Boolean);
    const items: { label: string, path: string }[] = [];

    if (/^[a-zA-Z]:/u.test(path)) {
        const drive = parts[0] ?? '';
        let acc = `${drive}\\`;

        items.push({ label: drive, path: acc });

        for (const part of parts.slice(1)) {
            acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`;
            items.push({ label: part, path: acc });
        }

        return items;
    }

    let acc = '';

    for (const part of parts) {
        acc += `/${part}`;
        items.push({ label: part, path: acc });
    }

    return items;
});

async function load(path: string): Promise<void> {
    loading.value = true;
    error.value = '';

    try {
        const response = await api.fs.list.$get({
            query: {
                path,
                ...(showHidden.value ? { showHidden: 'true' as const } : {}),
            },
        });
        const body = await response.json();

        listing.value = body.data;
        manual.value = body.data.path;

        if (import.meta.client) {
            localStorage.setItem(LAST_PATH_KEY, body.data.path);
        }
    }
    catch (loadError) {
        error.value = errorMessage(loadError);
    }
    finally {
        loading.value = false;
    }
}

async function bootstrap(): Promise<void> {
    try {
        const response = await api.fs.roots.$get();
        const body = await response.json();

        roots.value = body.data;
    }
    catch (rootsError) {
        error.value = errorMessage(rootsError);
    }

    const remembered = import.meta.client ? localStorage.getItem(LAST_PATH_KEY) : null;
    const start = props.initialPath || remembered || roots.value[0]?.path;

    if (start) {
        await load(start);
    }

    // 上次记住的目录可能已被删除，回退到第一个常用位置
    if (!listing.value) {
        const fallback = roots.value[0]?.path;

        if (fallback && fallback !== start) {
            await load(fallback);
        }
    }
}

function close(): void {
    emit('update:open', false);
}

function choose(): void {
    if (!canChoose.value || !listing.value) {
        return;
    }

    emit('select', listing.value.path);
    close();
}

function goManual(): void {
    if (manual.value.trim() !== '') {
        void load(manual.value.trim());
    }
}

function goUp(): void {
    if (listing.value?.parent) {
        void load(listing.value.parent);
    }
}

function toggleHidden(value: boolean): void {
    showHidden.value = value;

    if (listing.value) {
        void load(listing.value.path);
    }
}

watch(() => props.open, (value) => {
    if (value) {
        void bootstrap();
    }
});
</script>

<template>
    <a-modal
        :open="props.open"
        :title="title"
        :width="760"
        :footer="null"
        destroy-on-hidden
        @update:open="(value: boolean) => emit('update:open', value)"
    >
        <div class="picker">
            <div class="picker__places">
                <span class="picker__label">{{ t('picker.places') }}</span>
                <a-tag
                    v-for="root in roots"
                    :key="root.path"
                    class="picker__place"
                    @click="load(root.path)"
                >
                    {{ root.name }}
                </a-tag>
            </div>

            <div class="picker__bar">
                <a-button
                    size="small"
                    :disabled="!listing?.parent"
                    :aria-label="t('picker.up')"
                    @click="goUp"
                >
                    <template #icon>
                        <ArrowUpOutlined />
                    </template>
                </a-button>

                <nav class="picker__crumbs" :aria-label="t('picker.path')">
                    <button
                        v-for="crumb in crumbs"
                        :key="crumb.path"
                        type="button"
                        class="picker__crumb"
                        @click="load(crumb.path)"
                    >
                        {{ crumb.label }}
                    </button>
                </nav>

                <a-checkbox :checked="showHidden" @change="(event: { target: { checked: boolean } }) => toggleHidden(event.target.checked)">
                    {{ t('picker.showHidden') }}
                </a-checkbox>

                <a-button size="small" :aria-label="t('common.refresh')" @click="listing && load(listing.path)">
                    <template #icon>
                        <ReloadOutlined />
                    </template>
                </a-button>
            </div>

            <div class="picker__list">
                <div v-if="loading" class="picker__loading">
                    <a-spin />
                </div>
                <p v-else-if="(listing?.entries.length ?? 0) === 0" class="picker__empty">
                    {{ t('picker.empty') }}
                </p>
                <button
                    v-for="entry in listing?.entries ?? []"
                    v-else
                    :key="entry.path"
                    type="button"
                    class="picker__row"
                    @click="load(entry.path)"
                >
                    <FolderOpenOutlined class="picker__icon" />
                    <span class="picker__name">{{ entry.name }}</span>
                    <a-tag v-if="entry.isAlbum" color="processing">
                        {{ t('picker.albumTag') }}
                    </a-tag>
                </button>
            </div>

            <a-alert v-if="error" type="error" show-icon :message="error" />

            <div class="picker__manual">
                <span class="picker__label">{{ t('picker.path') }}</span>
                <a-input
                    v-model:value="manual"
                    :maxlength="4096"
                    class="px-selectable"
                    @press-enter="goManual"
                />
                <a-button @click="goManual">
                    {{ t('picker.go') }}
                </a-button>
            </div>

            <p v-if="props.mode === 'album' && listing && !listing.isAlbum" class="px-hint">
                {{ t('picker.notAlbum') }}
            </p>

            <div class="picker__actions">
                <a-button @click="close">
                    {{ t('common.cancel') }}
                </a-button>
                <a-button type="primary" :disabled="!canChoose" @click="choose">
                    {{ props.mode === 'album' ? t('picker.selectAlbum') : t('picker.select') }}
                </a-button>
            </div>
        </div>
    </a-modal>
</template>

<style scoped>
.picker {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.picker__places,
.picker__bar,
.picker__manual,
.picker__actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
}

.picker__places {
    padding-bottom: var(--px-space-2);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
}

.picker__place {
    cursor: pointer;
}

.picker__label {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.picker__crumbs {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--px-space-1);
    min-width: 0;
    overflow-x: auto;
}

.picker__crumb {
    flex: none;
    padding: 0 var(--px-space-1);
    border: none;
    border-radius: var(--px-radius-sm);
    background: transparent;
    color: var(--px-color-text-secondary);
    font-family: inherit;
    font-size: var(--px-font-size-body);
    cursor: pointer;
}

.picker__crumb:hover {
    color: var(--px-color-brand);
}

.picker__crumb:not(:last-child)::after {
    content: '/';
    margin-left: var(--px-space-1);
    color: var(--px-color-text-fourth);
}

.picker__list {
    display: flex;
    flex-direction: column;
    min-height: calc(var(--px-control-height) * 6);
    max-height: 42vh;
    overflow-y: auto;
    border: var(--px-border-width) solid var(--px-color-border);
    border-radius: var(--px-radius-sm);
}

.picker__row {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    min-height: var(--px-control-height);
    padding: 0 var(--px-space-3);
    border: none;
    border-bottom: var(--px-border-width) solid var(--px-color-border);
    background: transparent;
    color: var(--px-color-text-primary);
    font-family: inherit;
    font-size: var(--px-font-size-body);
    text-align: left;
    cursor: pointer;
}

.picker__row:last-child {
    border-bottom: none;
}

.picker__row:hover {
    background: var(--px-color-bg-hover);
}

.picker__icon {
    color: var(--px-color-brand);
    font-size: var(--px-font-size-subtitle);
}

.picker__name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.picker__loading,
.picker__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(var(--px-control-height) * 4);
    margin: 0;
    color: var(--px-color-text-tertiary);
}

.picker__manual :deep(.ant-input) {
    flex: 1;
    min-width: calc(var(--px-layout-tile-min) / 2);
}

.picker__actions {
    justify-content: flex-end;
    padding-top: var(--px-space-2);
    border-top: var(--px-border-width) solid var(--px-color-border);
}
</style>
