<script setup lang="ts">
import { THEMABLE_TOKENS } from '#shared/theme';

const { t } = useI18n();
const { preset, setPreset, setOverrides, resetOverrides, overrides, resolvedTokens } = useTheme();

const draft = ref<Record<string, string>>({ ...overrides.value });
const applied = ref(false);
const savingTheme = ref(false);
let appliedTimer: ReturnType<typeof setTimeout> | null = null;

const tokenLabels = computed<Record<string, string>>(() => ({
    'color-brand': t('theme.colorBrand'),
    'color-brand-hover': t('theme.colorBrand'),
    'color-success': t('theme.colorSuccess'),
    'color-warning': t('theme.colorWarning'),
    'color-danger': t('theme.colorDanger'),
    'color-bg-page': t('theme.colorBgPage'),
    'color-bg-surface': t('theme.colorBgSurface'),
    'color-text-primary': t('theme.colorTextPrimary'),
    'color-text-secondary': t('theme.colorTextSecondary'),
    'radius-sm': t('theme.radiusSm'),
    'radius-md': t('theme.radiusMd'),
    'font-size-body': t('theme.fontSizeBody'),
}));

const tokenEntries = computed(() => THEMABLE_TOKENS.map(token => ({
    token,
    label: tokenLabels.value[token] ?? token,
    placeholder: resolvedTokens.value[token] ?? '',
    color: token.startsWith('color-') ? resolvedTokens.value[token] ?? '' : '',
})));

function handlePreset(value: string | number): void {
    if (value === 'light' || value === 'dark') {
        void setPreset(value);
    }
}

function markApplied(): void {
    applied.value = true;

    if (appliedTimer) {
        clearTimeout(appliedTimer);
    }

    appliedTimer = setTimeout(() => {
        applied.value = false;
    }, 2000);
}

async function apply(): Promise<void> {
    savingTheme.value = true;

    try {
        await setOverrides(draft.value);
        markApplied();
    }
    finally {
        savingTheme.value = false;
    }
}

async function reset(): Promise<void> {
    savingTheme.value = true;

    try {
        await resetOverrides();
        draft.value = {};
        markApplied();
    }
    finally {
        savingTheme.value = false;
    }
}

watch(overrides, (value) => {
    draft.value = { ...value };
});

onScopeDispose(() => {
    if (appliedTimer) {
        clearTimeout(appliedTimer);
    }
});
</script>

<template>
    <SettingsSection
        :title="t('theme.title')"
        :saved="applied"
        :show-save="false"
    >
        <template #actions>
            <a-button type="primary" :loading="savingTheme" @click="apply">
                {{ t('theme.applyTheme') }}
            </a-button>
            <a-button @click="reset">
                {{ t('settings.resetOverrides') }}
            </a-button>
        </template>

        <div class="theme-studio">
            <div class="theme-studio__preset">
                <span class="px-field-label">{{ t('settings.themePreset') }}</span>
                <a-segmented
                    :value="preset"
                    :options="[
                        { value: 'light', label: t('theme.light') },
                        { value: 'dark', label: t('theme.dark') },
                    ]"
                    @change="handlePreset"
                />
            </div>

            <p class="px-hint">
                {{ t('settings.themeOverridesHint') }} {{ t('theme.applyHint') }}
            </p>

            <div class="theme-studio__grid">
                <label v-for="entry in tokenEntries" :key="entry.token" class="theme-token">
                    <span class="px-field-label">
                        {{ entry.label }}
                        <span class="theme-token__name">{{ entry.token }}</span>
                    </span>
                    <span class="theme-token__field">
                        <span
                            v-if="entry.color"
                            class="theme-token__swatch"
                            :style="{ background: entry.color }"
                        />
                        <a-input v-model:value="draft[entry.token]" :placeholder="entry.placeholder" />
                    </span>
                </label>
            </div>

            <div class="theme-preview px-surface">
                <span class="px-field-label">{{ t('theme.preview') }}</span>
                <div class="theme-preview__row">
                    <a-button type="primary">
                        {{ t('theme.previewCard') }}
                    </a-button>
                    <span class="theme-preview__text">{{ t('theme.previewSub') }}</span>
                </div>
            </div>
        </div>
    </SettingsSection>
</template>

<style scoped>
.theme-studio {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.theme-studio__preset {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.theme-studio__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(calc(var(--px-layout-card-min) * 1.2), 1fr));
    gap: var(--px-space-3);
}

.theme-token {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-1);
}

.theme-token__name {
    color: var(--px-color-text-tertiary);
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-caption);
}

.theme-token__field {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
}

.theme-token__swatch {
    flex: none;
    width: var(--px-control-height);
    height: var(--px-control-height);
    border: var(--px-border-width) solid var(--px-color-border-strong);
    border-radius: var(--px-radius-sm);
}

.theme-preview {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    padding: var(--px-space-4);
    background: var(--px-color-bg-page);
}

.theme-preview__row {
    display: flex;
    align-items: center;
    gap: var(--px-space-3);
    flex-wrap: wrap;
}

.theme-preview__text {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-body);
}
</style>
