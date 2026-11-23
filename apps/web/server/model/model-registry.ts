import { existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../hono/problem';
import type { Settings } from '../settings/setting-schema';
import { readJsonFileSafe, writeJsonAtomic } from '../utils/atomic-json';
import { KeyedMutex } from '../utils/keyed-mutex';
import { sha256File } from '../utils/hash';
import { MODEL_CATALOG, findModelDefinition } from './catalog';
import type { InstalledFile, ModelEntry, ModelFileSpec, ModelIndexFile } from './types';

/**
 * 模型 id 必须是单个安全路径段（清单与手动导入的 id 都符合）；
 * `remove()`/`dirFor()` 会 `rmSync(recursive)` 并按 id 拼目录，故必须在边界拦掉 `../` 之类的遍历。
 */
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function isValidModelId(modelId: string): boolean {
    return SAFE_MODEL_ID.test(modelId);
}

/**
 * 引用组：基础模型与 `<id>-fp16` 加速条目共享同一次安装，
 * 清理/保护必须把两者当整体，不能只按精确 id 判断。
 */
export function modelReferenceGroup(ids: readonly string[]): Set<string> {
    const group = new Set<string>();

    for (const id of ids) {
        const base = id.endsWith('-fp16') ? id.slice(0, -'-fp16'.length) : id;

        if (base === '') {
            continue;
        }

        group.add(base);
        group.add(`${base}-fp16`);
    }

    return group;
}

/** 断言 target 解析后仍位于 root 之内（与 storage/local.ts 同款写法） */
export function assertWithinRoot(root: string, target: string): string {
    const rootResolved = resolve(root);
    const targetResolved = resolve(target);

    if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}${sep}`)) {
        // 按「不存在」处理，不给遍历/畸形 id 区分信号（复用已翻译的 model_not_found）
        throw new ApiError(404, 'model_not_found', 'The requested model does not exist.');
    }

    return targetResolved;
}

/**
 * 模型仓库清单 <modelsRoot>/index.json：
 * 只记录 available / installed / corrupted 与已安装文件，不记录下载进度。
 * 下载进度与任务状态在 .download/index.json（下载任务清单）。
 */

function definitionsTotal(definitions: ModelFileSpec[]): number {
    return definitions.reduce((sum, file) => sum + (file.size > 0 ? file.size : 0), 0);
}

function freshEntry(modelId: string): ModelEntry | null {
    const definition = findModelDefinition(modelId);

    if (!definition) {
        return null;
    }

    return {
        id: definition.id,
        name: definition.name,
        task: definition.task,
        description: definition.description,
        status: 'available',
        totalBytes: definitionsTotal(definition.files),
        files: definition.files,
        installedFiles: [],
        installedAt: null,
        updatedAt: new Date().toISOString(),
        error: null,
        broken: definition.broken ?? false,
    };
}

export class ModelRegistry {
    private data: ModelIndexFile;
    private readonly verifyLock = new KeyedMutex();

    constructor(private readonly modelsRoot: string) {
        this.data = this.load();
        const changed = this.mergeCatalog();

        if (changed) {
            this.persist();
        }
    }

    private load(): ModelIndexFile {
        const raw = readJsonFileSafe<ModelIndexFile>(join(this.modelsRoot, 'index.json'));

        if (!raw || !Array.isArray(raw.models)) {
            return { schemaVersion: 1, models: [] };
        }

        return raw;
    }

    private mergeCatalog(): boolean {
        let changed = false;
        const known = new Set(MODEL_CATALOG.map(model => model.id));

        // 已从目录移除且本机没有文件的条目不再展示；已安装的保留，避免孤儿文件失去记录
        const kept = this.data.models.filter(model =>
            known.has(model.id) || model.status === 'installed' || model.installedFiles.length > 0,
        );

        if (kept.length !== this.data.models.length) {
            this.data.models = kept;
            changed = true;
        }

        for (const definition of MODEL_CATALOG) {
            const existing = this.data.models.find(model => model.id === definition.id);

            if (!existing) {
                const entry = freshEntry(definition.id);

                if (entry) {
                    this.data.models.push(entry);
                    changed = true;
                }

                continue;
            }

            // 目录里的名称/任务/URL 是权威，安装状态保留
            if (
                existing.name !== definition.name
                || existing.task !== definition.task
                || existing.description !== definition.description
                || existing.broken !== (definition.broken ?? false)
                || JSON.stringify(existing.files) !== JSON.stringify(definition.files)
            ) {
                existing.name = definition.name;
                existing.task = definition.task;
                existing.description = definition.description;
                existing.broken = definition.broken ?? false;
                existing.files = definition.files;
                existing.totalBytes = definitionsTotal(definition.files) || existing.totalBytes;
                existing.updatedAt = new Date().toISOString();
                changed = true;
            }
        }

        return changed;
    }

    private persist(): void {
        writeJsonAtomic(join(this.modelsRoot, 'index.json'), this.data);
    }

    list(): ModelEntry[] {
        return this.data.models;
    }

    get(modelId: string): ModelEntry {
        if (!isValidModelId(modelId)) {
            throw new ApiError(404, 'model_not_found', 'The requested model does not exist.');
        }

        const entry = this.data.models.find(model => model.id === modelId);

        if (!entry) {
            throw new ApiError(404, 'model_not_found', 'The requested model does not exist.');
        }

        return entry;
    }

    dirFor(modelId: string): string {
        return assertWithinRoot(this.modelsRoot, join(this.modelsRoot, modelId));
    }

    /** 手动导入 / 测试：写入一条自定义模型条目 */
    importEntry(entry: ModelEntry): ModelEntry {
        this.data.models = this.data.models.filter(model => model.id !== entry.id);
        this.data.models.push(entry);
        this.persist();

        return entry;
    }

    markInstalled(modelId: string, files: InstalledFile[]): ModelEntry {
        const entry = this.get(modelId);
        const now = new Date().toISOString();

        entry.status = 'installed';
        entry.installedFiles = files;
        entry.installedAt = now;
        entry.updatedAt = now;
        entry.error = null;
        entry.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        this.persist();

        return entry;
    }

    markCorrupted(modelId: string, error: string): ModelEntry {
        const entry = this.get(modelId);

        entry.status = 'corrupted';
        entry.error = error;
        entry.updatedAt = new Date().toISOString();
        this.persist();

        return entry;
    }

    markAvailable(modelId: string): ModelEntry {
        const entry = this.get(modelId);

        entry.status = 'available';
        entry.installedFiles = [];
        entry.installedAt = null;
        entry.error = null;
        entry.updatedAt = new Date().toISOString();
        entry.totalBytes = definitionsTotal(entry.files);
        this.persist();

        return entry;
    }

    remove(modelId: string): ModelEntry {
        const entry = this.get(modelId);
        const dir = this.dirFor(modelId);

        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }

        return this.markAvailable(entry.id);
    }

    async verify(modelId: string): Promise<ModelEntry> {
        // verify 内 await sha256File 期间，另一路（并发 verify 或安装后的 markInstalled）
        // 可能改动同一 modelId 的条目；按 modelId 串行，避免基于过期视图落盘。
        return this.verifyLock.run(modelId, () => this.verifyFiles(modelId));
    }

    private async verifyFiles(modelId: string): Promise<ModelEntry> {
        const entry = this.get(modelId);
        const dir = this.dirFor(modelId);

        if (!existsSync(dir)) {
            return this.markAvailable(modelId);
        }

        const installed: InstalledFile[] = [];

        for (const file of entry.files) {
            const path = join(dir, file.path);

            if (!existsSync(path)) {
                return this.markCorrupted(modelId, `missing file: ${file.path}`);
            }

            const size = statSync(path).size;

            if (file.size > 0 && size !== file.size) {
                return this.markCorrupted(modelId, `size mismatch: ${file.path}`);
            }

            const hash = file.sha256 ? await sha256File(path) : '';

            if (file.sha256 && hash !== file.sha256) {
                return this.markCorrupted(modelId, `checksum mismatch: ${file.path}`);
            }

            installed.push({ path: file.path, size, sha256: hash });
        }

        return this.markInstalled(modelId, installed);
    }
}

const registries = new Map<string, ModelRegistry>();

export function modelRegistry(settings: Settings): ModelRegistry {
    const cached = registries.get(settings.modelsRoot);

    if (cached) {
        return cached;
    }

    const registry = new ModelRegistry(settings.modelsRoot);

    registries.set(settings.modelsRoot, registry);

    return registry;
}
