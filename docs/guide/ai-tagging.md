# AI 打标

读完你能选择零样本/生成式/外部三种打标方式，理解结果如何落库，以及如何开启自动打标。

## 三种模式

| 模式 | 模型 | 行为 |
|---|---|---|
| `zero-shot` | CLIP（`clip-vit-base-patch32`） | 对候选标签集做零样本分类，取 top-5 |
| `generative` | ViT-GPT2（`vit-gpt2-image-captioning`） | 生成一句描述，抽关键词作为标签，描述写入 `meta.ai.caption` |
| `external` | OpenAI 兼容接口 | 发送图片 data URL，要求返回 JSON 标签数组；失败自动降级到本地 CLIP（若已安装） |

内置候选集在 `server/ai/labels.ts`，共 20 个：landscape、portrait、people、animal、pet、
food、architecture、vehicle、document、screenshot、artwork、nature、city、night scene、
beach、mountain、flower、sky、water、indoor。实际候选 = 相册已有标签（按使用频率取前 64 个）
+ 内置候选合并去重，已有标签优先占 64 上限。一次打标可以给同一张图落**多个**标签：
`asset_tags` 是 `(asset_id, tag_id)` 复合主键的多对多表，top-5 结果里超过
`max(0.05, topScore × 0.2)` 阈值的标签都会建立关联。

实测（`clip-vit-base-patch32` 量化模型，本机 CPU 推理）：

| 图片 | 落库标签 |
|---|---|
| 猫 | animal 0.22、portrait 0.18、pet 0.18、food 0.11、indoor 0.07 |
| 夜景城市 | city 0.42、night scene 0.28、landscape 0.08、architecture 0.08 |
| 山湖 | mountain 0.46、nature 0.23、landscape 0.15 |
| 拉面 | food 0.76 |

生成式（`vit-gpt2-image-captioning`）同一张猫图得到描述
`a cat sitting on a wooden table`，抽词后追加 sitting / wooden / table。

## 前置条件

- 本地模式：在「设置 → 模型管理」（`/settings/models`）下载对应模型，状态为 `installed`。
- 外部模式：「设置 → AI 打标」的 `ai.external` 配置 `enabled/baseUrl/apiKey/model`。
  `baseUrl` 保存时只允许 `https://`，`http://` 仅限 `localhost`/`127.0.0.1`/`::1` 回环——外部模式会把
  API Key 和整张图片的 base64（≤8 MiB）发往该地址，非回环明文 HTTP 会被拒绝（422）。

## 硬件加速

`setting.json` 的 `ai.device` 支持 `auto` / `cpu` / `gpu`，默认 `auto`；其它值会被拒绝。
可选执行后端以 `onnxruntime-node` 实际编译进二进制的 EP 为准，可用
`GET /settings/ai/devices` 查询。回退等级是 **GPU > CPU**，GPU 内部优先 CUDA：

| 顺序 | 后端 | 平台 / 硬件 |
|---|---|---|
| 1 | CUDA | Linux x64 + NVIDIA 驱动与 CUDA/cuDNN |
| 2 | DirectML | Windows DX12 GPU（NVIDIA / AMD / Intel 核显） |
| 3 | ROCm / MIGraphX | Linux AMD（运行库提供时） |
| 4 | OpenVINO | Intel GPU（运行库提供时） |
| 5 | Core ML | macOS GPU |
| 6 | WebGPU | 运行库提供且适配器可用时 |
| 7 | CPU | 始终可用，兜底 |

- **加速必须用 FP16 模型**：在「模型管理」下载 `clip-vit-base-patch32-fp16`（约 293 MB），
  模型下拉里可直接选择它；CPU 继续使用量化 `q8` 模型。
- `vit-gpt2-image-captioning-fp16` 与自带 ONNX Runtime 1.30 不兼容（merged decoder 非法），
  已标记为 `broken`，不能下载或选择。
- 未安装 FP16 模型、EP 不可用、会话创建失败或推理失败时自动回退 CPU；
  实际使用的设备写入 `assets.meta.ai.device`。
- 零样本打标把相册 `tag.db` 里**已有标签**（按 `asset_tags` 使用频率取前 64 个）与内置候选
  合并去重，已有标签优先占 64 上限；这样新图片会复用你已有的标签体系，同时保留基础主题词。
- 打标按 4 路并发推理、串行写库，新建标签按批写入 `tag.db`。
- 本机实测（RTX 3050 / DirectML，20 个内置候选标签）：CLIP FP16 + DML 约 50 ms/张，
  q8 CPU 约 89 ms/张。量化模型在 DML 上反而更慢（约 291 ms），因此不用于加速。

## 落库

每次打标：

1. 将标签写入 `tag.db`（不存在则创建，名称大小写不敏感去重）。
2. 在 `picture.db.asset_tags` 建立关联。
3. 写入 `assets.meta.ai`：

```json
{
    "ai": {
        "mode": "zero-shot",
        "modelId": "clip-vit-base-patch32",
        "device": "cpu",
        "labels": [
            { "name": "animal", "score": 0.22 },
            { "name": "portrait", "score": 0.18 },
            { "name": "pet", "score": 0.18 }
        ],
        "caption": null,
        "taggedAt": "2026-10-23T09:12:00.000Z"
    }
}
```

同一张图分别用两种模式打标时，`meta.ai.mode` 会记录最后一次模式的真实值。

## API

```bash
curl -X POST http://localhost:3000/api/v1/albums/<albumId>/ai/tag \
  -H 'content-type: application/json' \
  -d '{"mode":"zero-shot","limit":50}'
```

响应 `202`，返回 AI 任务（`running`）。任务进度通过 `/jobs/events` SSE 推送，
也可 `GET /albums/:albumId/ai/jobs` 查看历史。

请求字段：

| 字段 | 说明 |
|---|---|
| `mode` | `zero-shot` / `generative` / `external`，缺省用 `ai.labelMode` |
| `assetIds` | 最多 500 个资产 ID；不传则按入库时间倒序取 `limit` 个 |
| `limit` | 批量上限（1–1,000,000）；不传时打标相册内全部资产 |

同一相册同时只能有一个 AI 任务，重复启动返回 409 `ai_already_running`。

## 任务状态

`ai_jobs` 记录 `total / processed / errors / error`：

- 个别图片失败：状态仍是 `completed`，`errors` 计数累加，日志里逐张 `warn`。
- 全部图片失败（模型缺失、推理异常等链路问题）：状态直接是 `failed`，
  并把第一条错误写进 `ai_jobs.error`，不允许报成完成掩盖问题。

## 自动打标

`setting.json.ai.autoTag = true` 时，导入完成后对本次新增资产后台启动
AI 任务。打标失败不影响已入库的文件与缩略图；但按上面的规则，全量失败的任务会显示为 `failed`。

## 外部接口

- 端点：`<baseUrl>/chat/completions`（若 `baseUrl` 已以 `/chat/completions` 结尾则不再拼接）。
- 超时 20 秒；429/5xx 重试一次（延迟 600ms）。
- 请求体包含 `image_url` data URL；图片超过 8 MiB 直接失败。
- 仍失败时：若配置的本地零样本模型已安装，则降级到 CLIP；否则抛
  `502 ai_external_failed`。

## 错误码

| code | 场景 |
|---|---|
| `ai_model_missing` | 本地模型未安装 |
| `ai_external_disabled` | 外部接口未启用或配置不全 |
| `ai_external_failed` | 外部接口失败且没有可用的本地降级 |
| `ai_already_running` | 同相册已有 AI 任务 |
