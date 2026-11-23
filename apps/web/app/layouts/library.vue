<script setup lang="ts">
import { PictureOutlined, TagOutlined } from '@antdv-next/icons';

const { t } = useI18n();
const route = useRoute();
const navItems = useGlobalNav();

const modules = computed(() => [
    { to: '/library', icon: PictureOutlined, label: t('nav.library') },
    { to: '/library/tags', icon: TagOutlined, label: t('library.navTags') },
]);

function isActive(item: { to: string }): boolean {
    return route.path === item.to;
}
</script>

<template>
    <AppSidebar
        :nav-label="t('a11y.libraryNav')"
        :title="t('library.title')"
        exit-to="/"
        :exit-label="t('nav.backToAlbums')"
    >
        <template #context>
            <p class="px-sidebar__context-title">
                {{ t('library.title') }}
            </p>
            <p class="px-sidebar__context-meta">
                {{ t('library.contextMeta') }}
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

        <MobileTabBar :items="navItems" />
    </AppSidebar>
</template>
