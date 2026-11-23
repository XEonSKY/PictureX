# 模型管理

读完你知道两份清单各自的职责、断点续传的落盘格式，以及跨盘安装与手动导入的做法。

## 双清单

### `models/index.json`（仓库清单）

只记录模型可用性与安装结果，**不记录下载进度**：

```json
{
    "schemaVersion": 1,
    "models": [
        {
            "id": "clip-vit-base-patch32",
            "name": "CLIP ViT-B/32",
            "task": "zero-shot",
            "status": "installed",
            "totalBytes": 157313059,
            "files": [
                {
                    "path": "onnx/model_quantized.onnx",
                    "url": "https://www.modelscope.cn/models/Xenova/clip-vit-base-patch32/resolve/master/onnx/model_quantized.onnx",
                    "size": 153695702,
                    "sha256": "0898a3facfdb27f0a041e57649b4989cfd094e4a0040d6ae75ed69917dfc7328"
                }
            ],
            "installedFiles": [
                { "path": "onnx/model_quantized.onnx", "size": 153695702, "sha256": "0898a3facf…" }
            ],
            "installedAt": "2026-10-23T09:00:00.000Z",
            "updatedAt": "2026-10-23T09:00:00.000Z",
            "error": null
        }
    ]
}
```

状态：`available`（可下载）、`installed`（已校验）、`corrupted`（校验失败）。
内置清单的每个文件都固定 `size` + `sha256`（取自源站清单接口），安装前逐文件校验；
新增条目漏填哈希会被 `apps/web/test/data-layer.test.ts` 里的清单用例拦住。

### `.download/index.json`（任务清单）

```json
{
    "schemaVersion": 1,
    "tasks": [
        {
            "modelId": "clip-vit-base-patch32",
            "status": "paused",
            "totalBytes": 157313059,
            "bytesDone": 128000000,
            "speedBps": 0,
            "files": [
                {
                    "path": "onnx/model_quantized.onnx",
                    "url": "https://www.modelscope.cn/...",
                    "size": 153695702,
                    "sha256": "0898a3facf…",
                    "bytesDone": 128000000,
                    "status": "downloading",
                    "etag": "\"abc\"",
                    "lastModified": "",
                    "shards": []
                }
            ],
            "createdAt": "2026-10-23T08:00:00.000Z",
            "updatedAt": "2026-10-23T08:05:00.000Z",
            "error": null
        }
    ]
}
```

落盘时会去掉 `shards`，分片进度只写对应的 `*.session.json`；
高频进度更新在内存中合并，约 800ms 节流写盘。

## 分片与续传

- 大文件按 4 MiB 切分，最多 32 片；`p-limit` 控制并发（`ai.downloadConcurrency`）。
- 数据写 `<dataDir>/.download/<modelId>/<path>.part`。
- 分片进度写 `<path>.session.json`：

```json
{
    "url": "https://www.modelscope.cn/...",
    "etag": "\"abc\"",
    "lastModified": "",
    "size": 153695702,
    "shards": [
        { "index": 0, "start": 0, "end": 4194303, "downloaded": 4194304 }
    ]
}
```

- 探测只用一次 `Range: bytes=0-0`，不再先发 `HEAD`：镜像对小文件走 gzip 传输，
  `HEAD` 的 `content-length` 是压缩后的字节数，只有 `206 + content-range` 的总长可信。
  拿不到可信长度时按整段下载，完成后用实际写入字节回填 `size`（进度实时累加，不会超过 100%）。
- 所有远端请求走 `fetchWithRetry`：网络错误或 5xx/429 最多 6 次指数退避（上限 15s）。
  undici 的连接超时固定 10s 且不可配置，而国内镜像冷握手经常超过它——实测 hf-mirror
  8 次连接里 5 次超时，重试比放大超时可靠。
- 继续时若 ETag/Last-Modified 与 session 不一致，视为服务端文件已变，
  删除 `.part` 并从头下载（`If-Range` 也会被服务端用来拒绝旧偏移，回 200 即整段重来）。
- 单分片请求带 `Range` + `If-Range`；若服务端回 `200` 而非 `206`，整个文件回退为全量下载。
- 暂停：不再派发新分片，等待在飞分片写完并落盘 session；5 秒宽限后中止。
- 取消：立即 abort 并删除 `.download/<modelId>/`。
- 安装：`.part` → 校验大小/SHA-256 → 复制到 `models/<modelId>/` → 删除下载临时文件。
  `rename` 在跨盘时会 `EXDEV`，因此使用「复制 → 校验 → 删除」。

## 下载源

内置清单默认走 **ModelScope**（同名的 `Xenova/*` 仓库，实测 ~10–28 MB/s，
约 150 MiB（157 MB）的 CLIP 量化模型总包约 30 秒装完）：

```bash
PX_MODEL_SOURCE=hf-mirror pnpm dev          # 回退 HF 镜像
PX_MODEL_MIRROR=https://huggingface.co pnpm dev  # 仅在 hf-mirror 源下生效，可再覆盖主机名
```

HF 侧镜像用 `PX_MODEL_MIRROR`（默认 `https://hf-mirror.com`）。
换源后清单里的 `size`/`sha256` 仍按同一份权校验，源站不一致会直接报 `corrupted` 而不是静默落盘。

## 手动导入

1. 把模型目录放到 `<modelsRoot>/<modelId>/`，保持与清单中的 `files[].path` 一致。
2. 在「设置 → 模型管理」（`/settings/models`）点击「重新校验」；校验通过后状态变为 `installed`。
3. 若模型不在内置清单，可在代码中通过 `ModelRegistry.importEntry()` 写入条目
   （用于内部工具或测试），或把模型纳入 `server/model/catalog.ts`。
   已从清单移除且本机没有文件的条目会在下次启动时自动清理，已安装的保留。

## 与推理的关系

`@huggingface/transformers` 的 `env.localModelPath` 指向 `modelsRoot`，并关闭远端模型加载，
所以 CLIP/ViT-GPT2 推理只读取本机已安装模型，不会在请求时偷偷下载。
CPU 加载时传 `dtype: 'q8'`（v4 已没有 `quantized` 参数），它会解析到 `*_quantized.onnx`：
CLIP 用合并图 `onnx/model_quantized.onnx`，描述模型用
`onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_quantized.onnx`。
清单里换成别的文件名会直接 `ModelFileNotFoundError`，因此改清单要和推理参数一起改。

硬件加速使用独立的 FP16 清单条目，目录名带 `-fp16` 后缀：

| 条目 | 权重文件 | 总量 |
|---|---|---|
| `clip-vit-base-patch32-fp16` | `onnx/model_fp16.onnx` | ~293 MB |
| `vit-gpt2-image-captioning-fp16` | `onnx/encoder_model_fp16.onnx` + `onnx/decoder_model_merged_fp16.onnx` | ~463 MB（**与 ONNX Runtime 1.30 不兼容，已禁用**） |

它们与量化模型分开下载、分开校验；FP16 模型被选中或启用加速时加载 `dtype: 'fp16'`，
CPU 仍用 q8。`vit-gpt2-image-captioning-fp16` 的 merged decoder 在本仓库自带的
onnxruntime 下加载失败，因此清单标记 `broken`，不允许下载或选择。
FP16 条目不是运行必需，只影响是否启用硬件加速。细节见
[AI 打标 · 硬件加速](./ai-tagging.md#硬件加速)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/models` | 清单 + 当前下载摘要 |
| POST | `/models/:id/download` | 开始/继续 |
| POST | `/models/:id/download/pause` | 暂停 |
| POST | `/models/:id/download/resume` | 继续 |
| POST | `/models/:id/download/cancel` | 取消并清理 |
| POST | `/models/:id/verify` | 重新校验 |
| DELETE | `/models/:id` | 删除模型文件 |
| GET | `/models/events` | SSE 快照与进度 |

错误码：`model_not_found`、`model_already_installed`、`model_unsupported`、
`download_not_found`、`download_not_running`。
