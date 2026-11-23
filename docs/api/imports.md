# 导入任务 API

读完你能启动、查询、暂停与续跑相册导入，并订阅 SSE 进度。
导入是单向复制：文件进入相册 `storage/` 后与源目录不再有关系，源文件不会被读取或修改。

## GET /albums/:albumId/imports

返回最近 50 个导入任务：

```json
{
    "data": [
        {
            "id": "01a167eb-b0d3-705b-b2fd-ffc2aff104b2",
            "rootPath": "D:/Photos/2026",
            "status": "completed",
            "cursor": null,
            "total": 4,
            "processed": 4,
            "added": 3,
            "duplicates": 1,
            "skipped": 0,
            "errors": 0,
            "error": null,
            "startedAt": "2026-10-23T08:41:01.907Z",
            "updatedAt": "2026-10-23T08:41:02.073Z",
            "finishedAt": "2026-10-23T08:41:02.073Z"
        }
    ]
}
```

## POST /albums/:albumId/imports

```json
{ "rootPath": "D:/Photos/2026", "resume": true }
```

- `rootPath` 必须存在且是目录，否则 `404 import_root_not_found`。
- 同相册已有运行中的导入返回 `409 import_already_running`。
- `resume` 默认 `true`：若存在同 root 的 `running/paused` 任务，从游标继续。
- 进程崩溃/重启后，读取任务列表或单任务时会把残留的 `running` 归一化为 `paused`
  （`error` 标记为 interrupted），前端显示「继续导入」即可断点续导。
- 响应 `202` + `Location: /api/v1/albums/<id>/imports/<jobId>`。

导入在后台执行；进度通过 SSE 或轮询获取。同一个文件内容只会入库一次，
其余副本只记录在 `duplicate_files` 中，**不会复制到相册，也不会被应用删除**。

## GET /albums/:albumId/imports/:jobId

返回单个任务。

## POST /albums/:albumId/imports/:jobId/pause

请求暂停；在飞文件处理完后状态变为 `paused`。任务未运行返回 `409 job_not_running`。
暂停时会把已入库的资产数写回 `index.json`，续导从游标继续。

## POST /albums/:albumId/imports/:jobId/cancel

取消导入。后台停止领取新文件，等在飞文件处理完后状态变为 `cancelled`，返回 `202`。
已暂停的任务会直接标记为 `cancelled`；已完成/失败的任务返回 `409 job_not_running`。
取消不可续跑，重新导入会创建新任务。

## POST /albums/:albumId/imports/:jobId/resume

用原 `rootPath` 续跑，返回 `202`。只有 `paused` 任务可以续跑；
`cancelled` / `completed` / `failed` 返回 `409 job_not_running`，需要重新导入。
同一相册已有导入在跑时返回 `409 import_already_running`。

## GET /albums/:albumId/imports/:jobId/events

SSE：

```
event: import
data: {"type":"import","albumId":"...","jobId":"...","status":"running","total":100,"processed":40,...}

event: ping
data: 1761200000000
```

每 15 秒发送一次 `ping`。客户端断开后自动取消订阅。

## DELETE /albums/:albumId/imports/:jobId

删除一条已结束的导入记录（`completed` / `failed` / `cancelled`），返回 `204`。
`running` / `paused` 仍可继续或取消，删除会返回 `409 job_not_finished`。
删除只清任务记录，不影响已入库的资产。

## 错误

| status | code |
|---|---|
| 404 | `album_not_found` / `import_not_found` / `import_root_not_found` |
| 409 | `import_already_running` / `job_not_running` / `job_not_finished` |
| 422 | `validation_failed` |
