import type { Settings } from '~~/server/settings/setting-schema';

const EMPTY_FORM: Settings = {
    schemaVersion: 1,
    albumsRoot: '',
    modelsRoot: '',
    storage: { default: 'local', partitionSize: 8192, partitionMode: 'sequence' },
    thumbnails: {
        dbMaxSizeMb: 2048,
        sizes: [256, 512, 1024],
        quality: 80,
        autoOptimize: true,
        cacheFirst: false,
    },
    ai: {
        labelMode: 'zero-shot',
        device: 'auto',
        localModelId: 'clip-vit-base-patch32',
        captioningModelId: 'vit-gpt2-image-captioning',
        external: { enabled: false, baseUrl: '', apiKey: '', model: '' },
        autoTag: false,
        downloadConcurrency: 4,
        autoResumeDownload: false,
    },
    similarity: { enabled: true, algorithm: 'phash', hammingThreshold: 8 },
    pixiv: {
        refreshToken: '',
        accountId: '',
        accountName: '',
        account: '',
        premium: false,
        networkMode: 'proxy',
        proxyUrl: 'socks5://127.0.0.1:10808',
        imageQuality: 'original',
        autoFetchSpeed: 'normal',
        autoFetchPaused: false,
    },
    ffmpeg: { enabled: true, path: 'auto' },
    theme: { preset: 'light', overrides: {} },
    i18n: { defaultLocale: 'zh-CN', locales: ['zh-CN', 'en-US'] },
};

/**
 * 设置模块子页共享的读取/保存状态：useState 让模块之间切换不重复拉取 setting.json。
 * 保存按模块提交（PATCH 只带本模块字段），saved/saving 由模块 key 区分。
 */
export function useSettings() {
    const api = useApi();
    type SettingsPatchInput = NonNullable<Parameters<typeof api.settings.$patch>[0]>['json'];

    const state = useState('settings-context', () => ({
        form: structuredClone(EMPTY_FORM),
        dataDir: '',
        loaded: false,
    }));
    const loading = ref(!state.value.loaded);
    const error = ref('');
    const saving = ref<string | null>(null);
    const saved = ref<string | null>(null);
    let savedTimer: ReturnType<typeof setTimeout> | null = null;

    async function load(force = false): Promise<void> {
        if (state.value.loaded && !force) {
            loading.value = false;

            return;
        }

        loading.value = true;
        error.value = '';

        try {
            const response = await api.settings.$get();
            const body: { data: Settings, meta: { dataDir: string } } = await response.json();

            state.value.form = structuredClone(body.data);
            state.value.dataDir = body.meta.dataDir;
            state.value.loaded = true;
        }
        catch (loadError) {
            error.value = errorMessage(loadError);
        }
        finally {
            loading.value = false;
        }
    }

    async function saveSection(key: string, patch: SettingsPatchInput): Promise<void> {
        saving.value = key;
        error.value = '';
        saved.value = null;

        try {
            const response = await api.settings.$patch({ json: patch });
            const body: { data: Settings } = await response.json();

            state.value.form = structuredClone(body.data);
            saved.value = key;

            if (savedTimer) {
                clearTimeout(savedTimer);
            }

            savedTimer = setTimeout(() => {
                saved.value = null;
            }, 2000);
        }
        catch (saveError) {
            error.value = errorMessage(saveError);
        }
        finally {
            saving.value = null;
        }
    }

    onScopeDispose(() => {
        if (savedTimer) {
            clearTimeout(savedTimer);
        }
    });

    return {
        form: computed(() => state.value.form),
        dataDir: computed(() => state.value.dataDir),
        loaded: computed(() => state.value.loaded),
        loading,
        error,
        saving,
        saved,
        load,
        saveSection,
    };
}
