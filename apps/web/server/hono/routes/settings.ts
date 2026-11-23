import { Hono } from 'hono';
import { resolveInferencePlan } from '../../ai/device';
import { modelDownloader, resetModelDownloader } from '../../model/model-downloader';
import { getSettings, updateSettings } from '../../settings/setting-store';
import {
    settingsPatchSchema,
    themePatchSchema,
    type Settings,
    type SettingsPatch,
} from '../../settings/setting-schema';
import { describeDataDirectories } from '../../utils/data-dir';
import type { AppEnv } from '../env';
import { ApiError } from '../problem';
import { validateJson } from '../validation';

/** 前端不需要看到明文密钥；提交这个掩码表示“保持不变” */
const API_KEY_MASK = '********';
/** 代理 URL 里的 user/password 掩码占位；提交带它的值表示沿用已存凭据 */
const URL_CRED_MASK = '***';

/** 掩码 URL 中的 userinfo（user:pass），无凭据的 URL 原样返回 */
function maskUrlCredentials(value: string): string {
    if (value === '') {
        return value;
    }

    try {
        const url = new URL(value);

        if (!url.username && !url.password) {
            return value;
        }

        if (url.username) {
            url.username = URL_CRED_MASK;
        }
        if (url.password) {
            url.password = URL_CRED_MASK;
        }

        return url.toString();
    }
    catch {
        return value;
    }
}

/**
 * 解析提交的 proxyUrl：
 * - 带掩码 → 用已存凭据回填（保留用户改过的 host/port/scheme）
 * - 掩码但已存无凭据 → 返回 undefined 表示不改该字段
 * - 无掩码 → 原样写回（用户填了真凭据或本就无凭据）
 */
function resolveProxyPatch(submitted: string, current: string): string | undefined {
    if (submitted === '') {
        return '';
    }

    let url: URL;

    try {
        url = new URL(submitted);
    }
    catch {
        return submitted;
    }

    if (url.username !== URL_CRED_MASK && url.password !== URL_CRED_MASK) {
        return submitted;
    }

    try {
        const stored = new URL(current);

        if (stored.username || stored.password) {
            // 不用 username/password setter：getter 返回已编码串，setter 的再编码行为不可靠
            // （会保留裸 % 却编码 :），直接按原文拼回可精确保留用户已有凭据
            const credentials = `${stored.username}${stored.password ? `:${stored.password}` : ''}`;

            return `${url.protocol}//${credentials}@${url.host}${url.pathname}${url.search}${url.hash}`;
        }
    }
    catch {
        // 已存值无法解析：下面按“保持不变”处理
    }

    return undefined;
}

function maskSettings(settings: Settings): Settings {
    const next = structuredClone(settings);

    if (next.ai.external.apiKey !== '') {
        next.ai.external.apiKey = API_KEY_MASK;
    }
    if (next.pixiv.refreshToken !== '') {
        next.pixiv.refreshToken = API_KEY_MASK;
    }

    next.pixiv.proxyUrl = maskUrlCredentials(next.pixiv.proxyUrl);

    return next;
}

function preparePatch(patch: SettingsPatch, current: Settings): SettingsPatch {
    let next = patch;

    if (next.ai?.external?.apiKey === API_KEY_MASK) {
        const external = { ...next.ai.external };

        delete external.apiKey;
        next = { ...next, ai: { ...next.ai, external } };
    }

    if (next.pixiv?.refreshToken === API_KEY_MASK) {
        const pixiv = { ...next.pixiv };

        delete pixiv.refreshToken;
        next = { ...next, pixiv };
    }

    if (next.pixiv?.proxyUrl !== undefined) {
        const resolved = resolveProxyPatch(next.pixiv.proxyUrl, current.pixiv.proxyUrl);
        const pixiv = { ...next.pixiv };

        if (resolved === undefined) {
            delete pixiv.proxyUrl;
        }
        else {
            pixiv.proxyUrl = resolved;
        }

        next = { ...next, pixiv };
    }

    return next;
}

/**
 * 全局设置：setting.json 的唯一 HTTP 入口。
 * 主题与语言也在其中（PATCH /settings/theme、PATCH /settings 的 i18n 字段）。
 */
export const settingsRoutes = new Hono<AppEnv>()
    .get('/', (c) => {
        return c.json({
            data: maskSettings(getSettings()),
            meta: { dataDir: describeDataDirectories().dataDir },
        });
    })
    .patch('/', validateJson(settingsPatchSchema), (c) => {
        const current = getSettings();
        const patch = preparePatch(c.req.valid('json'), current);

        // 远端后端仍是 stub，切换会让所有现有相册直接不可读；保留旧值则不影响其它设置保存
        if (
            patch.storage?.default !== undefined
            && patch.storage.default !== 'local'
            && patch.storage.default !== current.storage.default
        ) {
            throw new ApiError(
                422,
                'storage_backend_not_implemented',
                'Only the local storage backend is available in this build.',
            );
        }

        const runtimeChanged = (patch.modelsRoot !== undefined && patch.modelsRoot !== current.modelsRoot)
          || (patch.ai?.downloadConcurrency !== undefined
            && patch.ai.downloadConcurrency !== current.ai.downloadConcurrency);

        if (runtimeChanged && modelDownloader().hasActiveDownloads()) {
            throw new ApiError(
                409,
                'settings_busy',
                'Finish or cancel active model downloads before changing model paths or concurrency.',
            );
        }

        const updated = updateSettings(patch);

        if (runtimeChanged) {
            resetModelDownloader();
        }

        // 设备偏好或所选模型变了：旧的永久拉黑与已缓存会话都不再适用，清空让它重新试
        const inferenceChanged = patch.ai?.device !== undefined
          || patch.ai?.localModelId !== undefined
          || patch.ai?.captioningModelId !== undefined;

        if (inferenceChanged) {
            import('../../ai/tagger')
                .then(module => module.resetInferenceCaches())
                .catch(() => undefined);
        }

        return c.json({ data: maskSettings(updated) });
    })
    .patch('/theme', validateJson(themePatchSchema), (c) => {
        const updated = updateSettings({ theme: c.req.valid('json') });

        return c.json({ data: updated.theme });
    })
    .get('/ai/devices', async (c) => {
        const settings = getSettings();
        const baseModelId = settings.ai.labelMode === 'generative'
            ? settings.ai.captioningModelId
            : settings.ai.localModelId;
        const plan = await resolveInferencePlan(settings, baseModelId);

        return c.json({
            data: {
                platform: process.platform,
                arch: process.arch,
                preference: plan.preference,
                available: plan.available,
                active: plan.backend,
                accelerated: plan.accelerated,
                acceleratorModelId: plan.acceleratorModelId,
                acceleratorInstalled: plan.acceleratorInstalled,
            },
        });
    });
