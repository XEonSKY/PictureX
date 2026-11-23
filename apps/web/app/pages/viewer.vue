<script setup lang="ts">
import { CloseOutlined, PlusOutlined, TagOutlined } from '@antdv-next/icons';
import type { TagRecord } from '~~/server/album/album-store';
import type { ViewerFileInfo } from '~~/shared/viewer-bridge';
import { getViewerBridge } from '~~/shared/viewer-bridge';

definePageMeta({ layout: false });

const api = useApi();
const { t } = useI18n();
const route = useRoute();
const { formatBytes } = useFormat();

const bridge = getViewerBridge();
const fileRef = computed(() => typeof route.query.ref === 'string' ? route.query.ref : '');
const file = ref<ViewerFileInfo | null>(null);
const error = ref('');
const notice = ref('');
const loading = ref(true);
const mediaLoaded = ref(false);
const saving = ref(false);

const allTags = ref<TagRecord[]>([]);
const selectedTagIds = ref<string[]>([]);
const newTagName = ref('');
const creating = ref(false);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function showNotice(message: string): void {
    if (noticeTimer) {
        clearTimeout(noticeTimer);
    }
    notice.value = message;
    noticeTimer = setTimeout(() => {
        notice.value = '';
        noticeTimer = null;
    }, 1600);
}

onBeforeUnmount(() => {
    if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
    }
});

const tagOptions = computed(() => allTags.value.map(tag => ({
    label: tag.name,
    value: tag.id,
})));

const registerBody = (info: ViewerFileInfo, width?: number, height?: number) => ({
    sha256: info.sha256,
    kind: info.kind,
    mime: info.mime,
    filename: info.name,
    size: info.size,
    width: width ?? null,
    height: height ?? null,
});

async function loadTagList(): Promise<void> {
    const response = await api.viewer.tags.$get();
    const body = await response.json();

    allTags.value = (body.data ?? []) as TagRecord[];
}

async function openFile(): Promise<void> {
    loading.value = true;
    error.value = '';

    try {
        if (!bridge) {
            error.value = t('viewer.desktopOnly');

            return;
        }

        if (fileRef.value === '') {
            error.value = t('viewer.missingRef');

            return;
        }

        const info = await bridge.stat(fileRef.value);

        if (!info) {
            error.value = t('viewer.fileGone');

            return;
        }

        // 先渲染 pxfile 图像，标签/登记失败不阻断查看
        file.value = info;

        const [tagsResult, registerResult] = await Promise.all([
            loadTagList().then(() => 'ok' as const).catch(() => 'error' as const),
            api.viewer.media.$post({ json: registerBody(info) })
                .then(response => response.json())
                .catch(() => null),
        ]);

        if (tagsResult === 'error') {
            error.value = t('viewer.tagListFailed');
        }

        const data = registerResult?.data as { tagIds?: string[] } | null;

        selectedTagIds.value = Array.isArray(data?.tagIds) ? [...data.tagIds] : [];
    }
    catch (openError) {
        // 任何异常都必须收尾，否则 loading 永挂、v-if="loading" 挡住媒体区
        error.value = openError instanceof Error ? openError.message : String(openError);
    }
    finally {
        loading.value = false;
    }
}

async function saveTags(): Promise<void> {
    if (!file.value) {
        return;
    }

    saving.value = true;

    try {
        const response = await api.viewer.media[':sha256'].tags.$patch({
            param: { sha256: file.value.sha256 },
            json: { tagIds: selectedTagIds.value },
        });
        const body = await response.json();
        const data = body.data as { tagIds?: string[] } | null;

        selectedTagIds.value = Array.isArray(data?.tagIds) ? [...data.tagIds] : selectedTagIds.value;
        showNotice(t('viewer.tagsSaved'));
    }
    catch (saveError) {
        error.value = saveError instanceof Error ? saveError.message : String(saveError);
    }
    finally {
        saving.value = false;
    }
}

async function addTag(): Promise<void> {
    const name = newTagName.value.trim();

    if (name === '' || creating.value) {
        return;
    }

    creating.value = true;

    try {
        const response = await api.viewer.tags.$post({ json: { name } });
        const body = await response.json();
        const created = body.data as TagRecord;

        if (created && !allTags.value.some(tag => tag.id === created.id)) {
            allTags.value = [...allTags.value, created];
        }

        if (created && !selectedTagIds.value.includes(created.id)) {
            selectedTagIds.value = [...selectedTagIds.value, created.id];
            await saveTags();
        }

        newTagName.value = '';
    }
    catch (createError) {
        error.value = createError instanceof Error ? createError.message : String(createError);
    }
    finally {
        creating.value = false;
    }
}

function onImageLoad(event: Event): void {
    const image = event.target as HTMLImageElement | null;

    if (!image || !file.value) {
        return;
    }

    mediaLoaded.value = true;

    // 首次解码拿到尺寸后回填，图片记录更完整；upsert 保留原标签集合
    void api.viewer.media.$post({
        json: registerBody(file.value, image.naturalWidth, image.naturalHeight),
    }).catch(() => undefined);
}

function onVideoMetaLoad(event: Event): void {
    const video = event.target as HTMLVideoElement | null;

    if (!video || !file.value) {
        return;
    }

    mediaLoaded.value = true;

    void api.viewer.media.$post({
        json: registerBody(file.value, video.videoWidth, video.videoHeight),
    }).catch(() => undefined);
}

onMounted(() => {
    void openFile();
});
</script>

<template>
    <div class="viewer-app">
        <header class="viewer-app__bar">
            <div class="viewer-app__title">
                <span class="viewer-app__filename">{{ file?.name ?? t('viewer.loadingFile') }}</span>
                <span v-if="file" class="viewer-app__meta">{{ file.kind === 'video' ? t('viewer.kindVideo') : t('viewer.kindImage') }} · {{ formatBytes(file.size) }}</span>
            </div>
        </header>

        <main class="viewer-app__stage">
            <div v-if="loading" class="viewer-app__state">
                {{ t('viewer.loadingFile') }}
            </div>
            <div v-else-if="error && !file" class="viewer-app__state viewer-app__state--error">
                {{ error }}
            </div>
            <template v-else-if="file">
                <img
                    v-if="file.kind === 'image'"
                    :src="file.url"
                    :alt="file.name"
                    class="viewer-app__media"
                    :class="{ 'viewer-app__media--ready': mediaLoaded }"
                    @load="onImageLoad"
                    @error="mediaLoaded = false"
                >
                <video
                    v-else
                    :src="file.url"
                    class="viewer-app__media viewer-app__media--ready"
                    controls
                    autoplay
                    playsinline
                    @loadedmetadata="onVideoMetaLoad"
                />
            </template>
        </main>

        <footer class="viewer-app__panel">
            <div v-if="error && file" class="viewer-app__inline-error">
                {{ error }}<button type="button" class="viewer-app__inline-close" @click="error = ''">
                    <CloseOutlined />
                </button>
            </div>
            <div v-if="notice" class="viewer-app__inline-notice">
                {{ notice }}
            </div>
            <div class="viewer-app__tags">
                <span class="viewer-app__tags-icon"><TagOutlined /></span>
                <a-select
                    v-model:value="selectedTagIds"
                    mode="multiple"
                    :options="tagOptions"
                    :loading="loading || saving"
                    :disabled="!file"
                    :placeholder="t('viewer.tagPlaceholder')"
                    option-filter-prop="label"
                    class="viewer-app__tag-select"
                    @change="saveTags"
                />
                <a-input
                    v-model:value="newTagName"
                    :maxlength="60"
                    :placeholder="t('viewer.newTagName')"
                    class="viewer-app__new-tag"
                    :disabled="!file || creating"
                    @press-enter="addTag"
                >
                    <template #suffix>
                        <button type="button" class="viewer-app__new-tag-add" :disabled="!file || creating || newTagName.trim() === ''" :aria-label="t('viewer.addTag')" @click="addTag">
                            <PlusOutlined />
                        </button>
                    </template>
                </a-input>
            </div>
        </footer>
    </div>
</template>

<style scoped>
.viewer-app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--px-color-bg-surface);
    color: var(--px-color-text-primary);
    user-select: none;
}

.viewer-app__bar {
    display: flex;
    align-items: center;
    min-height: calc(var(--px-control-height) + var(--px-space-3));
    padding: var(--px-space-2) var(--px-space-4);
    border-bottom: var(--px-border-width) solid var(--px-color-border);
    background: var(--px-color-bg-surface);
}

.viewer-app__title {
    display: flex;
    align-items: baseline;
    gap: var(--px-space-3);
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
}

.viewer-app__filename {
    font-size: var(--px-font-size-subtitle);
    font-weight: var(--px-font-weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
}

.viewer-app__meta {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.viewer-app__stage {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--px-color-bg-sunken);
    overflow: hidden;
    padding: var(--px-space-3);
}

.viewer-app__media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    opacity: 0;
    transition: opacity var(--px-motion-duration-fast) var(--px-motion-easing-standard);
}

.viewer-app__media--ready {
    opacity: 1;
}

.viewer-app__state {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-subtitle);
}

.viewer-app__state--error {
    color: var(--px-color-danger);
}

.viewer-app__panel {
    padding: var(--px-space-3) var(--px-space-4);
    border-top: var(--px-border-width) solid var(--px-color-border);
    background: var(--px-color-bg-surface);
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
}

.viewer-app__tags {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
}

.viewer-app__tags-icon {
    color: var(--px-color-text-secondary);
    display: inline-flex;
}

.viewer-app__tag-select {
    flex: 1;
    min-width: 0;
}

.viewer-app__new-tag {
    width: 220px;
}

.viewer-app__new-tag-add {
    border: 0;
    background: transparent;
    color: var(--px-color-brand);
    cursor: pointer;
    display: inline-flex;
    padding: 0 var(--px-space-1);
}

.viewer-app__new-tag-add:disabled {
    color: var(--px-color-text-tertiary);
    cursor: default;
}

.viewer-app__inline-error,
.viewer-app__inline-notice {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    font-size: var(--px-font-size-caption);
}

.viewer-app__inline-error {
    color: var(--px-color-danger);
}

.viewer-app__inline-notice {
    color: var(--px-color-brand);
}

.viewer-app__inline-close {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
}
</style>
