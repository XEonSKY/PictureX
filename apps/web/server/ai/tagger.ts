import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import {
    env,
    pipeline,
    type DeviceType,
    type PretrainedModelOptions,
} from '@huggingface/transformers';
import { ApiError } from '../hono/problem';
import { logger } from '../logger';
import { modelRegistry } from '../model/model-registry';
import type { Settings } from '../settings/setting-schema';
import { resolveInferencePlan, type InferenceCandidate } from './device';
import { CAPTION_STOPWORDS, CANDIDATE_LABELS } from './labels';

export type AiMode = 'zero-shot' | 'generative' | 'external';

export interface TagInput {
    path: string
    mime: string
}

export interface TagOptions {
    /** 相册里已有标签名；零样本模式优先用它们，避免每次只产出内置词 */
    labels?: string[]
}

export const MAX_ZERO_SHOT_LABELS = 64;

/** 绝对下限：低于它的类别通常只是 softmax 长尾噪声 */
const MIN_ZERO_SHOT_SCORE = 0.05;
/** 相对阈值：只保留接近最高分的类别，避免候选很少时全部通过 */
const RELATIVE_SCORE_RATIO = 0.2;

function mergeZeroShotCandidates(existing: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const label of [...existing, ...CANDIDATE_LABELS]) {
        const trimmed = label.trim();
        const key = trimmed.toLocaleLowerCase();

        if (trimmed === '' || seen.has(key)) {
            continue;
        }

        seen.add(key);
        merged.push(trimmed);

        if (merged.length >= MAX_ZERO_SHOT_LABELS) {
            break;
        }
    }

    return merged;
}

export interface TagLabel {
    name: string
    score: number
}

export interface TagResult {
    mode: AiMode
    modelId: string
    labels: TagLabel[]
    caption?: string
    device: string
}

export interface Tagger {
    readonly mode: AiMode
    readonly modelId: string
    tag(input: TagInput, options?: TagOptions): Promise<TagResult>
}

type PipelineCallable = (input: string, labels?: unknown, options?: unknown) => Promise<unknown>;

export class PipelineLoadError extends Error {
    constructor(message: string, readonly modelId: string) {
        super(message);
        this.name = 'PipelineLoadError';
    }
}

type PipelineTask = 'zero-shot-image-classification' | 'image-to-text';

interface LoadedPipeline {
    runner: PipelineCallable
    backend: string | null
    modelId: string
}

/** transformers.js 的 Pipeline 通过底层 model.dispose() 释放 ONNX 会话；旧版兼容 runner.dispose() */
interface DisposablePipeline {
    dispose?: () => Promise<void> | void
    model?: { dispose?: () => Promise<void> | void }
}

function disposeRunner(runner: PipelineCallable): void {
    const target = runner as unknown as DisposablePipeline;

    const release = target.model?.dispose?.bind(target.model) ?? target.dispose?.bind(target);

    if (!release) {
        return;
    }

    try {
        void Promise.resolve(release()).catch((error: unknown) => {
            logger.warn({ err: error }, 'failed to dispose AI pipeline');
        });
    }
    catch (error) {
        logger.warn({ err: error }, 'failed to dispose AI pipeline');
    }
}

interface PipelineCacheEntry {
    baseModelId: string
    signature: string
    loading: Promise<LoadedPipeline>
}

// 每个 `${task}:${baseModelId}` 只保留一个会话（LRU=1）：切换 GPU↔CPU、换模型、
// loadPipeline 走 CPU 回退都会替换同一条目并显式释放旧的，长跑服务内存/显存不再单调增长。
const pipelines = new Map<string, PipelineCacheEntry>();

/**
 * 后端拉黑改为带 TTL 的集合：一次 CUDA OOM 或会话创建失败只在一段时间内排除该候选，
 * 之后允许重试，而不是进程内永久拉黑。
 */
const BACKEND_FAILURE_TTL_MS = 5 * 60 * 1000;
const failedBackends = new Map<string, number>();

function backendFailed(key: string): boolean {
    const expiresAt = failedBackends.get(key);

    if (expiresAt === undefined) {
        return false;
    }

    if (Date.now() >= expiresAt) {
        failedBackends.delete(key);

        return false;
    }

    return true;
}

function markBackendFailed(key: string): void {
    failedBackends.set(key, Date.now() + BACKEND_FAILURE_TTL_MS);
}

/** 卸载模型时释放其已加载会话；量化条目与 `-fp16` 条目一并清理 */
function relatedModelIds(modelId: string): Set<string> {
    const ids = new Set<string>([modelId]);

    if (modelId.endsWith('-fp16')) {
        ids.add(modelId.slice(0, -'-fp16'.length));
    }
    else {
        ids.add(`${modelId}-fp16`);
    }

    return ids;
}

export function disposeModelPipelines(modelId: string): void {
    const related = relatedModelIds(modelId);

    for (const [key, entry] of pipelines) {
        if (related.has(entry.baseModelId)) {
            pipelines.delete(key);
            entry.loading.then(loaded => disposeRunner(loaded.runner), () => undefined);
        }
    }
}

export function resetInferenceCaches(): void {
    failedBackends.clear();

    for (const entry of pipelines.values()) {
        entry.loading.then(loaded => disposeRunner(loaded.runner), () => undefined);
    }

    pipelines.clear();
}

function configureEnvironment(modelsRoot: string): void {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = modelsRoot.endsWith(sep) ? modelsRoot : `${modelsRoot}${sep}`;
}

function candidateKey(candidate: InferenceCandidate): string {
    return `${candidate.modelId}:${candidate.backend ?? 'cpu'}`;
}

function pipelineOptions(candidate: InferenceCandidate): PretrainedModelOptions {
    if (!candidate.backend) {
        return { dtype: candidate.dtype, device: 'cpu' };
    }

    if (candidate.backend === 'cuda' || candidate.backend === 'dml' || candidate.backend === 'coreml' || candidate.backend === 'webgpu') {
        return { dtype: candidate.dtype, device: candidate.backend as DeviceType };
    }

    // QNN / OpenVINO / VitisAI 等不在 transformers.js 的 device 枚举里，直接指定 EP
    return {
        dtype: candidate.dtype,
        device: 'cpu',
        session_options: { executionProviders: [candidate.backend] },
    };
}

async function loadPipeline(
    task: PipelineTask,
    settings: Settings,
    baseModelId: string,
): Promise<LoadedPipeline> {
    configureEnvironment(settings.modelsRoot);

    const plan = await resolveInferencePlan(settings, baseModelId);
    const candidates = plan.candidates.filter(candidate => (
        !candidate.backend || !backendFailed(candidateKey(candidate))
    ));
    const usable = candidates.length > 0
        ? candidates
        : [{ backend: null, modelId: baseModelId, dtype: 'q8' as const, accelerated: false }];
    const key = `${task}:${baseModelId}`;
    const signature = usable.map(candidateKey).join('|');
    const existing = pipelines.get(key);

    if (existing) {
        // 候选集没变：复用；变了（GPU↔CPU、换模型）：释放旧会话再加载，LRU=1
        if (existing.signature === signature) {
            return existing.loading;
        }

        pipelines.delete(key);
        existing.loading.then(loaded => disposeRunner(loaded.runner), () => undefined);
    }

    const loading = (async () => {
        let lastError: unknown;

        for (const candidate of usable) {
            try {
                const runner = await pipeline(task, candidate.modelId, pipelineOptions(candidate)) as PipelineCallable;

                logger.info({
                    task,
                    modelId: candidate.modelId,
                    backend: candidate.backend ?? 'cpu',
                    dtype: candidate.dtype,
                }, 'AI inference pipeline ready');

                return { runner, backend: candidate.backend, modelId: candidate.modelId };
            }
            catch (error) {
                lastError = error;
                markBackendFailed(candidateKey(candidate));
                logger.warn({
                    err: error,
                    task,
                    modelId: candidate.modelId,
                    backend: candidate.backend ?? 'cpu',
                }, 'failed to load AI inference pipeline');
            }
        }

        const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');

        throw new PipelineLoadError(`Failed to load ${baseModelId}: ${message}`, baseModelId);
    })();

    const entry: PipelineCacheEntry = { baseModelId, signature, loading };

    pipelines.set(key, entry);
    loading.catch(() => {
        // 加载失败不留缓存，下次请求可重试；只删自己写入的那条
        if (pipelines.get(key) === entry) {
            pipelines.delete(key);
        }
    });

    return loading;
}

async function infer<T>(
    task: PipelineTask,
    settings: Settings,
    baseModelId: string,
    invoke: (runner: PipelineCallable) => Promise<T>,
): Promise<{ value: T, device: string }> {
    const loaded = await loadPipeline(task, settings, baseModelId);

    try {
        return { value: await invoke(loaded.runner), device: loaded.backend ?? 'cpu' };
    }
    catch (error) {
        if (!loaded.backend) {
            throw error;
        }

        markBackendFailed(`${loaded.modelId}:${loaded.backend}`);
        logger.warn({
            err: error,
            backend: loaded.backend,
            modelId: loaded.modelId,
        }, 'accelerated inference failed, retrying on CPU');

        const cpu = await loadPipeline(task, settings, baseModelId);

        return { value: await invoke(cpu.runner), device: cpu.backend ?? 'cpu' };
    }
}

function normalizeLabels(raw: unknown, limit = 5): TagLabel[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const labels: TagLabel[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const record = item as { label?: unknown, score?: unknown };
        const name = typeof record.label === 'string' ? record.label.trim() : '';
        const score = typeof record.score === 'number' ? record.score : Number(record.score ?? 0);

        if (name !== '') {
            labels.push({ name, score: Number.isFinite(score) ? score : 0 });
        }
    }

    return labels.sort((a, b) => b.score - a.score).slice(0, limit);
}

export class ClipTagger implements Tagger {
    readonly mode = 'zero-shot' as const;
    readonly modelId: string;

    constructor(private readonly settings: Settings) {
        this.modelId = settings.ai.localModelId;
    }

    async tag(input: TagInput, options?: TagOptions): Promise<TagResult> {
        const seen = new Set<string>();
        const existing = (options?.labels ?? [])
            .map(label => label.trim())
            .filter((label) => {
                const key = label.toLocaleLowerCase();

                if (label === '' || seen.has(key)) {
                    return false;
                }

                seen.add(key);

                return true;
            })
            .slice(0, MAX_ZERO_SHOT_LABELS);
        // 已有标签必须与内置候选合并：候选只有 1 个时 softmax 恒为 1，
        // 整本相册会被打上同一个标签
        const candidates = mergeZeroShotCandidates(existing);
        const { value: output, device } = await infer(
            'zero-shot-image-classification',
            this.settings,
            this.modelId,
            runner => runner(input.path, candidates, { top_k: 5 }),
        );
        const ranked = normalizeLabels(output);
        const topScore = ranked[0]?.score ?? 0;
        const cutoff = Math.max(MIN_ZERO_SHOT_SCORE, topScore * RELATIVE_SCORE_RATIO);

        return {
            mode: this.mode,
            modelId: this.modelId,
            labels: ranked.filter(label => label.score >= cutoff),
            device,
        };
    }
}

export class BlipTagger implements Tagger {
    readonly mode = 'generative' as const;
    readonly modelId: string;

    constructor(private readonly settings: Settings) {
        this.modelId = settings.ai.captioningModelId;
    }

    async tag(input: TagInput): Promise<TagResult> {
        const { value: output, device } = await infer(
            'image-to-text',
            this.settings,
            this.modelId,
            runner => runner(input.path),
        );
        const first = Array.isArray(output) && output[0] && typeof output[0] === 'object'
            ? (output[0] as { generated_text?: unknown }).generated_text
            : undefined;
        const caption = typeof first === 'string' ? first.trim() : '';
        const words = caption
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/gu, ' ')
            .split(/\s+/u)
            .filter(word => word.length > 3 && !CAPTION_STOPWORDS.has(word));
        const labels = [...new Set(words)].slice(0, 6).map(name => ({ name, score: 1 }));

        return {
            mode: this.mode,
            modelId: this.modelId,
            labels,
            caption,
            device,
        };
    }
}

function parseExternalTags(content: string): string[] {
    const cleaned = content.replace(/```(?:json)?/giu, '').trim();
    const match = /\[[\s\S]*\]/u.exec(cleaned);

    if (match) {
        try {
            const parsed: unknown = JSON.parse(match[0]);

            if (Array.isArray(parsed)) {
                return parsed
                    .filter((item): item is string => typeof item === 'string')
                    .map(item => item.trim())
                    .filter(item => item.length > 0 && item.length <= 40)
                    .slice(0, 8);
            }
        }
        catch {
            // fall through to comma splitting
        }
    }

    return cleaned
        .split(/[,\n;]/u)
        .map(item => item.replace(/^[-*\d.\s]+/u, '').trim())
        .filter(item => item.length > 0 && item.length <= 40)
        .slice(0, 8);
}

const EXTERNAL_TIMEOUT_MS = 20_000;
const EXTERNAL_MAX_BYTES = 8 * 1024 * 1024;

export class ExternalTagger implements Tagger {
    readonly mode = 'external' as const;
    readonly modelId: string;

    constructor(
        private readonly settings: Settings,
        private readonly fallback?: Tagger,
    ) {
        this.modelId = settings.ai.external.model;
    }

    private endpoint(): string {
        const base = this.settings.ai.external.baseUrl.trim().replace(/\/+$/u, '');

        return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    }

    private async request(dataUrl: string, signal: AbortSignal): Promise<Response> {
        return fetch(this.endpoint(), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${this.settings.ai.external.apiKey}`,
            },
            body: JSON.stringify({
                model: this.settings.ai.external.model,
                temperature: 0.2,
                messages: [
                    {
                        role: 'system',
                        content: 'You tag photos. Reply with a JSON array of 5 to 8 short English tags and nothing else.',
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Tag this image.' },
                            { type: 'image_url', image_url: { url: dataUrl } },
                        ],
                    },
                ],
            }),
            signal,
        });
    }

    async tag(input: TagInput, options?: TagOptions): Promise<TagResult> {
        // 超时必须覆盖响应体读取：只包 fetch 会在收到响应头后立刻解除，
        // 慢速滴流会永久占住推理 worker。
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);

        try {
            const buffer = await readFile(input.path);

            if (buffer.byteLength > EXTERNAL_MAX_BYTES) {
                throw new Error('image exceeds the external API size limit');
            }

            const dataUrl = `data:${input.mime};base64,${buffer.toString('base64')}`;
            let response = await this.request(dataUrl, controller.signal);

            if (!response.ok && (response.status === 429 || response.status >= 500)) {
                await new Promise(resolve => setTimeout(resolve, 600));
                response = await this.request(dataUrl, controller.signal);
            }

            if (!response.ok) {
                throw new Error(`external API returned ${response.status}`);
            }

            const payload: unknown = await response.json();
            const content = payload
              && typeof payload === 'object'
              && 'choices' in payload
              && Array.isArray((payload as { choices?: unknown }).choices)
                ? (payload as { choices: { message?: { content?: unknown } }[] }).choices[0]?.message?.content
                : undefined;
            const text = typeof content === 'string' ? content : '';

            if (text.trim() === '') {
                throw new Error('external API returned an empty response');
            }

            const names = parseExternalTags(text);

            return {
                mode: this.mode,
                modelId: this.modelId,
                labels: names.map(name => ({ name, score: 1 })),
                caption: text.trim(),
                device: 'external',
            };
        }
        catch (error) {
            if (this.fallback) {
                return this.fallback.tag(input, options);
            }

            throw new ApiError(
                502,
                'ai_external_failed',
                `External tagging failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        finally {
            clearTimeout(timer);
        }
    }
}

function localModelInstalled(settings: Settings, modelId: string): boolean {
    try {
        const entry = modelRegistry(settings).get(modelId);

        return entry.status === 'installed' && entry.broken !== true;
    }
    catch {
        return false;
    }
}

export function createTagger(settings: Settings, mode: AiMode): Tagger {
    if (mode === 'generative') {
        return new BlipTagger(settings);
    }
    if (mode === 'external') {
        const fallback = settings.ai.localModelId && localModelInstalled(settings, settings.ai.localModelId)
            ? new ClipTagger(settings)
            : undefined;

        return new ExternalTagger(settings, fallback);
    }

    return new ClipTagger(settings);
}

export function requireLocalModel(settings: Settings, mode: AiMode): string {
    if (mode === 'external') {
        return settings.ai.external.model;
    }

    const modelId = mode === 'generative' ? settings.ai.captioningModelId : settings.ai.localModelId;

    if (!localModelInstalled(settings, modelId)) {
        throw new ApiError(404, 'ai_model_missing', `The model "${modelId}" is not installed.`);
    }

    return modelId;
}
