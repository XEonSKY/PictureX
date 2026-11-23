<script setup lang="ts">
const { t } = useI18n();
const route = useRoute();

const navItems = useGlobalNav();

function isActive(to: string): boolean {
    return to === '/' ? route.path === '/' || route.path.startsWith('/albums') : route.path.startsWith(to);
}
</script>

<template>
    <AppSidebar :nav-label="t('a11y.mainNav')">
        <template #nav>
            <NuxtLink
                v-for="item in navItems"
                :key="item.key"
                :to="item.to"
                class="px-side__item"
                :title="item.label"
                :aria-current="isActive(item.to) ? 'page' : undefined"
                :class="{ 'px-side__item--active': isActive(item.to) }"
            >
                <component :is="item.icon" class="px-side__icon" aria-hidden="true" />
                <span class="px-side__label">{{ item.label }}</span>
            </NuxtLink>
        </template>

        <slot />

        <MobileTabBar :items="navItems" />
    </AppSidebar>
</template>
