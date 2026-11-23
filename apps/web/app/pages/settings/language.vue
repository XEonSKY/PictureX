<script setup lang="ts">
import type { LocaleCode } from '../../composables/useLocale';

definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { form } = useSettings();
const { locale, locales, switchLocale } = useLocale();

const title = computed(() => t('settings.moduleLanguage'));
const savingLocale = ref(false);
const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const localeOptions = computed(() => locales.value.map(item => ({
    value: item.code,
    label: item.name ?? item.code,
})));

async function changeLocale(value: unknown): Promise<void> {
    const code = String(value);

    if ((code !== 'zh-CN' && code !== 'en-US') || code === locale.value) {
        return;
    }

    savingLocale.value = true;

    try {
        // useLocale 负责 cookie + localStorage + PATCH /settings，这里只同步表单显示值
        await switchLocale(code as LocaleCode);
        form.value.i18n.defaultLocale = code as LocaleCode;
        saved.value = true;

        if (savedTimer) {
            clearTimeout(savedTimer);
        }

        savedTimer = setTimeout(() => {
            saved.value = false;
        }, 2000);
    }
    finally {
        savingLocale.value = false;
    }
}

onScopeDispose(() => {
    if (savedTimer) {
        clearTimeout(savedTimer);
    }
});

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleLanguage')">
        <SettingsSection
            :title="t('settings.defaultLocale')"
            :saving="savingLocale"
            :saved="saved"
            :show-save="false"
        >
            <a-form layout="vertical" class="px-form-grid px-form-grid--single">
                <a-form-item :label="t('settings.language')">
                    <a-select
                        :value="form.i18n.defaultLocale"
                        :options="localeOptions"
                        @change="changeLocale"
                    />
                </a-form-item>
                <a-form-item :label="t('common.status')">
                    <p class="px-hint">
                        {{ t('settings.languageHint') }}
                    </p>
                </a-form-item>
            </a-form>
        </SettingsSection>
    </SettingsModule>
</template>
