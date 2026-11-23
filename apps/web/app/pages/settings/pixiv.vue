<script setup lang="ts">
import type { PixivStatusDto } from '~~/server/pixiv/types';
import type { PixivAutoFetchStatusDto } from '~~/shared/pixiv';
import {
    activeAutoFetch,
    autoFetchPercent,
    autoFetchStateKey,
    autoFetchTagColor,
} from '~/utils/pixiv-auto-fetch';

definePageMeta({
    layout: 'settings',
});

const { t } = useI18n();
const { formatTime } = useFormat();
const api = useApi();
const { form, saving, saved, saveSection, load: loadSettings } = useSettings();

const title = computed(() => t('settings.modulePixiv'));
const status = ref<PixivStatusDto | null>(null);
const refreshTokenInput = ref('');
const tokenBusy = ref(false);
const logoutBusy = ref(false);
const testBusy = ref(false);
const testResult = ref<'ok' | 'error' | ''>('');
const error = ref('');
const notice = ref('');

const fetchStatus = ref<PixivAutoFetchStatusDto | null>(null);
const fetchBusy = ref(false);
const pauseBusy = ref(false);
let fetchPollTimer: ReturnType<typeof setInterval> | null = null;

const networkOptions = computed(() => [
    { value: 'direct', label: t('settings.pixivNetworkDirect') },
    { value: 'proxy', label: t('settings.pixivNetworkProxy') },
]);

const qualityOptions = computed(() => [
    { value: 'original', label: t('settings.pixivQualityOriginal') },
    { value: 'large', label: t('settings.pixivQualityLarge') },
    { value: 'medium', label: t('settings.pixivQualityMedium') },
]);

const speedOptions = computed(() => [
    { value: 'slow', label: t('settings.pixivAutoFetchSpeedSlow') },
    { value: 'normal', label: t('settings.pixivAutoFetchSpeedNormal') },
    { value: 'fast', label: t('settings.pixivAutoFetchSpeedFast') },
]);

const activeFetch = computed(() => activeAutoFetch(fetchStatus.value));

const fetchPercent = computed(() => autoFetchPercent(activeFetch.value));

const fetchProgressStatus = computed<'normal' | 'active' | 'success' | 'exception'>(() => {
    if (fetchStatus.value?.running) {
        return 'active';
    }
    if (activeFetch.value?.status === 'failed') {
        return 'exception';
    }
    if (activeFetch.value?.status === 'completed') {
        return 'success';
    }

    return 'normal';
});

const fetchRetryAt = computed(() => {
    const value = activeFetch.value?.retryAt ?? '';

    if (value === '') {
        return '';
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? '' : formatTime(date);
});

const fetchStateText = computed(() => t(autoFetchStateKey(
    fetchStatus.value,
    activeFetch.value,
    'settings.pixivAutoFetchIdle',
)));

const fetchTagColor = computed(() => autoFetchTagColor(activeFetch.value));

const fetchErrorText = computed(() => {
    const code = activeFetch.value?.error;

    if (!code) {
        return '';
    }

    const messages: Record<string, string> = {
        pixiv_auth_required: t('settings.pixivAutoFetchErrorAuth'),
        pixiv_disabled: t('settings.pixivAutoFetchErrorDisabled'),
        album_unavailable: t('settings.pixivAutoFetchErrorMissing'),
        rate_limited: t('settings.pixivAutoFetchErrorRateLimited'),
        consecutive_failures: t('settings.pixivAutoFetchErrorConsecutive'),
        all_failed: t('settings.pixivAutoFetchErrorAllFailed'),
        paused: t('settings.pixivAutoFetchStateUserPaused'),
    };

    return messages[code] ?? code;
});

async function loadStatus(): Promise<void> {
    try {
        const response = await api.pixiv.status.$get();
        const body: { data: PixivStatusDto } = await response.json();

        status.value = body.data;
    }
    catch {
        status.value = null;
    }
}

async function loginWithToken(): Promise<void> {
    if (refreshTokenInput.value.trim() === '') {
        return;
    }

    tokenBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv.auth.token.$post({
            json: { refreshToken: refreshTokenInput.value.trim() },
        });
        const body: { data: PixivStatusDto } = await response.json();

        status.value = body.data;
        refreshTokenInput.value = '';
        notice.value = t('settings.pixivLoginDone');
        await loadSettings(true);
    }
    catch (loginError) {
        error.value = errorMessage(loginError);
    }
    finally {
        tokenBusy.value = false;
    }
}

async function logout(): Promise<void> {
    logoutBusy.value = true;
    error.value = '';
    notice.value = '';
    testResult.value = '';

    try {
        await api.pixiv.auth.$delete();
        await loadStatus();
        notice.value = t('settings.pixivLoggedOut');
        await loadSettings(true);
    }
    catch (logoutError) {
        error.value = errorMessage(logoutError);
    }
    finally {
        logoutBusy.value = false;
    }
}

async function testConnection(): Promise<void> {
    testBusy.value = true;
    testResult.value = '';
    error.value = '';

    try {
        await api.pixiv.test.$post();
        testResult.value = 'ok';
    }
    catch (testError) {
        testResult.value = 'error';
        error.value = errorMessage(testError);
    }
    finally {
        testBusy.value = false;
    }
}

async function loadFetchStatus(): Promise<void> {
    try {
        const response = await api.pixiv['auto-fetch'].$get();
        const body: { data: PixivAutoFetchStatusDto } = await response.json();

        fetchStatus.value = body.data;
    }
    catch {
        // 轮询失败不打断设置页，下一次自动重试
    }
}

/** 从后台切回时立即刷新补全状态，避免等待下一个轮询周期 */
function handleVisibility(): void {
    if (document.visibilityState === 'visible') {
        void loadFetchStatus();
    }
}

async function pauseFetch(): Promise<void> {
    pauseBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].pause.$post();
        const body: { data: PixivAutoFetchStatusDto } = await response.json();

        fetchStatus.value = body.data;
        notice.value = t('settings.pixivAutoFetchPausedNotice');
    }
    catch (pauseError) {
        error.value = errorMessage(pauseError);
    }
    finally {
        pauseBusy.value = false;
    }
}

async function resumeFetch(): Promise<void> {
    pauseBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].resume.$post();
        const body: { data: { queued: number, status: PixivAutoFetchStatusDto } } = await response.json();

        fetchStatus.value = body.data.status;
        notice.value = t('settings.pixivAutoFetchStarted', { count: body.data.queued });
    }
    catch (resumeError) {
        error.value = errorMessage(resumeError);
    }
    finally {
        pauseBusy.value = false;
    }
}

async function triggerFetch(): Promise<void> {
    fetchBusy.value = true;
    error.value = '';
    notice.value = '';

    try {
        const response = await api.pixiv['auto-fetch'].$post({ json: {} });
        const body: { data: { queued: number, status: PixivAutoFetchStatusDto } } = await response.json();

        fetchStatus.value = body.data.status;
        notice.value = t('settings.pixivAutoFetchStarted', { count: body.data.queued });
    }
    catch (triggerError) {
        error.value = errorMessage(triggerError);
    }
    finally {
        fetchBusy.value = false;
    }
}

function saveNetwork(): void {
    void saveSection('pixiv', {
        pixiv: {
            networkMode: form.value.pixiv.networkMode,
            proxyUrl: form.value.pixiv.proxyUrl,
            imageQuality: form.value.pixiv.imageQuality,
            autoFetchSpeed: form.value.pixiv.autoFetchSpeed,
        },
    });
}

useHead({
    title: () => `${title.value} · ${t('settings.title')} · PictureX`,
});

onMounted(() => {
    void loadStatus();
    void loadFetchStatus();
    fetchPollTimer = setInterval(() => {
        // 后台标签页暂停轮询；切回前台时立即补一次
        if (document.visibilityState === 'visible') {
            void loadFetchStatus();
        }
    }, 1500);
    document.addEventListener('visibilitychange', handleVisibility);
});

onBeforeUnmount(() => {
    if (fetchPollTimer) {
        clearInterval(fetchPollTimer);
        fetchPollTimer = null;
    }
    document.removeEventListener('visibilitychange', handleVisibility);
});
</script>

<template>
    <SettingsModule :title="title" :subtitle="t('settings.subtitlePixiv')">
        <a-alert v-if="notice" type="success" show-icon closable :message="notice" @close="notice = ''" />
        <a-alert v-if="error" type="error" show-icon closable :message="error" @close="error = ''" />

        <SettingsSection :title="t('settings.pixivAccountTitle')" :show-save="false">
            <div class="pixiv-account">
                <p v-if="status?.configured" class="pixiv-account__status">
                    <strong>{{ status.accountName || status.accountId }}</strong>
                    <span v-if="status.account">@{{ status.account }}</span>
                    <a-tag v-if="status.premium" color="gold">
                        {{ t('settings.pixivPremium') }}
                    </a-tag>
                </p>
                <p v-else class="px-hint">
                    {{ t('settings.pixivNotLoggedIn') }}
                </p>

                <div v-if="status?.configured" class="pixiv-account__actions">
                    <a-button danger :loading="logoutBusy" @click="logout">
                        {{ t('settings.pixivLogout') }}
                    </a-button>
                </div>

                <div class="pixiv-account__field">
                    <a-input-password v-model:value="refreshTokenInput" :placeholder="t('settings.pixivTokenPlaceholder')" allow-clear />
                    <a-button :loading="tokenBusy" @click="loginWithToken">
                        {{ t('settings.pixivTokenLogin') }}
                    </a-button>
                </div>
                <p class="px-hint">
                    {{ t('settings.pixivTokenHint') }}
                </p>
            </div>
        </SettingsSection>

        <SettingsSection
            :title="t('settings.pixivNetworkTitle')"
            :saving="saving === 'pixiv'"
            :saved="saved === 'pixiv'"
            @save="saveNetwork"
        >
            <a-form layout="vertical" class="px-form-grid">
                <a-form-item :label="t('settings.pixivNetworkMode')">
                    <a-select v-model:value="form.pixiv.networkMode" :options="networkOptions" />
                </a-form-item>
                <a-form-item v-if="form.pixiv.networkMode === 'proxy'" :label="t('settings.pixivProxyUrl')">
                    <a-input v-model:value="form.pixiv.proxyUrl" placeholder="socks5://127.0.0.1:10808 / http://127.0.0.1:10809" />
                </a-form-item>
                <a-form-item :label="t('settings.pixivImageQuality')">
                    <a-select v-model:value="form.pixiv.imageQuality" :options="qualityOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.pixivAutoFetchSpeed')">
                    <a-select v-model:value="form.pixiv.autoFetchSpeed" :options="speedOptions" />
                </a-form-item>
                <a-form-item :label="t('settings.pixivTest')">
                    <a-button :loading="testBusy" :disabled="!status?.configured" @click="testConnection">
                        {{ t('settings.pixivTestRun') }}
                    </a-button>
                    <a-tag v-if="testResult === 'ok'" color="success">
                        {{ t('settings.pixivTestOk') }}
                    </a-tag>
                    <a-tag v-else-if="testResult === 'error'" color="error">
                        {{ t('settings.pixivTestFailed') }}
                    </a-tag>
                </a-form-item>
            </a-form>
            <p class="px-hint">
                {{ t('settings.pixivNetworkHint') }}
            </p>
            <p class="px-hint">
                {{ t('settings.pixivAutoFetchSpeedHint') }}
            </p>
        </SettingsSection>

        <SettingsSection :title="t('settings.pixivAutoFetchTitle')" :show-save="false">
            <div class="pixiv-fetch">
                <div class="pixiv-fetch__head">
                    <a-tag :color="fetchTagColor">
                        {{ fetchStateText }}
                    </a-tag>
                    <span v-if="activeFetch" class="pixiv-fetch__album">{{ activeFetch.albumName }}</span>
                    <span v-if="activeFetch && activeFetch.total > 0" class="pixiv-fetch__count">
                        {{ t('settings.pixivAutoFetchProgress', { processed: activeFetch.processed, total: activeFetch.total }) }}
                    </span>
                    <a-button
                        v-if="!fetchStatus?.paused"
                        size="small"
                        :loading="pauseBusy"
                        @click="pauseFetch"
                    >
                        {{ t('settings.pixivAutoFetchPause') }}
                    </a-button>
                    <a-button
                        v-else
                        size="small"
                        type="primary"
                        :loading="pauseBusy"
                        @click="resumeFetch"
                    >
                        {{ t('settings.pixivAutoFetchResume') }}
                    </a-button>
                    <a-button size="small" :loading="fetchBusy" :disabled="fetchStatus?.paused" @click="triggerFetch">
                        {{ t('settings.pixivAutoFetchStart') }}
                    </a-button>
                </div>

                <p v-if="fetchStatus?.paused" class="px-hint">
                    {{ t('settings.pixivAutoFetchPausedHint') }}
                </p>

                <a-progress :percent="fetchPercent" :status="fetchProgressStatus" size="small" />

                <div v-if="activeFetch" class="pixiv-fetch__stats">
                    <span>{{ t('settings.pixivAutoFetchNetwork', { count: activeFetch.network }) }}</span>
                    <span>{{ t('settings.pixivAutoFetchBackfilled', { count: activeFetch.backfilled }) }}</span>
                    <span>{{ t('settings.pixivAutoFetchFresh', { count: activeFetch.fresh }) }}</span>
                    <span>{{ t('settings.pixivAutoFetchDeleted', { count: activeFetch.deleted }) }}</span>
                    <span>{{ t('settings.pixivAutoFetchFailed', { count: activeFetch.failed }) }}</span>
                </div>

                <p v-if="(fetchStatus?.queued.length ?? 0) > 0" class="px-hint">
                    {{ t('settings.pixivAutoFetchQueued', { count: fetchStatus?.queued.length ?? 0 }) }}
                </p>
                <p v-if="fetchRetryAt" class="px-hint">
                    {{ t('settings.pixivAutoFetchRetryAt', { time: fetchRetryAt }) }}
                </p>
                <p v-if="fetchErrorText" class="px-hint">
                    {{ fetchErrorText }}
                </p>
                <p v-if="!activeFetch" class="px-hint">
                    {{ t('settings.pixivAutoFetchIdle') }}
                </p>
            </div>
        </SettingsSection>
    </SettingsModule>
</template>

<style scoped>
.pixiv-account {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.pixiv-account__status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--px-space-2);
}

.pixiv-account__actions,
.pixiv-account__field {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-2);
}

.pixiv-account__field :deep(.ant-input-affix-wrapper),
.pixiv-account__field :deep(.ant-input) {
    flex: 1;
}

.pixiv-fetch {
    display: flex;
    flex-direction: column;
    gap: var(--px-space-3);
}

.pixiv-fetch__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-space-2);
}

.pixiv-fetch__album {
    color: var(--px-color-text-primary);
    font-weight: var(--px-font-weight-medium);
}

.pixiv-fetch__count,
.pixiv-fetch__stats {
    color: var(--px-color-text-tertiary);
    font-size: var(--px-font-size-caption);
}

.pixiv-fetch__stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-space-3);
}
</style>
