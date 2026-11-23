<script setup lang="ts">
import type { Component } from 'vue';

export interface TabBarItem {
    key: string
    to: string
    icon: Component
    /** 当前项用填充图标，视觉上更接近原生底栏 */
    activeIcon?: Component
    label: string
}

const props = defineProps<{ items: TabBarItem[] }>();

const { t } = useI18n();
const route = useRoute();

function isActive(to: string): boolean {
    return to === '/' ? route.path === '/' || route.path.startsWith('/albums') : route.path.startsWith(to);
}

function iconFor(item: TabBarItem): Component {
    return isActive(item.to) && item.activeIcon ? item.activeIcon : item.icon;
}
</script>

<template>
    <nav class="px-tabbar" :aria-label="t('a11y.bottomNav')">
        <NuxtLink
            v-for="item in props.items"
            :key="item.key"
            :to="item.to"
            class="px-tabbar__item"
            :class="{ 'px-tabbar__item--active': isActive(item.to) }"
            :aria-current="isActive(item.to) ? 'page' : undefined"
        >
            <span class="px-tabbar__icon-wrap">
                <component :is="iconFor(item)" class="px-tabbar__icon" aria-hidden="true" />
            </span>
            <span class="px-tabbar__label">{{ item.label }}</span>
        </NuxtLink>
    </nav>
</template>
