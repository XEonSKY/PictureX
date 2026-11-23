<script setup lang="ts">
import {
    AppstoreOutlined,
    CopyOutlined,
    DeleteOutlined,
    PictureOutlined,
    SettingOutlined,
    SyncOutlined,
    TagOutlined,
} from '@antdv-next/icons';

const { t } = useI18n();
const route = useRoute();
const albumId = computed(() => String(route.params.id ?? ''));
const base = computed(() => `/albums/${albumId.value}`);
const { album, load } = useAlbumContext(albumId);

const modules = computed(() => [
    { to: base.value, path: base.value, icon: PictureOutlined, label: t('album.modulePhotos') },
    { to: `${base.value}/tags`, path: `${base.value}/tags`, icon: TagOutlined, label: t('album.moduleTags') },
    { to: `${base.value}/duplicates`, path: `${base.value}/duplicates`, icon: CopyOutlined, label: t('album.dedupTitle') },
    { to: `${base.value}/similar`, path: `${base.value}/similar`, icon: AppstoreOutlined, label: t('album.similarTitle') },
    { to: `${base.value}/trash`, path: `${base.value}/trash`, icon: DeleteOutlined, label: t('album.moduleTrash') },
    { to: `${base.value}/jobs`, path: `${base.value}/jobs`, icon: SyncOutlined, label: t('album.moduleJobs') },
    { to: `${base.value}/settings`, path: `${base.value}/settings`, icon: SettingOutlined, label: t('album.moduleSettings') },
]);

function isActive(item: { path: string }): boolean {
    return route.path === item.path;
}

let lastRefreshAt = 0;

/** 回到前台或窗口重新聚焦时刷新上下文，避免侧栏计数停在旧值 */
function autoRefresh(): void {
    const now = Date.now();

    if (now - lastRefreshAt < 5000) {
        return;
    }

    lastRefreshAt = now;
    void load(true);
}

function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
        autoRefresh();
    }
}

onMounted(() => {
    lastRefreshAt = Date.now();
    void load(true);

    window.addEventListener('focus', autoRefresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
    window.removeEventListener('focus', autoRefresh);
    document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
    <AppSidebar
        :nav-label="t('a11y.albumNav')"
        :title="album?.name"
        exit-to="/"
        :exit-label="t('nav.exitAlbum')"
    >
        <template #context>
            <p class="px-sidebar__context-title">
                {{ album?.name ?? '…' }}
            </p>
            <p class="px-sidebar__context-meta">
                {{ album ? t('album.statAssets', { count: album.assetCount }) : '' }}
            </p>
        </template>

        <template #nav>
            <NuxtLink
                v-for="item in modules"
                :key="item.to"
                :to="item.to"
                class="px-side__item"
                :title="item.label"
                :aria-current="isActive(item) ? 'page' : undefined"
                :class="{ 'px-side__item--active': isActive(item) }"
            >
                <component :is="item.icon" class="px-side__icon" aria-hidden="true" />
                <span class="px-side__label">{{ item.label }}</span>
            </NuxtLink>
        </template>

        <slot />
    </AppSidebar>
</template>
