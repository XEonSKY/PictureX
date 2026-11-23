import type { ModelDefinition, ModelFileSpec } from './types';

/**
 * 内置模型清单（量化 ONNX，供 @huggingface/transformers 加载）。
 * 默认源 ModelScope（国内实测比 hf-mirror 快一个数量级）；
 * `PX_MODEL_SOURCE=hf-mirror` 回退 HF 镜像，`PX_MODEL_MIRROR` 可再覆盖 HF 主机名。
 *
 * size/sha256 取自源站清单接口并在安装前逐文件校验；
 * transformers.js 的 CLIP 需要合并图 model_quantized.onnx，encoder-decoder 走拆分文件。
 */

const HF_HOST = process.env.PX_MODEL_MIRROR ?? 'https://hf-mirror.com';
const MODEL_SOURCE = process.env.PX_MODEL_SOURCE === 'hf-mirror' ? 'hf-mirror' : 'modelscope';

const CLIP_REPO = 'Xenova/clip-vit-base-patch32';
const CAPTION_REPO = 'Xenova/vit-gpt2-image-captioning';

function modelFile(repo: string, path: string, size: number, sha256: string): ModelFileSpec {
    const url = MODEL_SOURCE === 'modelscope'
        ? `https://www.modelscope.cn/models/${repo}/resolve/master/${path}`
        : `${HF_HOST}/${repo}/resolve/main/${path}`;

    return { path, url, size, sha256 };
}

export const MODEL_CATALOG: ModelDefinition[] = [
    {
        id: 'clip-vit-base-patch32',
        name: 'CLIP ViT-B/32',
        task: 'zero-shot',
        description: 'OpenAI CLIP zero-shot image classification (quantized ONNX).',
        files: [
            modelFile(CLIP_REPO, 'config.json', 4524, '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495'),
            modelFile(CLIP_REPO, 'preprocessor_config.json', 520, '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f'),
            modelFile(CLIP_REPO, 'special_tokens_map.json', 472, 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac'),
            modelFile(CLIP_REPO, 'tokenizer.json', 2224119, 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd'),
            modelFile(CLIP_REPO, 'tokenizer_config.json', 775, '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967'),
            modelFile(CLIP_REPO, 'vocab.json', 862328, '5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363'),
            modelFile(CLIP_REPO, 'merges.txt', 524619, '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a'),
            modelFile(CLIP_REPO, 'onnx/model_quantized.onnx', 153695702, '0898a3facfdb27f0a041e57649b4989cfd094e4a0040d6ae75ed69917dfc7328'),
        ],
    },
    {
        id: 'clip-vit-base-patch32-fp16',
        name: 'CLIP ViT-B/32 · FP16',
        task: 'zero-shot',
        description: 'FP16 ONNX for GPU acceleration. Much larger than the quantized model.',
        files: [
            modelFile(CLIP_REPO, 'config.json', 4524, '493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495'),
            modelFile(CLIP_REPO, 'preprocessor_config.json', 520, '6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f'),
            modelFile(CLIP_REPO, 'special_tokens_map.json', 472, 'c4864a9376a8401918425bed71fc14fc0e81f9b59ec45c1cf96cccb2df508eac'),
            modelFile(CLIP_REPO, 'tokenizer.json', 2224119, 'f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd'),
            modelFile(CLIP_REPO, 'tokenizer_config.json', 775, '60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967'),
            modelFile(CLIP_REPO, 'vocab.json', 862328, '5047b556ce86ccaf6aa22b3ffccfc52d391ea4accdab9c2f2407da5b742d4363'),
            modelFile(CLIP_REPO, 'merges.txt', 524619, '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a'),
            modelFile(CLIP_REPO, 'onnx/model_fp16.onnx', 303515168, 'b33a72860c26713ff564d36a162be4e968ee1e50b2418f449076c067735d4fab'),
        ],
    },
    {
        id: 'vit-gpt2-image-captioning',
        name: 'ViT-GPT2 Captioning',
        task: 'captioning',
        description: 'Image captioning with a ViT encoder and GPT-2 decoder (quantized ONNX).',
        files: [
            modelFile(CAPTION_REPO, 'config.json', 4888, 'f65c81039a672962d686f71ee0242f0c89dc020a0e3f193a989a696bf3f9515e'),
            modelFile(CAPTION_REPO, 'generation_config.json', 184, '997e1f943576edcc46e1b93078ec0e72054a62b4c7f521da42a1eab43c4c1d0c'),
            modelFile(CAPTION_REPO, 'preprocessor_config.json', 378, '76304e9a1deb0d5f78349a57ad9d8057f36476c29bd292e907e2e8c451c93e9d'),
            modelFile(CAPTION_REPO, 'special_tokens_map.json', 131, '8bcf4e58d0970bbcb3b111a4c1e297c082fbf61253b14b3c0c8f2972ccb61ba4'),
            modelFile(CAPTION_REPO, 'tokenizer.json', 2107928, '6e785cd4f004c9291dadeba7d8d1c2871318d368a1cfcd416c0571dcd8f11413'),
            modelFile(CAPTION_REPO, 'tokenizer_config.json', 456, '5b477c376e81670409e943fc7c8233a0356c8488e05a8aa246082a1d29e8d609'),
            modelFile(CAPTION_REPO, 'vocab.json', 798156, '3ba3c3109ff33976c4bd966589c11ee14fcaa1f4c9e5e154c2ed7f99d80709e7'),
            modelFile(CAPTION_REPO, 'merges.txt', 456318, '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5'),
            modelFile(CAPTION_REPO, 'onnx/encoder_model_quantized.onnx', 87453213, '6f6e2e27c11303cf533682184543333e7ecb930a734197a0272a1e408aba2766'),
            modelFile(CAPTION_REPO, 'onnx/decoder_model_merged_quantized.onnx', 158599996, '1f3ec53b5fc3614c0b54ee786755a7ec3007841f57543f8e241499edfadfa98f'),
        ],
    },
    {
        id: 'vit-gpt2-image-captioning-fp16',
        name: 'ViT-GPT2 Captioning · FP16',
        task: 'captioning',
        description: 'FP16 ONNX (unsupported: onnxruntime 1.30 rejects decoder_model_merged_fp16.onnx).',
        broken: true,
        files: [
            modelFile(CAPTION_REPO, 'config.json', 4888, 'f65c81039a672962d686f71ee0242f0c89dc020a0e3f193a989a696bf3f9515e'),
            modelFile(CAPTION_REPO, 'generation_config.json', 184, '997e1f943576edcc46e1b93078ec0e72054a62b4c7f521da42a1eab43c4c1d0c'),
            modelFile(CAPTION_REPO, 'preprocessor_config.json', 378, '76304e9a1deb0d5f78349a57ad9d8057f36476c29bd292e907e2e8c451c93e9d'),
            modelFile(CAPTION_REPO, 'special_tokens_map.json', 131, '8bcf4e58d0970bbcb3b111a4c1e297c082fbf61253b14b3c0c8f2972ccb61ba4'),
            modelFile(CAPTION_REPO, 'tokenizer.json', 2107928, '6e785cd4f004c9291dadeba7d8d1c2871318d368a1cfcd416c0571dcd8f11413'),
            modelFile(CAPTION_REPO, 'tokenizer_config.json', 456, '5b477c376e81670409e943fc7c8233a0356c8488e05a8aa246082a1d29e8d609'),
            modelFile(CAPTION_REPO, 'vocab.json', 798156, '3ba3c3109ff33976c4bd966589c11ee14fcaa1f4c9e5e154c2ed7f99d80709e7'),
            modelFile(CAPTION_REPO, 'merges.txt', 456318, '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5'),
            modelFile(CAPTION_REPO, 'onnx/encoder_model_fp16.onnx', 171924680, 'f2197ca11cce09e3aca7bc3d83add32aa6757ab89fc51bd25c7dd106b9a0a38e'),
            modelFile(CAPTION_REPO, 'onnx/decoder_model_merged_fp16.onnx', 310011756, '0d5ffdf9190725d690daaea157ad320df72eeafead50cf943b7ceb70873d37d2'),
        ],
    },
];

export function findModelDefinition(id: string): ModelDefinition | undefined {
    return MODEL_CATALOG.find(model => model.id === id);
}
