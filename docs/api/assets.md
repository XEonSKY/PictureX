# 资产 API

读完你能分页浏览相册资产、读取详情、获取原文件/缩略图，并维护资产标签。

## GET /albums/:albumId/assets

Keyset 分页：

| 参数 | 说明 |
|---|---|
| `limit` | 1–500，默认 60（矩阵视图一页取 500） |
| `cursor` | 上一页返回的 `nextCursor` |
| `sort` | `addedAt`（默认）/ `takenAt` / `filename` / `pixivId`（作品 ID 数值降序）；启用 Pixiv 且用户未保存排序时默认 `pixivId` |
| `order` | `desc`（默认）/ `asc` |
| `kind` | `image` / `gif` / `dynamic` / `svg` / `video` |
| `tagId` | 按相册标签过滤 |
| `pixivTag` | 按 Pixiv 标签 ID 过滤（启用 Pixiv 的相册） |
| `q` | 搜索（≤ 200）：文件名、标签名、AI 描述；启用 Pixiv 的相册还匹配作品标题/ID、画师与 Pixiv 标签。≥3 字符走 FTS5 trigram，更短退回 LIKE |
| `trash` | `true` 时只返回回收站资产 |
| `favorite` | `true` 时只返回收藏 |

```json
{
    "data": [
        {
            "id": "01a167eb-b151-709e-ad3b-691e7e5b03e6",
            "filename": "vector.svg",
            "ext": "svg",
            "mime": "image/svg+xml",
            "kind": "svg",
            "size": 115,
            "width": 200,
            "height": 100,
            "durationMs": null,
            "takenAt": null,
            "addedAt": "2026-10-23T08:41:02.039Z"
        }
    ],
    "pagination": { "limit": 60, "nextCursor": null, "hasMore": false }
}
```

`cursor` 为 base64url 编码的 `[sortValue, id]`，请原样回传。列表 DTO 不含
`sha256`/`phash`，需要哈希时读取详情。

## GET /albums/:albumId/assets/:assetId

返回详情，额外包含 `storageKey`、`sha256`、`phash`、`meta`、`tags`，
以及 Live Photo 的 `live: { mime, size } | null`。

在列表字段基础上增加：

```json
{
    "data": {
        "id": "...",
        "storageKey": "storage/0001/<uuidv7>.jpg",
        "meta": { "format": "jpeg", "colorSpace": "srgb", "ai": { "mode": "zero-shot" } },
        "tags": [
            { "id": "...", "name": "风景", "color": "#0A59F7", "createdAt": "..." }
        ]
    }
}
```

## GET /albums/:albumId/assets/:assetId/neighbors

查看器的上一张 / 下一张。默认按 `addedAt desc`，可传与照片列表一致的
`sort/order/kind/tagId/pixivTag/q/favorite`，翻页严格跟随当前列表；同一 Pixiv 作品的本地分P
按 `page_index` 连续，跨作品时回到分P组前后的列表项。`span=1–500` 额外返回前后各最多 N 张，
供详情页做本地连续切换与预载（默认 1；前端取 250，预载前后各 15 张缩略图、各 3 张原图，
原图串行预载以避免机械硬盘并发寻道）：

```json
{
    "data": {
        "scope": "album",
        "previous": { "id": "...", "filename": "a.jpg" },
        "next": { "id": "...", "filename": "c.jpg" },
        "previousItems": [{ "id": "...", "filename": "a.jpg" }],
        "nextItems": [{ "id": "...", "filename": "c.jpg" }],
        "index": 1,
        "total": 7680
    }
}
```

| 查询参数 | 说明 |
|---|---|
| `from=similar` + `group=<groupId>` | 在相似组内切换：按代表图在前、距离升序，`scope` 变为 `similar` |

资产不在该组时回退为相册顺序。响应中 `previous` / `next` 可能为 `null`（到头）。

## PATCH /albums/:albumId/assets/:assetId

重命名展示用文件名（不改存储键与扩展名，缺扩展名时自动补上）：

```json
{ "filename": "封面.jpg" }
```

含路径分隔符、控制字符或超过 200 字符返回 `422 validation_failed`。
请求体也可只传 `{ "favorite": true }` 切换收藏。

## PATCH /albums/:albumId/assets

批量重命名，按 `ids` 顺序编号：

```json
{ "ids": ["..."], "prefix": "IMG_", "start": 1, "padding": 3 }
```

得到 `IMG_001.jpg`、`IMG_002.jpg`……扩展名各自保留；`ids` 里不存在的资产会被忽略，
全部不存在返回 `404 asset_not_found`。

## POST /albums/:albumId/assets/batch-delete

批量移入回收站（软删除），请求体必须带确认：

```json
{ "ids": ["..."], "confirm": true }
```

返回 `{ "data": { "removed": 2 } }`。一次事务改多行，最后只对账一次 `index.json`。

## POST /albums/:albumId/assets/batch-restore

从回收站批量恢复：`{ "ids": ["..."] }` → `{ "data": { "restored": 2 } }`。

## POST /albums/:albumId/assets/batch-tags

给多张资产添加标签：`{ "ids": ["..."], "addTagIds": ["..."] }` → `{ "data": { "linked": 4 } }`。
未知标签返回 `404 tag_not_found`，已存在的关联去重。

## GET /albums/:albumId/assets/:assetId/file

- 无 `Range`：`200`，`content-length` = 文件大小。
- `Range: bytes=start-end`：`206`，带 `content-range`。
- `end` 超出文件大小时按最后一字节截断，仍返回 `206`（符合 RFC 9110）。
- 起始位置越界等无法满足的范围：`416` + `content-range: bytes */<size>`。
- 响应头：`content-type`、`etag`（SHA-256）、`accept-ranges`、`content-disposition`。
- 带 `If-None-Match` 且与 ETag 相同时返回 `304`。
- SVG 响应改为 `content-disposition: attachment`，并附加
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`。

## GET /albums/:albumId/thumbnails

缩略图库统计与当前自动优化开关：

```json
{
    "data": {
        "count": 512,
        "totalBytes": 73400320,
        "fileBytes": 75497472,
        "maxBytes": 2147483648,
        "sizes": [
            { "size": 256, "count": 480, "bytes": 68704256 },
            { "size": 1024, "count": 32, "bytes": 4696064 }
        ],
        "autoOptimize": true,
        "maintenance": {
            "status": "idle",
            "kind": null,
            "startedAt": null,
            "finishedAt": null,
            "removed": 0,
            "error": null
        },
        "warmup": {
            "status": "idle",
            "scope": null,
            "total": 0,
            "processed": 0,
            "generated": 0,
            "skipped": 0,
            "failed": 0,
            "currentAssetId": null,
            "startedAt": null,
            "finishedAt": null,
            "error": null,
            "resumable": true,
            "size": 0
        },
        "generator": {
            "requests": 320,
            "hits": 280,
            "generated": 40,
            "failures": 0,
            "ewmaMs": 48,
            "samples": 40,
            "interactiveConcurrency": 2,
            "interactiveActive": 0,
            "interactivePending": 0,
            "backgroundActive": 1,
            "backgroundPending": 0
        }
    }
}
```

`fileBytes` 是统一 `thumbnails.db` 的 SQLite 主文件大小（不含 WAL，所有相册共享），
可用于判断碎片是否偏大；`count` / `totalBytes` 只统计当前相册。
`sizes` 按尺寸分表列出本相册的行数与字节（`thumbnails_s<size>`），只包含实际存在的档位，
供相册设置页展示「按尺寸分表」的占用明细。
`maintenance` 是后台整理/清空任务的实时状态（`idle` / `running` / `completed` / `failed`）；
`warmup` 是缩略图预热任务状态（`idle` / `running` / `paused` / `completed` / `cancelled` / `failed`）；
`generator` 是当前解码并发与最近耗时统计。

## POST /albums/:albumId/thumbnails/warmup

启动或继续缩略图预热，立即返回 **202**：`{ "restart": true }` 表示清空游标后从头扫描
（已有缩略图会快速跳过）。任务只生成最小配置尺寸，按 `added_at desc, id desc` 串行处理，
游标持久化在 `thumb_meta`，重启后可继续；导入完成后会自动把新增资产加入同一低优先级队列。

## POST /albums/:albumId/thumbnails/warmup/pause

暂停当前预热任务，立即返回 **202** 与最新 `warmup` 状态；当前图片解码完成后停止。

## POST /albums/:albumId/thumbnails/warmup/cancel

取消预热任务，立即返回 **202** 与最新 `warmup` 状态；保留游标，之后可继续或重新开始。

## POST /albums/:albumId/thumbnails/optimize

启动一次后台维护：LRU 淘汰、坏行清理、WAL 截断与按需 `VACUUM`。数据量或数据库文件超过
`thumbnails.dbMaxSizeMb` 时会继续淘汰最久未访问的缩略图并再次压缩。立即返回 **202**：

```json
{ "data": { "status": "running", "kind": "optimize", "removed": 0, "error": null } }
```

前端轮询 `GET .../thumbnails` 的 `maintenance` 直到 `completed`，再从 `removed` 取结果。

自动维护由 `thumbnails.autoOptimize` 控制，在连接空闲关闭前和每小时执行。

## DELETE /albums/:albumId/thumbnails

启动后台清空本相册在统一 `thumbnails.db` 中的缩略图与失败负缓存，同样返回 **202** 与
`maintenance` 状态；同时取消预热并重置预热游标。其它相册的缩略图不受影响。
缩略图在下次浏览时按需重新生成，原图与数据库记录不变。

## GET /albums/:albumId/assets/:assetId/preview

HEIC/RAW 的 JPEG 预览对象（`meta.preview`）；没有预览返回 `404 asset_preview_missing`。

## GET /albums/:albumId/assets/:assetId/stream

原生支持的视频 302 到 `/file`；其它容器用 ffmpeg 输出 fragmented MP4（`video/mp4`）。
远端存储或缺少 ffmpeg 时返回 501。

## GET /albums/:albumId/assets/:assetId/live

Live Photo 的配对视频（MOV/MP4），支持与 `/file` 相同的单段 `Range` 与 `416`。
没有 sidecar 时返回 `404 asset_live_missing`。

## GET /albums/:albumId/assets/:assetId/thumbnail?size=256

返回 `image/webp`。优先返回 `size` 精确匹配；已有更大的配置尺寸时直接复用。只有较小尺寸时
立即返回较小图，并在后台低优先级生成目标尺寸（stale-while-revalidate），下次请求升级。
完全没有缓存时才等待生成；目标尺寸不在配置内时取最近的配置尺寸。
`generate=0` 只读已有缓存，缺图直接 `404`，供查看器预载使用，不会触发原图解码。
`upgrade=1` 用于相册瓦片停留后的清晰度升级：缺目标档时同步生成再返回，保证不会拿到与首屏
相同的小图；仍受负缓存与并发合并保护。

同一资产同一尺寸的并发请求只解码一次；交互请求优先于后台预热，解码并发按最近耗时自适应
（机械硬盘通常降到 1 路）。带 `cache-control: private, max-age=300, must-revalidate` 与包含
生成时间的 `etag`，支持 `If-None-Match` 返回 `304`；生成失败写入负缓存，避免反复解码。
导入完成后后台会预热最小配置尺寸。

## DELETE /albums/:albumId/assets/:assetId

移入回收站：只写 `deleted_at`，存储原件、缩略图与数据库行保留，响应 `204`。
列表、统计、导出、AI 打标与相似分组默认排除已删除资产；详情/原图/缩略图仍可按 id 访问。

## POST /albums/:albumId/assets/:assetId/restore

从回收站恢复，响应 `200` + 资产摘要。

## DELETE /albums/:albumId/trash/:assetId

永久删除单个回收站资产：**先删数据库行，再删存储原件与缩略图**，响应 `204`。
文件删不掉只记日志、留下可清扫的孤儿文件，不会残留指向已删文件的僵尸记录。

## POST /albums/:albumId/trash/purge

清空回收站，请求体 `{ "confirm": true }`，返回 `{ "data": { "removed": 3, "failed": 0 } }`。
逐个资产先删行再删文件：`removed` 计数已删的行，`failed` 只统计删行失败（罕见）；
文件删除失败会照常计入 `removed` 并记 warning（宁可留孤儿文件，不留僵尸记录）。

## POST /albums/:albumId/trash/batch-purge

永久删除选中的回收站资产：`{ "ids": ["..."], "confirm": true }`，
返回 `{ "data": { "removed": 2, "failed": 0 } }`。

## POST /albums/:albumId/assets/:assetId/tags

```json
{ "tagId": "01a167ec-68d3-713e-873f-67275e908628" }
```

`201` + `Location`；重复关联幂等（`onConflictDoNothing`）。

## DELETE /albums/:albumId/assets/:assetId/tags/:tagId

`204`。

## 错误

| status | code |
|---|---|
| 403/404 | `album_not_found` / `asset_not_found` |
| 404 | `thumbnail_not_found` / `asset_file_missing` / `asset_live_missing` / `tag_not_found` |
| 416 | `range_not_satisfiable` |
| 422 | `validation_failed` |
| 500 | `album_index_corrupt` / `tag_file_corrupt` |
