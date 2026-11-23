<script setup lang="ts">
import { ReloadOutlined } from '@antdv-next/icons';

defineProps<{ title: string, subtitle?: string }>();

const { t } = useI18n();
const { loading, loaded, error, load } = useSettings();

onMounted(() => {
    void load();
});
</script>

<template>
    <div class="px-page">
        <header class="px-page-header">
            <div class="px-page-header__main">
                <p class="px-page-header__eyebrow">
                    {{ t('nav.settings') }}
                </p>
                <h1 class="px-page-title">
                    {{ title }}
                </h1>
                <p class="px-page-subtitle">
                    {{ subtitle }}
                </p>
            </div>
            <a-button :aria-label="t('common.refresh')" @click="load(true)">
                <template #icon>
                    <ReloadOutlined />
                </template>
            </a-button>
        </header>

        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />

        <div v-if="loading || !loaded" class="px-loading">
            <a-spin />
        </div>

        <div v-else class="settings-module">
            <slot />
        </div>
    </div>
</template>

<style scoped>
.settings-module {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-4);
    max-width: var(--px-layout-content-narrow);
}
</style>
