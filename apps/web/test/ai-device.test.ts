import { describe, expect, it } from 'vitest';
import { acceleratorModelId, modelRolesFor, rankBackends } from '../server/ai/device';
import { parseSettings } from '../server/settings/setting-schema';

describe('AI inference device selection', () => {
    it('defaults to auto and rejects unknown preferences', () => {
        expect(parseSettings({}).ai.device).toBe('auto');
        expect(() => parseSettings({ ai: { device: 'npu' } })).toThrow();
        expect(() => parseSettings({ ai: { device: 'tpu' } })).toThrow();
    });

    it('maps a quantized model to its FP16 accelerator entry', () => {
        expect(modelRolesFor('clip-vit-base-patch32')).toEqual({
            acceleratorId: 'clip-vit-base-patch32-fp16',
            fallbackId: 'clip-vit-base-patch32',
            fallbackDtype: 'q8',
        });
    });

    it('falls back to the quantized entry when a FP16 model is used on CPU', () => {
        expect(modelRolesFor('clip-vit-base-patch32-fp16')).toEqual({
            acceleratorId: 'clip-vit-base-patch32-fp16',
            fallbackId: 'clip-vit-base-patch32',
            fallbackDtype: 'q8',
        });
    });

    it('uses GPU > CPU and keeps CUDA first inside the GPU tier', () => {
        const available = new Set(['cpu', 'dml', 'cuda', 'qnn']);

        expect(rankBackends(available, 'auto')).toEqual(['cuda', 'dml']);
        expect(rankBackends(available, 'gpu')).toEqual(['cuda', 'dml']);
    });

    it('ranks Intel/AMD/macOS GPU providers after CUDA without duplicates', () => {
        const available = new Set(['cpu', 'dml', 'cuda', 'openvino', 'coreml', 'qnn']);
        const ranked = rankBackends(available, 'auto');

        expect(ranked).toEqual(['cuda', 'dml', 'openvino', 'coreml']);
        expect(new Set(ranked).size).toBe(ranked.length);
    });

    it('uses no accelerator for cpu and suffixes FP16 model ids', () => {
        expect(rankBackends(new Set(['cuda', 'dml']), 'cpu')).toEqual([]);
        expect(acceleratorModelId('clip-vit-base-patch32')).toBe('clip-vit-base-patch32-fp16');
    });
});
