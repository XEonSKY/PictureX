# 任务与 SSE API

读完你能聚合导入/模型下载/AI 任务，并通过单条 SSE 订阅所有进度。

导入与 AI 任务集中存在 `<dataDir>/data/task.db`（带 `album_id` 归属），因此任务页聚合不再逐个打开
相册的 `picture.db`；模型下载任务仍来自 `.download/index.json`。

## GET /jobs

| 参数 | 说明 |
|---|---|
| `type` | `import` / `download` / `ai`，缺省返回全部 |
| `limit` | 1–200，默认 50 |
| `albumId` | 只返回该相册的导入/AI 任务；不包含模型下载，也不会打开任何相册数据库 |

导入/AI 任务按 `updatedAt` 倒序**跨相册**取最近 `limit` 条（不再逐相册各取 20 条），
再与模型下载合并排序。传 `type` 时只读对应任务表，`limit` 即该类型的条数上限。
返回 `{ "data": JobView[] }`，三种形状：

### 导入任务

```json
{
    "type": "import",
    "albumId": "01a1...",
    "albumName": "2026 旅行",
    "id": "01a167eb-b0d3...",
    "rootPath": "D:/Photos/2026",
    "status": "running",
    "total": 100,
    "processed": 40,
    "added": 36,
    "duplicates": 3,
    "skipped": 0,
    "errors": 1,
    "cursor": "sub/dir/IMG_0040.jpg",
    "startedAt": "...",
    "updatedAt": "...",
    "finishedAt": null
}
```

### 模型下载

```json
{
    "type": "download",
    "modelId": "clip-vit-base-patch32",
    "name": "CLIP ViT-B/32",
    "status": "downloading",
    "totalBytes": 612000000,
    "bytesDone": 120000000,
    "speedBps": 8400000,
    "updatedAt": "...",
    "error": null
}
```

### AI 任务

```json
{
    "type": "ai",
    "albumId": "01a1...",
    "albumName": "2026 旅行",
    "id": "01a2...",
    "mode": "zero-shot",
    "status": "running",
    "total": 50,
    "processed": 12,
    "errors": 0,
    "startedAt": "...",
    "updatedAt": "...",
    "finishedAt": null
}
```

## GET /jobs/disk

程序内的磁盘活动清单：回答「现在哪些功能正在读写磁盘、大概到哪了」。全部状态来自内存与
任务库，**不打开任何相册 SQLite、不采集操作系统 IO 计数**（Windows 下逐进程 IO 需要额外权限
且开销大），所以这里的数字是进度，不是吞吐量。崩溃恢复的断点归一化（把残留 `running`
改成 `paused`）最多每 10 秒执行一次，轮询本身不会对每个相册重复跑探测 UPDATE。

```json
{
    "data": {
        "updatedAt": "2026-10-28T12:00:00.000Z",
        "thumbnails": {
            "interactiveActive": 2,
            "interactivePending": 5,
            "backgroundActive": 1,
            "backgroundPending": 0,
            "interactiveConcurrency": 2,
            "ewmaMs": 48
        },
        "items": [
            {
                "id": "import:01a2...",
                "kind": "import",
                "touch": "reading-writing",
                "albumId": "01a1...",
                "albumName": "2026 旅行",
                "done": 1200,
                "total": 5000,
                "queued": 0,
                "paused": false
            }
        ]
    }
}
```

| 字段 | 说明 |
|---|---|
| `kind` | `import` / `ai` / `thumbnail` / `warmup` / `similarity` / `maintenance` / `pixiv` / `model` |
| `touch` | `reading`（读原图）/ `writing`（写库或写文件）/ `reading-writing` |
| `done` / `total` | 进度；无法量化时为 `null` |
| `queued` | 排队中、还没开始读写的项目数 |
| `thumbnails` | 交互/后台解码队列实时形态，`interactiveConcurrency` 按最近生成耗时的 EWMA 动态调整 |

任务页每 2.5 秒轮询一次；没有活动项时列表为空。

## GET /jobs/events

SSE 推送；可带 `?albumId=<id>` 只订阅该相册的导入/AI 事件（模型下载事件被忽略）。

SSE：

```
event: snapshot
data: [JobView, ...]

event: job
data: {"type":"import","jobId":"...","status":"running",...}
event: job
data: {"type":"download","modelId":"clip...","status":"downloading",...}
event: job
data: {"type":"ai","jobId":"...","status":"running",...}

event: ping
data: 1761200000000
```

- `snapshot` 在连接建立时发送一次。
- 下载进度按模型 250ms 节流；导入在每 10 个文件或 1 秒时发布。
- 每 15 秒发送 `ping`；客户端断开自动取消订阅。
- 响应带 `cache-control: no-cache, no-transform` 与 `x-accel-buffering: no`，避免代理缓冲进度。

## 错误

| status | code |
|---|---|
| 422 | `validation_failed` |
| 500 | `internal_error` |
