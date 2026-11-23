<script setup lang="ts">
import {
    BgColorsOutlined,
    CloudDownloadOutlined,
    CopyOutlined,
    DatabaseOutlined,
    FileImageOutlined,
    PictureOutlined,
    SyncOutlined,
    ThunderboltOutlined,
    TranslationOutlined,
} from '@antdv-next/icons';

const { t } = useI18n();
const route = useRoute();

const modules = computed(() => [
    { to: '/settings/appearance', icon: BgColorsOutlined, label: t('settings.moduleAppearance') },
    { to: '/settings/language', icon: TranslationOutlined, label: t('settings.moduleLanguage') },
    { to: '/settings/storage', icon: DatabaseOutlined, label: t('settings.moduleStorage') },
    { to: '/settings/thumbnails', icon: FileImageOutlined, label: t('settings.moduleMedia') },
    { to: '/settings/similarity', icon: CopyOutlined, label: t('settings.moduleSimilarity') },
    { to: '/settings/ai', icon: ThunderboltOutlined, label: t('settings.moduleAi') },
    { to: '/settings/pixiv', icon: PictureOutlined, label: t('settings.modulePixiv') },
    { to: '/settings/models', icon: CloudDownloadOutlined, label: t('settings.moduleModels') },
    { to: '/settings/update', icon: SyncOutlined, label: t('settings.moduleUpdate') },
]);

const activeModule = computed(() => {
    const matched = modules.value.find(item => route.path.startsWith(item.to));

    return matched?.to ?? '/settings/appearance';
});
</script>

<template>
    <AppSidebar
        :nav-label="t('a11y.settingsNav')"
        :title="t('nav.settings')"
        exit-to="/"
        :exit-label="t('nav.backToAlbums')"
    >
        <template #context>
            <p class="px-sidebar__context-title">
                {{ t('nav.settings') }}
            </p>
            <p class="px-sidebar__context-meta">
                {{ t('settings.subtitle') }}
            </p>
        </template>

        <template #nav>
            <NuxtLink
                v-for="item in modules"
                :key="item.to"
                :to="item.to"
                class="px-side__item"
                :title="item.label"
                :aria-current="activeModule === item.to ? 'page' : undefined"
                :class="{ 'px-side__item--active': activeModule === item.to }"
            >
                <component :is="item.icon" class="px-side__icon" aria-hidden="true" />
                <span class="px-side__label">{{ item.label }}</span>
            </NuxtLink>
        </template>

        <slot />
    </AppSidebar>
</template>
