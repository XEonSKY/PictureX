import { z } from 'zod';
import { MODEL_CATALOG } from '../model/catalog';
import { isAllowedFfmpegPath } from '../ingest/ffmpeg-path';
import { normalizeThemeState } from '#shared/theme';

const BROKEN_MODELS = new Set(MODEL_CATALOG.filter(model => model.broken).map(model => model.id));

/** 与自带 ONNX Runtime 不兼容的条目（例如 ViT-GPT2 FP16）自动退回同仓库的量化条目 */
function migrateBrokenModel(modelId: string, fallback: string): string {
    if (!BROKEN_MODELS.has(modelId)) {
        return modelId;
    }

    const base = modelId.endsWith('-fp16') ? modelId.slice(0, -'-fp16'.length) : fallback;

    return BROKEN_MODELS.has(base) ? fallback : base;
}

const storageSchema = z.object({
    default: z.enum(['local', 'quark', 'oss', 'ftp']).default('local'),
    partitionSize: z.number().int().min(1).max(1_000_000).default(8192),
    // 只支持 sequence；读到其它值必须在启动时报错（不得静默回退）
    partitionMode: z.literal('sequence').default('sequence'),
});

/**
 * 外部 AI 接口会带 API Key（及原图 base64）过网，只允许 https；
 * http 仅在指向本机回环时放行（Ollama / llama.cpp 等本地服务）。
 */
export function isAllowedAiBaseUrl(value: string): boolean {
    if (value === '') {
        return true;
    }

    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^\[|\]$/u, '');
        const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

        return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    }
    catch {
        return false;
    }
}

const thumbnailsSchema = z.object({
    dbMaxSizeMb: z.number().int().min(64).max(1_048_576).default(2048),
    sizes: z.array(z.number().int().min(64).max(4096)).min(1).default([256, 512, 1024]),
    quality: z.number().int().min(1).max(100).default(80),
    autoOptimize: z.boolean().default(true),
    /** 浏览时只返回全局缩略图库已缓存档位，缺图只进后台队列，绝不阻塞解码原图 */
    cacheFirst: z.boolean().default(false),
});

const externalAiSchema = z.object({
    enabled: z.boolean().default(false),
    // 只允许 http(s)，避免 file:/data: 等协议被外部请求利用
    baseUrl: z.string().trim().max(2048).default('').refine(
        value => value === '' || /^https?:\/\/[^\s]+$/iu.test(value),
        { message: 'baseUrl must be an http(s) URL' },
    ),
    apiKey: z.string().default(''),
    model: z.string().default(''),
});

/**
 * 写入路径的 baseUrl 比启动读取更严格：启动保持宽松以免历史配置直接崩溃，
 * 新保存/编辑则强制 https（或回环 http）。
 */
const externalAiPatchSchema = externalAiSchema.partial().extend({
    baseUrl: z.string().trim().max(2048).refine(isAllowedAiBaseUrl, {
        message: 'baseUrl must use https (http is only allowed for localhost)',
    }).optional(),
});

const aiSchema = z.object({
    labelMode: z.enum(['zero-shot', 'generative', 'external']).default('zero-shot'),
    // auto：GPU > CPU；GPU 内部优先 CUDA，其次 DirectML 等；加速需要对应 FP16 模型
    device: z.enum(['auto', 'cpu', 'gpu']).default('auto'),
    localModelId: z.string().default('clip-vit-base-patch32'),
    captioningModelId: z.string().default('vit-gpt2-image-captioning'),
    external: externalAiSchema.default({ enabled: false, baseUrl: '', apiKey: '', model: '' }),
    autoTag: z.boolean().default(false),
    downloadConcurrency: z.number().int().min(1).max(16).default(4),
    autoResumeDownload: z.boolean().default(false),
});

const similaritySchema = z.object({
    enabled: z.boolean().default(true),
    algorithm: z.literal('phash').default('phash'),
    hammingThreshold: z.number().int().min(0).max(64).default(8),
});

const pixivSchema = z.object({
    /** OAuth refresh token；GET /settings 以掩码返回 */
    refreshToken: z.string().default(''),
    accountId: z.string().default(''),
    accountName: z.string().default(''),
    account: z.string().default(''),
    premium: z.boolean().default(false),
    // direct：系统网络；proxy：经 HTTP CONNECT 或 SOCKS5 代理访问
    networkMode: z.enum(['direct', 'proxy']).default('proxy'),
    proxyUrl: z.string().trim().max(2048).default('socks5://127.0.0.1:10808').refine(
        value => value === '' || /^(?:http|socks5h?):\/\/[^\s]+$/iu.test(value),
        { message: 'proxyUrl must be an http, socks5 or socks5h URL' },
    ),
    imageQuality: z.enum(['original', 'large', 'medium']).default('original'),
    // 后台补全元数据的请求间隔：slow 1–3s，normal 100–1000ms，fast 50–300ms
    autoFetchSpeed: z.enum(['slow', 'normal', 'fast']).default('normal'),
    // 用户手动暂停后台补全；持久化后重启也不会自动开始
    autoFetchPaused: z.boolean().default(false),
});

/** 局部更新不能带默认值，否则 PATCH 网络模式会把未提交的 token 清空 */
const pixivPatchSchema = z.object({
    refreshToken: z.string().optional(),
    accountId: z.string().optional(),
    accountName: z.string().optional(),
    account: z.string().optional(),
    premium: z.boolean().optional(),
    networkMode: z.enum(['direct', 'proxy']).optional(),
    proxyUrl: z.string().trim().max(2048).refine(
        value => value === '' || /^(?:http|socks5h?):\/\/[^\s]+$/iu.test(value),
        { message: 'proxyUrl must be an http, socks5 or socks5h URL' },
    ).optional(),
    imageQuality: z.enum(['original', 'large', 'medium']).optional(),
    autoFetchSpeed: z.enum(['slow', 'normal', 'fast']).optional(),
    autoFetchPaused: z.boolean().optional(),
});

const ffmpegSchema = z.object({
    enabled: z.boolean().default(true),
    path: z.string().trim().refine(isAllowedFfmpegPath, {
        message: 'ffmpeg.path must be "auto" or an absolute path to an ffmpeg/ffprobe executable',
    }).default('auto'),
});

const themeSchema = z.object({
    preset: z.enum(['light', 'dark']).default('light'),
    overrides: z.record(z.string(), z.string()).default({}),
});

const i18nSchema = z.object({
    defaultLocale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
    locales: z.array(z.enum(['zh-CN', 'en-US'])).min(1).default(['zh-CN', 'en-US']),
});

export const settingsSchema = z.object({
    schemaVersion: z.literal(1).default(1),
    albumsRoot: z.string().default(''),
    modelsRoot: z.string().default(''),
    storage: storageSchema,
    thumbnails: thumbnailsSchema,
    ai: aiSchema,
    similarity: similaritySchema,
    pixiv: pixivSchema,
    ffmpeg: ffmpegSchema,
    theme: themeSchema,
    i18n: i18nSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = DeepPartial<Settings>;

export const settingsPatchSchema = z.object({
    albumsRoot: z.string().optional(),
    modelsRoot: z.string().optional(),
    storage: storageSchema.partial().optional(),
    thumbnails: thumbnailsSchema.partial().optional(),
    ai: aiSchema.partial().extend({ external: externalAiPatchSchema.optional() }).optional(),
    similarity: similaritySchema.partial().optional(),
    pixiv: pixivPatchSchema.optional(),
    ffmpeg: ffmpegSchema.partial().optional(),
    theme: themeSchema.partial().optional(),
    i18n: i18nSchema.partial().optional(),
});

export const themePatchSchema = z.object({
    preset: z.enum(['light', 'dark']).optional(),
    overrides: z.record(z.string(), z.string()).optional(),
});

export type DeepPartial<T> = T extends (infer U)[]
    ? U[]
    : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : T;

export const DEFAULT_SETTINGS: Settings = {
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

export function mergeDeep<T>(base: T, patch: unknown): T {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return base;
    }

    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        const current = result[key];

        if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && current
            && typeof current === 'object'
            && !Array.isArray(current)
        ) {
            result[key] = mergeDeep(current, value);
        }
        else if (value !== undefined) {
            result[key] = value;
        }
    }

    return result as T;
}

/** 补默认值、收敛 theme.overrides 白名单，并校验 partitionMode */
export function parseSettings(raw: unknown): Settings {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const storage = (raw as { storage?: { partitionMode?: unknown } }).storage;

        if (storage && storage.partitionMode !== undefined && storage.partitionMode !== 'sequence') {
            throw new Error(`storage.partitionMode 只支持 'sequence'，当前为 ${JSON.stringify(storage.partitionMode)}`);
        }
    }

    const merged = mergeDeep(DEFAULT_SETTINGS, raw);

    // 启动读取时若存了非白名单的 ffmpeg 路径（旧版本/手改/被篡改），安全回退到 auto，
    // 绝不 spawn 任意可执行文件；API 写路径则由 settingsPatchSchema 直接返回 422。
    const mergedFfmpeg = merged.ffmpeg as { path?: unknown } | undefined;

    if (mergedFfmpeg && !isAllowedFfmpegPath(mergedFfmpeg.path as string | undefined)) {
        mergedFfmpeg.path = 'auto';
    }

    const pixiv = merged.pixiv as { proxyUrl?: unknown };

    if (typeof pixiv.proxyUrl !== 'string' || pixiv.proxyUrl.trim() === '') {
        pixiv.proxyUrl = DEFAULT_SETTINGS.pixiv.proxyUrl;
    }

    const parsed = settingsSchema.parse(merged);

    // 远端后端仍是 stub；启动时直接拒绝，避免每个请求才 501
    if (parsed.storage.default !== 'local') {
        throw new Error(`storage.default 目前只支持 'local'，${parsed.storage.default} 尚未实现`);
    }

    parsed.theme = normalizeThemeState(parsed.theme);

    parsed.ai.localModelId = migrateBrokenModel(parsed.ai.localModelId, DEFAULT_SETTINGS.ai.localModelId);
    parsed.ai.captioningModelId = migrateBrokenModel(parsed.ai.captioningModelId, DEFAULT_SETTINGS.ai.captioningModelId);

    return parsed;
}
