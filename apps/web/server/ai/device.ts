import { logger } from '../logger';
import { findModelDefinition } from '../model/catalog';
import { modelRegistry } from '../model/model-registry';
import type { Settings } from '../settings/setting-schema';

/**
 * 推理设备选择：以 onnxruntime-node 实际编译进二进制的 EP 为准。
 * NPU 加速暂不提供，只保留 GPU > CPU：CUDA / DirectML / ROCm / MIGraphX / OpenVINO /
 * Core ML / WebGPU 都在 GPU 层级，按平台与运行库能力选择。
 */

export type AiDevicePreference = Settings['ai']['device'];
export type BackendKind = 'cpu' | 'gpu' | 'other';

export interface BackendInfo {
    id: string
    label: string
    kind: BackendKind
}

const BACKEND_META: Record<string, { label: string, kind: BackendKind }> = {
    cpu: { label: 'CPU', kind: 'cpu' },
    cuda: { label: 'CUDA', kind: 'gpu' },
    dml: { label: 'DirectML', kind: 'gpu' },
    rocm: { label: 'ROCm', kind: 'gpu' },
    migraphx: { label: 'MIGraphX', kind: 'gpu' },
    openvino: { label: 'OpenVINO', kind: 'gpu' },
    coreml: { label: 'Core ML', kind: 'gpu' },
    webgpu: { label: 'WebGPU', kind: 'gpu' },
};

// 回退等级：GPU > CPU；GPU 内部优先 CUDA，再 DirectML / ROCm 等
const GPU_ORDER = ['cuda', 'dml', 'rocm', 'migraphx', 'openvino', 'coreml', 'webgpu'];

let backendsPromise: Promise<BackendInfo[]> | null = null;

function toBackendInfo(id: string): BackendInfo {
    const meta = BACKEND_META[id];

    return meta
        ? { id, label: meta.label, kind: meta.kind }
        : { id, label: id, kind: 'other' };
}

export async function listBackends(): Promise<BackendInfo[]> {
    if (!backendsPromise) {
        backendsPromise = (async () => {
            try {
                const ort = await import('onnxruntime-node');
                const ids = ort.listSupportedBackends()
                    .filter(backend => backend.name !== 'cpu' && BACKEND_META[backend.name]?.kind === 'gpu')
                    .map(backend => backend.name);

                return [{ id: 'cpu', label: 'CPU', kind: 'cpu' }, ...ids.map(toBackendInfo)];
            }
            catch (error) {
                logger.warn({ err: error }, 'failed to enumerate ONNX execution providers');

                return [{ id: 'cpu', label: 'CPU', kind: 'cpu' }];
            }
        })();
    }

    return backendsPromise;
}

export function rankBackends(available: ReadonlySet<string>, preference: AiDevicePreference): string[] {
    if (preference === 'cpu') {
        return [];
    }

    // auto / gpu 都走 GPU 层级；没有可用 GPU 时由候选列表末尾的 CPU 兜底
    return GPU_ORDER.filter(id => available.has(id));
}

export function acceleratorModelId(baseModelId: string): string {
    return `${baseModelId}-fp16`;
}

export interface ModelRoles {
    /** 加速权重所在条目（所选模型本身就是 FP16 时即它自己） */
    acceleratorId: string
    /** 回退加载的条目 */
    fallbackId: string
    /** 回退条目使用的 dtype */
    fallbackDtype: 'q8' | 'fp16'
}

export function modelRolesFor(modelId: string, settings?: Settings): ModelRoles {
    if (modelId.endsWith('-fp16')) {
        const base = modelId.slice(0, -'-fp16'.length);
        const baseEntry = findModelDefinition(base);

        // CPU 不能继续加载 FP16：对应量化条目可用时才回退 q8；
        // 只安装了 fp16 时继续用 fp16，避免回退到不存在的文件。
        if (baseEntry && !baseEntry.broken && (!settings || isInstalled(settings, base))) {
            return { acceleratorId: modelId, fallbackId: base, fallbackDtype: 'q8' };
        }

        return { acceleratorId: modelId, fallbackId: modelId, fallbackDtype: 'fp16' };
    }

    return { acceleratorId: acceleratorModelId(modelId), fallbackId: modelId, fallbackDtype: 'q8' };
}

function isInstalled(settings: Settings, modelId: string): boolean {
    const definition = findModelDefinition(modelId);

    if (!definition || definition.broken) {
        return false;
    }

    try {
        return modelRegistry(settings).get(modelId).status === 'installed';
    }
    catch {
        return false;
    }
}

export interface InferenceCandidate {
    backend: string | null
    modelId: string
    dtype: 'q8' | 'fp16'
    accelerated: boolean
}

export interface InferencePlan {
    preference: AiDevicePreference
    available: BackendInfo[]
    backend: string | null
    modelId: string
    dtype: 'q8' | 'fp16'
    accelerated: boolean
    candidates: InferenceCandidate[]
    acceleratorModelId: string
    acceleratorInstalled: boolean
}

/**
 * @param selectedModelId 设置里选中的模型条目，可能是量化条目，也可能直接是 `-fp16` 条目
 */
export async function resolveInferencePlan(settings: Settings, selectedModelId: string): Promise<InferencePlan> {
    const available = await listBackends();
    const ids = new Set(available.map(backend => backend.id));
    const roles = modelRolesFor(selectedModelId, settings);
    const hasAccelerator = isInstalled(settings, roles.acceleratorId);
    const candidates: InferenceCandidate[] = [];

    if (hasAccelerator) {
        for (const backend of rankBackends(ids, settings.ai.device)) {
            candidates.push({ backend, modelId: roles.acceleratorId, dtype: 'fp16', accelerated: true });
        }
    }

    candidates.push({
        backend: null,
        modelId: roles.fallbackId,
        dtype: roles.fallbackDtype,
        accelerated: false,
    });

    const first = candidates[0] ?? {
        backend: null,
        modelId: roles.fallbackId,
        dtype: roles.fallbackDtype,
        accelerated: false,
    };

    return {
        preference: settings.ai.device,
        available,
        backend: first.backend,
        modelId: first.modelId,
        dtype: first.dtype,
        accelerated: first.accelerated,
        candidates,
        acceleratorModelId: roles.acceleratorId,
        acceleratorInstalled: hasAccelerator,
    };
}
