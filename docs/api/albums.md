# 相册 API

读完你能创建、查询、重命名与删除相册。

基础路径：`/api/v1`。错误统一为 `application/problem+json`（RFC 9457）。

## GET /albums

查询参数：`page`（默认 1）、`pageSize`（1–100，默认 20）。

```json
{
    "data": [
        {
            "schemaVersion": 1,
            "id": "01a167eb-b046-7742-b060-4dabd084a850",
            "name": "2026 旅行",
            "description": "夏天",
            "coverAssetId": "01a167eb-b151-709e-ad3b-691e7e5b03e6",
            "assetCount": 128,
            "createdAt": "2026-10-23T08:41:01.907Z",
            "updatedAt": "2026-10-23T08:41:02.073Z",
            "dir": "D:\\Photos\\2026-trip",
            "missing": false
        }
    ],
    "pagination": { "page": 1, "pageSize": 20, "total": 1 }
}
```

`dir` 是相册的真实目录（默认在 `albumsRoot/<id>`，也可登记到其它磁盘）；
`missing: true` 表示登记过、但目录当前不存在，此时 `assetCount` 为 0、名称取自登记表。
列表只读 `index.json` 与登记表，**不会打开相册数据库**。

## POST /albums

请求：

```json
{ "name": "2026 旅行", "description": "可选", "dir": "D:/Photos/2026-trip" }
```

Zod：`name` 1–120 字符，`description` ≤ 2000，`dir` ≤ 4096 且必须是绝对路径。

- 不传 `dir`：在 `albumsRoot/<新 id>` 建相册（只写 `index.json`，三张 SQLite 首次访问时才创建）。
- 传 `dir` 且目录里已有 `index.json`：登记这个已有相册（不改名）。
- 传 `dir` 且目录不存在或为空：在那里新建相册。
- 传 `dir` 且目录非空、又不是相册：`409 album_path_not_empty`。

响应 `201`，`Location: /api/v1/albums/<id>`，body `{ "data": AlbumSummary }`。

## POST /albums/link

关联一个**已经存在**的自包含相册目录（只登记路径，不移动/复制文件、不改名）：

```json
{ "dir": "D:/Photos/2026-trip" }
```

- `dir` 必须是绝对路径且目录里有 `index.json`，否则 `404 album_import_not_found`。
- 该相册已在列表里：`409 album_path_conflict`。
- 名称与其它相册冲突：`409 album_name_conflict`。

响应 `201` `{ "data": AlbumSummary }`，`Location: /api/v1/albums/<id>`。
前端入口是首页的「关联已有相册」，用内建目录选择器选目录（见[目录浏览 API](/api/fs)）。

## GET /albums/:albumId

响应 `200` `{ "data": Album }`。

## PATCH /albums/:albumId

```json
{
    "name": "新名字",
    "description": "新描述",
    "coverAssetId": "01a167eb-b151-709e-ad3b-691e7e5b03e6",
    "settings": { "similarityThreshold": 6, "autoTag": true }
}
```

字段可省略；名称不能与其它相册重复。`coverAssetId` 必须是该相册内未删除的资产，选中的 id 直接写入
`index.json`（首页与侧栏只读 `index.json`，不打开相册库）；传 `null` 表示恢复自动封面，服务端立刻
落回「最新入库的未删除资产」，不会留下空封面。相册设置页的「选择封面」与照片页批量管理的
「设为封面」都走这个字段；资产详情页的按钮同样有效。

| settings 字段 | 说明 |
|---|---|
| `similarityThreshold` | 0–64 或 `null`（跟随全局 `setting.json.similarity.hammingThreshold`） |
| `autoTag` | `true` / `false` / `null`（跟随全局 `setting.json.ai.autoTag`） |
| `pixivEnabled` | 是否启用该相册的 Pixiv 功能，默认 `false` |
| `pixivAutoDownload` | 打开详情时是否自动下载缺失分P，默认 `false` |

相册级设置写入 `index.json.settings`，只影响这个相册；相似页拖动阈值也会写回这里。

## POST /albums/:albumId/exports

把相册内全部图片复制到指定文件夹，响应是 **NDJSON 流**（`application/x-ndjson`），
每行一个事件，用于前端进度条：

```
{"type":"start","total":7680,"targetPath":"D:\\Export"}
{"type":"progress","done":1,"total":7680,"filename":"0001_IMG_0001.jpg"}
{"type":"missing","filename":"broken.jpg"}
{"type":"done","exported":7679,"missing":1,"manifest":"picturex-export.json"}
```

```json
{ "targetPath": "D:\\Export", "naming": "sequence" }
```

| 字段 | 说明 |
|---|---|
| `targetPath` | 已存在的目标文件夹，不能在相册目录内 |
| `naming` | `sequence`（`0001_文件名`，默认）/ `filename` / `uuid`；重名自动加 `-2` |

导出完成后在目标目录写 `picturex-export.json` 清单（重名时自动变成
`picturex-export-2.json`，绝不覆盖已有清单或图片），每项含 `uuid`、`filename`、
`sequence`（顺序 ID）、`takenAt`、`addedAt`、`modifiedAt`、`exportedAs`、`size`、`sha256`。

目标目录非法返回 `422 export_target_invalid`（在相册内）或 `422 export_target_missing`（不存在）。

## DELETE /albums/:albumId

默认**只解除关联**：从登记表移除，磁盘上的相册目录与文件保持原样，用户可稍后用
`POST /albums/link` 重新加入。需要连文件一起删除时显式加 `?deleteFiles=true`。

| 查询参数 | 说明 |
|---|---|
| `deleteFiles` | `true` 时同时删除相册目录（不可撤销） |

响应 `204`。导入进行中返回 `409 import_already_running`；相册未登记返回 `404 album_not_found`。

## 错误

| status | code | 场景 |
|---|---|---|
| 404 | `album_not_found` | 相册不存在或 ID 非法 |
| 404 | `album_missing` | 登记过但相册目录已不存在 |
| 404 | `album_import_not_found` | 关联的目录里没有 index.json |
| 409 | `album_name_conflict` | 名称重复 |
| 409 | `album_path_not_empty` | 目标目录非空且不是相册 |
| 409 | `album_path_conflict` | 该目录里的相册已登记 |
| 409 | `import_already_running` | 删除时仍在导入 |
| 409 | `album_busy` | 导入/打标/相似度任务仍持有数据库租约 |
| 422 | `album_path_invalid` | 自定义路径不是绝对路径 |
| 422 | `validation_failed` | Zod 校验失败 |
| 500 | `internal_error` | 未预期错误 |
