# 模型 API

读完你能查询模型清单、控制下载状态机并订阅进度。

## GET /models

```json
{
    "data": [
        {
            "id": "clip-vit-base-patch32",
            "name": "CLIP ViT-B/32",
            "task": "zero-shot",
            "status": "available",
            "totalBytes": 157313059,
            "files": [
                {
                    "path": "onnx/model_quantized.onnx",
                    "url": "https://www.modelscope.cn/models/Xenova/clip-vit-base-patch32/resolve/master/onnx/model_quantized.onnx",
                    "size": 153695702,
                    "sha256": "0898a3facfdb27f0a041e57649b4989cfd094e4a0040d6ae75ed69917dfc7328"
                }
            ],
            "installedFiles": [],
            "installedAt": null,
            "updatedAt": "2026-10-23T08:42:00.000Z",
            "error": null,
            "download": null
        }
    ]
}
```

`download` 为当前任务摘要（`status/bytesDone/totalBytes/speedBps/updatedAt/error`）或 `null`。

## GET /models/:modelId

单个模型，结构同上。

## POST /models/:modelId/download

开始或继续下载，`202`，返回 `DownloadTask`：

```json
{
    "data": {
        "modelId": "clip-vit-base-patch32",
        "status": "downloading",
        "totalBytes": 157313059,
        "bytesDone": 0,
        "speedBps": 0,
        "files": [
            {
                "path": "onnx/model_quantized.onnx",
                "size": 153695702,
                "bytesDone": 0,
                "status": "pending",
                "shards": []
            }
        ],
        "createdAt": "...",
        "updatedAt": "...",
        "error": null
    }
}
```

## POST /models/:modelId/download/pause | resume | cancel

- `pause`：等待在飞分片后置为 `paused`。
- `resume`：从 `.part` + `.session.json` 继续。
- `cancel`：中止并删除 `.download/<modelId>/`。

均返回 `{ "data": DownloadTask }`。

## POST /models/:modelId/verify

重新校验已安装文件（大小/可选 SHA-256），返回更新后的模型。

## DELETE /models/:modelId

若正在下载则先取消；删除模型目录，状态回到 `available`，响应 `204`。

`:modelId` 必须是单个安全路径段（`^[a-z0-9][a-z0-9._-]{0,63}$`）。GET / DELETE / verify / download
对畸形或含 `../` 遍历的 id 一律返回 404 `model_not_found`，删除前先经此校验，绝不 `rmSync` 越出
`modelsRoot`。

## POST /models/cleanup

批量删除不再需要的已安装模型，避免磁盘长期占用：

```json
{ "confirm": true, "mode": "unused" }
```

- `mode: "unused"`（默认）：删除所有已安装但未被 `ai.localModelId` / `ai.captioningModelId` 引用的模型；
- `mode: "broken"`：只删除 `broken` 或 `corrupted` 的模型。

引用按引用组判断：基础模型与对应的 `<modelId>-fp16` 加速条目互相保护，
启用 `clip-vit-base-patch32` 时它的 fp16 加速条目不会被 `unused` 删除。

正在使用或正在下载/暂停中的模型会写入 `skipped` 并保留：

```json
{ "data": { "removed": ["vit-gpt2-image-captioning"], "skipped": [] } }
```

## GET /models/events

SSE：

```
event: snapshot
data: [{"type":"download","modelId":"clip...","status":"paused",...}]

event: download
data: {"type":"download","modelId":"clip...","status":"downloading","bytesDone":...,"speedBps":...}

event: ping
data: ...
```

进度事件按模型 250ms 节流。

## 错误

| status | code |
|---|---|
| 404 | `model_not_found` / `download_not_found` |
| 409 | `model_already_installed` / `model_unsupported` / `download_not_running` |
| 500 | `internal_error` |
