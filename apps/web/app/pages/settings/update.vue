<script setup lang="ts">
import { SyncOutlined } from '@antdv-next/icons';
import { getDesktopBridge } from '~~/shared/desktop-bridge';
import type {
    DesktopBridge,
    DesktopInfo,
    DesktopUpdateStatus,
} from '~~/shared/desktop-bridge';

definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { formatDateTime } = useFormat();
const runtimeConfig = useRuntimeConfig();

const title = computed(() => t('settings.moduleUpdate'));
const desktop = ref<DesktopBridge | null>(null);
const info = ref<DesktopInfo | null>(null);
const status = ref<DesktopUpdateStatus | null>(null);
const busy = ref(false);
const error = ref('');
let subscription: number | null = null;

const fallbackVersion = String(runtimeConfig.public.version ?? '0.0.0');
const version = computed(() => info.value?.version ?? status.value?.currentVersion ?? fallbackVersion);
const channel = computed(() => info.value?.channel ?? status.value?.channel ?? 'latest');
const channelLabel = computed(() => (channel.value === 'pre'
    ? t('settings.updateChannelPre')
    : t('settings.updateChannelLatest')));

const phase = computed(() => status.value?.phase ?? 'idle');
const percent = computed(() => status.value?.percent ?? null);
const checking = computed(() => busy.value || phase.value === 'checking');
const canCheck = computed(() => !checking.value
  && phase.value !== 'downloading'
  && phase.value !== 'ready');

const stateText = computed(() => {
    const latest = status.value?.version ?? '';

    if (phase.value === 'checking') {
        return t('settings.updateChecking');
    }
    if (phase.value === 'downloading') {
        return t('settings.updateDownloading', { version: latest });
    }
    if (phase.value === 'up-to-date') {
        return t('settings.updateUpToDate', { version: latest || version.value });
    }
    if (phase.value === 'ready') {
        return t('settings.updateReady', { version: latest });
    }
    if (phase.value === 'error') {
        return t('settings.updateError', { message: status.value?.error ?? '' });
    }

    return t('settings.updateIdle');
});

const checkedAt = computed(() => {
    const value = status.value?.checkedAt ?? '';

    if (value === '') {
        return '';
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '' : formatDateTime(value);
});

function applyStatus(next: DesktopUpdateStatus | null): void {
    if (next) {
        status.value = next;
    }
}

async function loadDesktop(bridge: DesktopBridge): Promise<void> {
    try {
        info.value = await bridge.info();

        if (info.value?.packaged === false) {
            status.value = {
                phase: 'unsupported',
                currentVersion: info.value.version,
                channel: info.value.channel,
                supported: false,
                version: null,
                percent: null,
                checkedAt: null,
                error: null,
            };

            return;
        }

        applyStatus(await bridge.updateStatus());
    }
    catch (loadError) {
        error.value = loadError instanceof Error ? loadError.message : String(loadError);
    }
}

async function check(): Promise<void> {
    const bridge = desktop.value;

    if (!bridge) {
        return;
    }

    busy.value = true;
    error.value = '';

    try {
        applyStatus(await bridge.checkForUpdates());
    }
    catch (checkError) {
        error.value = checkError instanceof Error ? checkError.message : String(checkError);
    }
    finally {
        busy.value = false;
    }
}

async function install(): Promise<void> {
    const bridge = desktop.value;

    if (!bridge) {
        return;
    }

    try {
        await bridge.installUpdate();
    }
    catch (installError) {
        error.value = installError instanceof Error ? installError.message : String(installError);
    }
}

onMounted(() => {
    const bridge = getDesktopBridge();

    if (!bridge) {
        return;
    }

    desktop.value = bridge;
    subscription = bridge.subscribeUpdateStatus(applyStatus);
    void loadDesktop(bridge);
});

onBeforeUnmount(() => {
    if (desktop.value && subscription !== null) {
        desktop.value.unsubscribeUpdateStatus(subscription);
    }
    subscription = null;
});

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitleUpdate')">
        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />

        <SettingsSection :title="t('settings.updateTitle')" :show-save="false">
            <dl class="update-meta">
                <div class="update-meta__row">
                    <dt>{{ t('settings.updateVersion') }}</dt>
                    <dd class="update-meta__value">
                        v{{ version }}
                    </dd>
                </div>
                <div class="update-meta__row">
                    <dt>{{ t('settings.updateChannel') }}</dt>
                    <dd>
                        <a-tag :color="channel === 'pre' ? 'warning' : 'processing'">
                            {{ channelLabel }}
                        </a-tag>
                    </dd>
                </div>
                <div v-if="info" class="update-meta__row">
                    <dt>{{ t('settings.updatePlatform') }}</dt>
                    <dd class="update-meta__value">
                        {{ info.platform }}
                    </dd>
                </div>
            </dl>

            <a-alert v-if="!desktop" type="info" show-icon :message="t('settings.updateWebHint')" />
            <template v-else>
                <a-alert
                    v-if="phase === 'unsupported'"
                    type="info"
                    show-icon
                    :message="t('settings.updateDevHint')"
                />
                <template v-else>
                    <a-progress
                        v-if="phase === 'downloading'"
                        :percent="percent ?? 0"
                        :show-info="percent !== null"
                    />
                    <p class="px-hint">
                        {{ stateText }}
                    </p>
                </template>

                <div class="update-actions">
                    <a-button type="primary" :loading="checking" :disabled="!canCheck" @click="check">
                        <template #icon>
                            <SyncOutlined />
                        </template>
                        {{ t('settings.updateCheck') }}
                    </a-button>
                    <a-button v-if="phase === 'ready'" type="primary" @click="install">
                        {{ t('settings.updateInstall') }}
                    </a-button>
                </div>

                <p v-if="checkedAt" class="px-hint">
                    {{ t('settings.updateCheckedAt', { time: checkedAt }) }}
                </p>
                <p class="px-hint">
                    {{ t('settings.updateDownloadHint') }}
                </p>
            </template>
        </SettingsSection>
    </SettingsModule>
</template>

<style scoped>
.update-meta {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-2);
    margin: 0 0 var(--px-space-4);
}

.update-meta__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-space-3);
    min-height: var(--px-control-height-sm);
}

.update-meta__row dt {
    color: var(--px-color-text-secondary);
    font-size: var(--px-font-size-caption);
}

.update-meta__row dd {
    margin: 0;
}

.update-meta__value {
    color: var(--px-color-text-primary);
    font-family: var(--px-font-family-mono);
    font-size: var(--px-font-size-caption);
}

.update-actions {
    display: flex;
    align-items: center;
    gap: var(--px-space-2);
    flex-wrap: wrap;
    margin-top: var(--px-space-3);
}
</style>
