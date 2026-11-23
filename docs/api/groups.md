# 重复与相似 API

读完你能读取重复组、相似组，并删除重复副本或批量清理资产。

## GET /albums/:albumId/groups/duplicates?limit=20

基于 `picture.db.duplicate_files`（SHA-256 相同但未复制的来源文件）。

```json
{
    "data": [
        {
            "key": "a6f50f4d...",
            "count": 3,
            "asset": { "id": "...", "filename": "blue-copy.jpg", "size": 3119 },
            "duplicates": [
                {
                    "id": "01a167ef-835c-75bb-971c-a783c8161a94",
                    "sourcePath": "D:/Photos/blue.jpg",
                    "filename": "blue.jpg",
                    "size": 3119,
                    "foundAt": "2026-10-23T08:45:12.412Z"
                }
            ]
        }
    ]
}
```

`count` = 已入库资产 1 + 来源副本数。

## POST /albums/:albumId/duplicates/cleanup

请求体必须带显式确认，避免网页跨站表单误触发不可逆删除：

```json
{ "confirm": true }
```

一键清理只删除 `duplicate_files` 记录，**不读取、移动或删除相册目录以外的任何文件**。
记录清空后分组随之消失；磁盘上的来源副本保持原样，需要释放空间时由用户在文件管理器中处理。

```json
{
    "data": { "groups": 12, "cleared": 20 }
}
```

- `groups`：本次涉及的 SHA-256 分组数。
- `cleared`：删除的记录条数。
- 该操作不可恢复记录，前端二次确认后才调用；想只清某一份用单条「移除记录」。

## POST /albums/:albumId/similarity/rebuild

```json
{ "threshold": 8 }
```

`threshold` 可省略（沿用相册设置或全局默认）。索引已新鲜时返回 `202 { rebuilding: false }`；
需要重建时后台启动并返回 `202 { rebuilding: true }`。相似度功能关闭时同样返回 `rebuilding: false`。

## GET /albums/:albumId/groups/similar?threshold=8&limit=20

| 参数 | 说明 |
|---|---|
| `threshold` | 0–64，缺省用相册级 `index.json.settings.similarityThreshold`，再回退全局 `similarity.hammingThreshold` |
| `limit` | 最多返回组数（1–100） |

```json
{
    "data": [
        {
            "id": "01a1-group",
            "representativeId": "01a1...",
            "maxDistance": 4,
            "assets": [
                { "id": "01a1...", "filename": "a.jpg", "distance": 0, "score": 1 },
                { "id": "01a2...", "filename": "b.jpg", "distance": 4, "score": 0.938 }
            ]
        }
    ],
    "meta": {
        "threshold": 8,
        "indexedThreshold": 8,
        "groups": 12,
        "pendingPhash": 0,
        "phashedCount": 7679,
        "assetCount": 7680,
        "rebuilding": false
    }
}
```

`id` 是分组主键，查看器用 `?from=similar&group=<id>` 在组内翻页。
`phashedCount / assetCount` 给前端的索引进度条用；`rebuilding=true` 时前端显示进度并自动轮询。

分组结果由后台相似度索引持久化在 `similar_groups` / `similar_group_items`，请求只读库。
阈值变化或有新资产时 `rebuilding=true`，后台重建完成后前端轮询即可拿到新结果。

## DELETE /albums/:albumId/duplicates/:duplicateId

- 只移除 `duplicate_files` 记录，**不删除磁盘文件**。
- 查询参数 `deleteFile` 不再生效（保留仅为兼容旧前端）。
- 响应 `204`（记录不存在也返回 204）。

## 删除资产

相似组的「保留最佳」与批量删除调用：

```http
DELETE /albums/:albumId/assets/:assetId
```

该操作把组内非保留项移入回收站（可恢复），不会立即删除磁盘文件；永久删除需在回收站执行。

## 错误

| status | code |
|---|---|
| 404 | `album_not_found` / `asset_not_found` |
| 422 | `validation_failed` |
