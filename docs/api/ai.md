# AI 打标 API

读完你能启动 AI 任务、查询历史，并理解模式与错误码。

## POST /albums/:albumId/ai/tag

```json
{
    "mode": "zero-shot",
    "assetIds": ["01a1...", "01a2..."],
    "limit": 200
}
```

| 字段 | 约束 |
|---|---|
| `mode` | `zero-shot` / `generative` / `external`，缺省用 `ai.labelMode` |
| `assetIds` | 可选，≤ 500 |
| `limit` | 可选；传了就只打标最近 N 张（1–1000000），**不传就是相册内全部资产** |

响应 `202`：

```json
{
    "data": {
        "id": "01a2...",
        "mode": "zero-shot",
        "status": "running",
        "total": 24,
        "processed": 0,
        "errors": 0,
        "error": null,
        "startedAt": "...",
        "updatedAt": "...",
        "finishedAt": null
    }
}
```

`Location: /api/v1/albums/<albumId>/ai/jobs/<jobId>`。

后台并发（4 路推理、串行写库）调用 tagger，写入：

- `tag.db`：缺失标签自动创建；新建标签每批落库一次。
- `picture.db.asset_tags`：关联。
- `assets.meta.ai`：`{ mode, modelId, device, labels, caption, taggedAt }`。

`zero-shot` 的候选标签 = 相册 `tag.db` 中已有标签（按使用频率前 64 个）+ 内置候选集，
合并去重，已有标签优先占 64 上限。

同一相册同时只能有一个 AI 任务。

## GET /albums/:albumId/ai/jobs

最近 50 个任务，结构同上。

## GET /albums/:albumId/ai/jobs/:jobId

单个任务。

## 暂停 / 恢复 / 取消

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/albums/:albumId/ai/jobs/:jobId/pause` | 当前这张跑完后置 `paused`，剩余资产保留在队列里 |
| POST | `/albums/:albumId/ai/jobs/:jobId/resume` | 继续剩余队列；进程重启后队列丢失，则挑选所有还没有 `meta.ai` 的资产继续 |
| POST | `/albums/:albumId/ai/jobs/:jobId/cancel` | 置 `cancelled` 并丢弃剩余队列，已暂停的任务也能取消 |

状态：`running` / `paused` / `completed` / `failed` / `cancelled`。
任务不在对应状态返回 `409 job_not_running`；进程崩溃残留的 `running` 在读取任务时归一化为 `paused`。

## DELETE /albums/:albumId/ai/jobs/:jobId

删除一条已结束的打标记录（`completed` / `failed` / `cancelled`），返回 `204`；
`running` / `paused` 返回 `409 job_not_finished`，需要先取消。删除只清记录，不动图片与标签。

## 进度

AI 任务通过 `/jobs/events` 推送：

```
event: job
data: {"type":"ai","albumId":"...","jobId":"...","status":"running","total":24,"processed":6,"errors":0}
```

## 错误

| status | code | 场景 |
|---|---|---|
| 404 | `album_not_found` / `ai_model_missing` / `job_not_found` | |
| 409 | `ai_already_running` | 同相册已有任务 |
| 422 | `ai_external_disabled` / `validation_failed` | 外部接口未配置 |
| 502 | `ai_external_failed` | 外部失败且无本地降级 |
