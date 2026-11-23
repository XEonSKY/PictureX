# 标签 API

读完你能管理相册标签，并理解 `tag.db` 与关联表的边界。标签库不可用时只读接口降级为空，
写接口返回 `500 tag_file_corrupt`。

## GET /albums/:albumId/tags

返回标签及引用数量（来自 `picture.db.asset_tags`）：

```json
{
    "data": [
        {
            "id": "01a167ec-68d3-713e-873f-67275e908628",
            "name": "风景",
            "color": "#0A59F7",
            "createdAt": "2026-10-23T08:41:49.011Z",
            "count": 1
        }
    ]
}
```

## GET /albums/:albumId/tags/export

批量导出标签：响应带 `Content-Disposition: attachment`，直接下载 `<albumId>-tags.json`
（另有 UTF-8 文件名 `<相册名>-tags.json`）：

```json
{
    "schemaVersion": 1,
    "album": { "id": "01a1...", "name": "旅行" },
    "exportedAt": "2026-10-24T08:00:00.000Z",
    "tags": [
        { "id": "01a1...", "name": "风景", "color": "#0A59F7", "createdAt": "...", "count": 1 }
    ]
}
```

## POST /albums/:albumId/tags

```json
{ "name": "风景", "color": "#0A59F7" }
```

- `name` 1–120 字符，大小写不敏感去重。
- `color` 可省略或为空；否则为 3–8 位十六进制（可带 `#`）。
- 响应 `201` + `Location`。

## POST /albums/:albumId/tags/import

从本应用导出的 JSON 或任意 `{ "tags": [...] }` 导入标签：

```json
{
    "tags": [
        { "name": "风景", "color": "#0A59F7" },
        { "name": "旅行" }
    ]
}
```

- 最多 500 条；按名称（大小写不敏感）去重，已存在的标签跳过，不覆盖颜色。
- 响应 `200`：`{ "data": { "added": 1, "skipped": 1 } }`。
- 导入的标签 `id` 由服务端重新生成，导出文件里的 `id/count` 会被忽略。

## POST /albums/:albumId/tags/batch-delete

```json
{ "ids": ["01a1...", "01a2..."] }
```

删除多个标签并清理 `asset_tags` 关联，响应 `200`：`{ "data": { "removed": 2 } }`。

## POST /albums/:albumId/tags/merge

```json
{ "sourceIds": ["01a1...", "01a2..."], "targetId": "01a3..." }
```

把来源标签的资产关联合并到目标标签（同一资产重复关联自动去重），然后删除来源标签。
响应 `200`：`{ "data": { "removed": 2, "moved": 37 } }`，`moved` 是实际迁移的关联数。

## POST /albums/:albumId/tags/colors

```json
{ "mode": "auto", "onlyEmpty": true }
```

`mode` 为 `auto`（按名称稳定取色）或 `random`；`onlyEmpty` 默认 `true`，只填充没有颜色的标签。
响应 `200`：`{ "data": { "updated": 3, "tags": [...] } }`。

## POST /albums/:albumId/tags/delete-all

```json
{ "confirm": true }
```

删除该相册全部标签与 `asset_tags` 关联，必须显式确认。
响应 `200`：`{ "data": { "removed": 12 } }`。

## PATCH /albums/:albumId/tags/:tagId

```json
{ "name": "旅行", "color": "" }
```

字段可省略。重名返回 `409 tag_name_conflict`。

## DELETE /albums/:albumId/tags/:tagId

删除 `tag.db` 中的标签与所有资产关联，响应 `204`。

## 关联

- `POST /albums/:albumId/assets/:assetId/tags` body `{ "tagId": "..." }`
- `DELETE /albums/:albumId/assets/:assetId/tags/:tagId`

关联写入 `picture.db.asset_tags`，标签主数据始终在 `tag.db`。

## 错误

| status | code |
|---|---|
| 404 | `album_not_found` / `tag_not_found` / `asset_not_found` |
| 409 | `tag_name_conflict` |
| 422 | `validation_failed` |
