import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../server/hono/problem';
import { ModelRegistry, assertWithinRoot, isValidModelId, modelReferenceGroup } from '../server/model/model-registry';

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'picturex-model-safety-'));
});

afterAll(() => {
    try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    catch {
        // Windows 句柄释放延迟
    }
});

describe('isValidModelId', () => {
    it('accepts single safe path segments', () => {
        for (const id of ['clip-vit-base-patch32', 'vit-gpt2-image-captioning-fp16', 'test-model', 'a.b_c-1', 'x']) {
            expect(isValidModelId(id), id).toBe(true);
        }
    });

    it('rejects traversal, separators, casing, spaces and overlong ids', () => {
        for (
            const id of [
                '',
                '../evil',
                '..',
                'a/b',
                'a\\b',
                '..%2fevil',
                'UPPER',
                'a b',
                '.hidden',
                `${'a'.repeat(65)}`,
            ]
        ) {
            expect(isValidModelId(id), id).toBe(false);
        }
    });
});

describe('assertWithinRoot', () => {
    it('resolves safe children inside the root and throws on escape', () => {
        const modelsRoot = join(root, 'models');

        expect(assertWithinRoot(modelsRoot, join(modelsRoot, 'clip-vit-base-patch32')))
            .toBe(assertWithinRoot(modelsRoot, join(modelsRoot, 'clip-vit-base-patch32')));

        expect(() => assertWithinRoot(modelsRoot, join(modelsRoot, '..', 'evil'))).toThrow(ApiError);
    });
});

describe('modelReferenceGroup', () => {
    it('protects the base model together with its fp16 accelerator', () => {
        const active = modelReferenceGroup(['clip-vit-base-patch32', '']);

        expect(active.has('clip-vit-base-patch32')).toBe(true);
        expect(active.has('clip-vit-base-patch32-fp16')).toBe(true);
        expect(active.has('vit-gpt2-image-captioning-fp16')).toBe(false);
        expect(active.has('')).toBe(false);
    });

    it('resolves a referenced fp16 entry back to its base model', () => {
        const active = modelReferenceGroup(['vit-gpt2-image-captioning-fp16']);

        expect(active.has('vit-gpt2-image-captioning')).toBe(true);
        expect(active.has('vit-gpt2-image-captioning-fp16')).toBe(true);
    });
});

describe('ModelRegistry path guards', () => {
    function expectModelNotFound(action: () => unknown): void {
        try {
            action();
        }
        catch (error) {
            expect(error).toBeInstanceOf(ApiError);
            expect((error as ApiError).code).toBe('model_not_found');

            return;
        }
        throw new Error('expected the action to throw model_not_found');
    }

    it('rejects malformed ids before any directory is touched and keeps dirFor in-root', () => {
        const modelsRoot = join(root, 'guarded-models');
        const escapeDir = join(root, 'escape-target');

        mkdirSync(modelsRoot, { recursive: true });
        mkdirSync(escapeDir, { recursive: true });
        writeFileSync(join(escapeDir, 'keep.txt'), 'do-not-delete');
        const registry = new ModelRegistry(modelsRoot);

        // get() 先做格式校验：畸形 id 直接 404，remove/verify 的 rmSync 永远拿不到它
        for (const bad of ['../escape-target', 'a/b', '..%2fx', '']) {
            expectModelNotFound(() => registry.get(bad));
        }

        // remove('../escape-target') 走 get() 校验 → 抛错，绝不 rmSync 越界目录
        expectModelNotFound(() => registry.remove('../escape-target'));
        expect(existsSync(join(escapeDir, 'keep.txt'))).toBe(true);

        // dirFor 独立兜底：即便绕过 get 直接调用也不会越出 modelsRoot
        expectModelNotFound(() => registry.dirFor('../escape-target'));
        expect(registry.dirFor('clip-vit-base-patch32').startsWith(modelsRoot)).toBe(true);
    });
});
