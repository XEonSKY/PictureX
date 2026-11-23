<script setup lang="ts">
import { SaveOutlined } from '@antdv-next/icons';

withDefaults(defineProps<{
    title: string
    saving?: boolean
    saved?: boolean
    showSave?: boolean
}>(), {
    saving: false,
    saved: false,
    showSave: true,
});

defineEmits<{ save: [] }>();

const { t } = useI18n();
</script>

<template>
    <section class="px-section px-surface">
        <header class="px-section__head">
            <h2 class="px-section__title">
                {{ title }}
            </h2>
            <div class="px-section__actions">
                <a-tag v-if="saved" color="success">
                    {{ t('settings.sectionSaved') }}
                </a-tag>
                <slot name="actions" />
                <a-button v-if="showSave" type="primary" :loading="saving" @click="$emit('save')">
                    <template #icon>
                        <SaveOutlined />
                    </template>
                    {{ t('settings.saveSection') }}
                </a-button>
            </div>
        </header>

        <slot />
    </section>
</template>
