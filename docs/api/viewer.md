# 散图库 API

散图库（`/library`）只保存桌面「打开方式」查看器打开过的**离散图片/视频**记录，写入
`<dataDir>/data/picture.db` 与 `<dataDir>/data/tag.db`。相册资产与相册标签不会聚合到数据目录，
只在各自相册的 `data/picture.db` / `data/tag.db` 中维护；相册缩略图缓存仍按相册放在数据根目录以加速加载。

> 所有记录/关联都以内容哈希为键，**不按文件路径关联**——同一张图改名字或移动位置后重开，
> 仍会命中同一条记录。路径只作为查看器的便捷字段保存。

全局库 `PRAGMA user_version` 当前为 `4`；表结构只保留查看器需要的列。

## 全局标签

### GET /viewer/tags

返回散图标签（查看器手动创建/打标），带关联散图数量：

```json
{
    "data": [
        { "id": "01a1...", "name": "收藏", "color": "", "count": 12 },
        { "id": "01a2...", "name": "风景", "color": "#aabbcc", "count": 193 }
    ]
}
```

标签只包含散图标签；相册标签与 Pixiv 作品标签都不进入这里。

### POST /viewer/tags

新建标签，`name` 去空白、大小写不敏感去重，重名返回 `409 tag_name_conflict`。创建成功返回 201。

### PATCH /viewer/tags/:tagId

改名或改色；标签不存在返回 `404 tag_not_found`。全局标签互相独立，不会从相册重新生成。

### DELETE /viewer/tags/:tagId

删除标签，并清理全局库中指向它的媒体关联（`viewer_media_tags`）。成功返回 204。

### POST /viewer/tags/batch-delete

```json
{ "ids": ["01a1...", "01a2..."] }
```

批量删除，返回 `{ "data": { "removed": 2 } }`。

### GET /viewer/tags/export

下载全局标签 JSON（`attachment; filename="picturex-global-tags.json"`）：

```json
{
    "schemaVersion": 1,
    "exportedAt": "...",
    "library": { "scope": "global" },
    "tags": [
        { "id": "01a1...", "name": "收藏", "color": "", "count": 12 }
    ]
}
```

### POST /viewer/tags/import

```json
{
    "tags": [
        { "name": "旅行", "color": "#aabbcc" },
        { "name": "收藏" }
    ]
}
```

按名称大小写不敏感去重，已存在或空名称计入 `skipped`；返回
`{ "data": { "added": 1, "skipped": 1 } }`。导入文件可直接使用导出结果。

### POST /viewer/tags/colors

```json
{ "mode": "auto", "onlyEmpty": true }
```

`auto` 按名称稳定取色，`random` 从调色板随机取色；返回
`{ "data": { "updated": 10, "tags": [...] } }`。

### POST /viewer/tags/merge

```json
{ "sourceIds": ["01a1..."], "targetId": "01a2..." }
```

把来源标签的媒体关联迁移到目标（重复关联自动跳过）后删除来源；返回
`{ "data": { "removed": 1, "moved": 24 } }`。

### POST /viewer/tags/delete-all

```json
{ "confirm": true }
```

清空散图标签与关联，返回 `{ "data": { "removed": 153 } }`。相册标签不受影响。

## 媒体记录

### POST /viewer/media

登记一张刚被打开的图片/视频（upsert，按 `sha256` 合并）：

```json
{
    "sha256": "<64 位十六进制>",
    "kind": "image",
    "mime": "image/jpeg",
    "filename": "beach.jpg",
    "lastPath": "G:\\photos\\beach.jpg",
    "size": 282541,
    "width": 2048,
    "height": 1571
}
```

返回当前记录及其已关联的 `tagIds`：

```json
{
    "data": {
        "sha256": "...", "kind": "image", "mime": "image/jpeg", "filename": "beach.jpg",
        "lastPath": "...", "size": 282541, "width": 2048, "height": 1571, "durationMs": null,
        "addedAt": "...", "updatedAt": "...", "tagIds": ["01a1..."]
    }
}
```

`sha256` 非法（非 64 位十六进制）返回 `422`。`width`/`height`/`durationMs` 可缺省，
前端在解码出真实尺寸后可再次 `POST /viewer/media` 回填（不会丢标签）。

### GET /viewer/media

全局图库列表，keyset 分页：

| 参数 | 说明 |
| --- | --- |
| `limit` | 1–500，默认 100 |
| `cursor` | 上一页的 `nextCursor`；非法返回 `422` |
| `tagId` | 只返回带该全局标签的媒体 |

```json
{
    "data": [
        {
            "sha256": "...", "kind": "image", "mime": "image/jpeg", "filename": "beach.jpg",
            "size": 282541, "width": 2048, "height": 1571, "durationMs": null,
            "addedAt": "...", "tagIds": ["01a1..."]
        }
    ],
    "total": 25850,
    "pagination": { "limit": 100, "nextCursor": "...", "hasMore": true }
}
```

`total` 始终是**当前过滤条件**下的总数，不随 `cursor` 递减。列表按 `(addedAt, sha256)` 倒序，
`addedAt` 是该散图首次被查看器登记的时间。全局图库只包含散图，DTO 不再有相册来源字段
（`lastPath`/`updatedAt` 只在单条记录接口返回，列表不返回）。

### GET /viewer/media/:sha256

返回单条记录 + `tagIds`；不存在时 `data` 为 `null`（不报错）。`sha256` 非法返回 `422`。

### PATCH /viewer/media/:sha256/tags

整组替换该媒体标签：

```json
{ "tagIds": ["01a1...", "01a2..."] }
```

- 含未知标签 id → `404 tag_not_found`；
- 该媒体尚未登记 → `404 viewer_media_not_found`；
- 成功返回 `{ "data": { "tagIds": [...] } }`（去重后的集合）。

### DELETE /viewer/media/:sha256

从全局库移除该记录与关联（**不删除磁盘文件**）。成功 204。

## 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `validation_failed` | 422 | 参数/哈希格式不合法 |
| `tag_not_found` | 404 | 标签不存在 |
| `tag_name_conflict` | 409 | 同名标签已存在 |
| `viewer_media_not_found` | 404 | 全局库里没有这条媒体记录 |
| `tag_file_corrupt` | 500 | 全局标签库不可用；需恢复备份后再编辑 |
