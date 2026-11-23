# Pixiv API

Pixiv 账号与网络配置是全局的；启用开关与自动下载是相册级的。
所有请求都由服务端访问 Pixiv，浏览器不直接接触 access token。

## 全局状态与登录

### GET /pixiv/status

```json
{
    "data": {
        "configured": true,
        "accountId": "42",
        "accountName": "Pixiv Tester",
        "account": "tester",
        "premium": true,
        "networkMode": "direct"
    }
}
```

`configured` 表示已经保存 refresh token，不保证 token 仍然有效；可调用
`POST /pixiv/test` 验证。

### POST /pixiv/auth/token

直接使用 refresh token 登录：

```json
{ "refreshToken": "…" }
```

### DELETE /pixiv/auth

清除内存会话并从 `setting.json` 移除 refresh token 与账号展示信息，返回 `204`。

### POST /pixiv/test

使用当前 token 访问一个轻量接口，成功返回 `{ "data": { "ok": true } }`；
未登录返回 `401 pixiv_auth_required`，网络失败返回 `502 pixiv_network_error`。

## 全局 Pixiv 库

### GET /pixiv/database

返回 `<dataDir>/data/pixiv.db` 的位置、最近同步状态与统计：

```json
{
    "data": {
        "syncing": false,
        "lastSyncedAt": "2026-10-28T08:00:00.000Z",
        "result": { "albums": 2, "illusts": 1530, "users": 210, "tags": 4830, "skipped": [], "syncedAt": "2026-10-28T08:00:00.000Z" },
        "error": null,
        "path": "C:/Users/me/.xeonsky/picturex/data/pixiv.db"
    }
}
```

### POST /pixiv/database/sync

立即同步一次：扫描所有启用 Pixiv 的相册，把作品详情写入全局 `pixiv.db` 的
`illusts/users/tags/illust_tags`，并根据相册映射补齐 `fetched_at = 0` 的占位行。
`asset ↔ illust/page` 映射不会写入全局库。正常启动、打开相册、补全或导入后也会自动合并触发，
一般无需手动调用。返回与 `GET` 相同的同步结果结构。

## 首页 Pixiv 资料库

首页「Pixiv 资料库」与 `/pixiv` 页面直接读取 `<dataDir>/data/pixiv.db`，
浏览全部作品、画师与 Pixiv 标签；不要求作品属于任何已登记相册。

### GET /pixiv/library/stats

返回作品总数、已补全/占位/已失效数量、画师与标签数、动图数量、最近汇总时间，
以及筛选用的高频标签（`topTags`）与画师（`topUsers`）和类型分布（`types`）：

```json
{
    "data": {
        "total": 49290,
        "fetched": 17176,
        "placeholder": 32114,
        "invalid": 86,
        "ugoira": 120,
        "users": 7446,
        "tags": 12110,
        "lastSyncedAt": "2026-10-28T08:00:00.000Z",
        "types": [{ "type": "illust", "count": 48000 }],
        "topTags": [{ "tagId": "183", "name": "original", "translatedName": null, "count": 5210 }],
        "topUsers": [{ "userId": "42", "name": "Pixiv Tester", "account": "tester", "count": 320 }]
    }
}
```

### GET /pixiv/library

keyset 分页浏览作品。查询参数：

| 参数 | 说明 |
|---|---|
| `q` | 标题、作品 ID、画师名/账号、Pixiv 标签名或译名，LIKE 匹配 |
| `status` | `all` / `fetched` / `placeholder` / `invalid`，默认 `all`；`fetched`/`placeholder` 均不含失效作品 |
| `type` | `illust` / `manga` / `ugoira` |
| `userId` | 按画师过滤 |
| `tagId` | 按 Pixiv 标签 ID 过滤（`tags.tag_id`） |
| `sort` | `recent` / `bookmarks` / `views` / `updated` / `id`，默认 `recent` |
| `cursor` | 上一页返回的 `pagination.nextCursor` |
| `limit` | 1–100，默认 60 |

```json
{
    "data": {
        "data": [{
            "illustId": "150273506",
            "title": "Thick Thighs Take Lives",
            "type": "illust",
            "userId": "38911978",
            "userName": "ShoulderEnjoyer",
            "userAccount": "…",
            "pageCount": 4,
            "width": 2647,
            "height": 3747,
            "xRestrict": 1,
            "illustAiType": 1,
            "createDate": "2026-09-29T21:53:00.000Z",
            "totalView": 2907,
            "totalBookmarks": 156,
            "fetchedAt": "2026-10-28T08:00:00.000Z",
            "placeholder": false,
            "invalid": false,
            "ugoira": false,
            "coverUrl": "/api/v1/pixiv/library/image?illustId=150273506&page=0&variant=medium"
        }],
        "total": 49290,
        "pagination": { "limit": 60, "nextCursor": "…", "hasMore": true }
    }
}
```

占位行（`fetched_at = 0`）的 `placeholder` 为 `true`、`coverUrl` 为 `null`。
`invalid` 为 `true` 表示 Pixiv 已返回 404（删除/不可见），该作品不再参与自动补全与后台同步；
已有详情仍会返回，只是带失效标记。

### GET /pixiv/library/:illustId

返回库内完整详情与本地引用：

```json
{
    "data": {
        "illustId": "150273506",
        "placeholder": false,
        "invalid": false,
        "fetchedAt": "2026-10-28T08:00:00.000Z",
        "illust": { "title": "…", "tags": [], "pages": [], "ugoira": null },
        "locals": [{ "albumId": "…", "albumName": "Pixiv", "assetId": "…", "filename": "150273506_p0.jpg", "pageIndex": 0 }]
    }
}
```

`locals` 来自各已登记相册的 `pixiv_asset_links`，仅用于展示与跳转；详情不会写入相册。
作品不存在返回 `404 pixiv_illust_not_found`。

### POST /pixiv/library/:illustId/refresh

忽略缓存，从 Pixiv 重新拉取该作品详情并写入全局 `pixiv.db`，返回与 GET 相同的结构。
成功时会把 `invalid_at` 清零；作品已删除/不可见时记录失效并返回带 `invalid: true` 的详情
（库内没有该作品时才返回 `404 pixiv_illust_not_found`）。未登录返回 `401 pixiv_auth_required`。
只更新元数据，不下载任何图片。

### GET /pixiv/library/image

资料库图片入口，供首页封面和详情预览使用。查询参数 `illustId`、`page`（默认 0）、
`variant`（`square` / `medium` / `large` / `original`，默认 `medium`）。

处理顺序：

1. 已登记相册里存在该作品的本地分P → `302` 到资产 `/file`（original）或
   `/thumbnail?size=256|512|1024`（square/medium/large）；
2. 本地缺失时，`large` / `original` 下载 Pixiv 原图并写入
   `<dataDir>/data/cloud.db` 的 `pixiv_locals` 表，再返回缓存字节；
3. 其它尺寸或下载失败 → 按请求尺寸流式代理 Pixiv。

图片地址只从 `illusts.pages` 读取；所有取图调用走 `pixivImageStream`，它先调用
`assertPixivImageUrl` 校验 `i.pximg.net` / `s.pximg.net`（及 `PX_PIXIV_IMAGE_HOSTS`）白名单，
再合并 Pixiv Referer 发起请求。请求按当前 Pixiv 网络模式（直连/代理）发起。
`cloud.db` 有容量上限（默认 2 GiB，`PX_PIXIV_CLOUD_MAX_MB` 可调），写入后按最近访问时间
淘汰到 80%，缓存的字节可随时重新下载。
响应带 `Cache-Control: private, max-age=604800, immutable`。库内没有该分P时返回
`404 pixiv_image_not_found`。

## 后台补全进度

### GET /pixiv/auto-fetch

返回单 worker 队列与每个相册最近一次补全状态（运行状态为内存值；作品断点持久化在相册
`picture.db.pixiv_fetch_marks`，重启后不会重复检查已完成/冷却中的作品）：

```json
{
    "data": {
        "running": true,
        "paused": false,
        "speed": "normal",
        "queued": [{ "albumId": "…", "albumName": "测试" }],
        "albums": [
            {
                "albumId": "…",
                "albumName": "测试",
                "status": "running",
                "total": 71,
                "processed": 24,
                "network": 18,
                "backfilled": 5,
                "fresh": 52,
                "failed": 1,
                "deleted": 2,
                "noToken": 0,
                "currentIllustId": "125547965",
                "startedAt": "2026-10-27T03:00:00.000Z",
                "updatedAt": "2026-10-27T03:00:05.000Z",
                "retryAt": "",
                "elapsedMs": 5000,
                "error": ""
            }
        ]
    }
}
```

`status` 取值 `queued` / `running` / `paused` / `completed` / `failed` / `skipped`。
`total` 只包含本次真正需要补全的作品：已有相册元数据（缓存期内）和断点冷却中的作品在开始前
会被过滤，不计入 `total/processed`；`fresh` 通常为 0，仅在运行期间被其他请求补全时出现。
`paused` 可能是限流/连续失败的自动暂停（看 `retryAt`），也可能是用户手动暂停（`error: "paused"`，
不自动续跑）；顶层 `paused` 表示用户暂停开关已持久化。`deleted` 是已删除/不可见而跳过的作品数。
请求层共享最小间隔闸门（150ms + 抖动）。**每 60 次联网请求休息 15–20 秒只在自动补全的
单相册本轮内计数**，详情页、资料库与 OAuth 不触发批次休息。收到 429 时按 `Retry-After`
降速并自动续跑。

同一个作品成功补全后写入断点；失败作品 30 分钟内不重复检查；已失效作品**永久跳过**，
只有资料库的「刷新详情」会重试并清除 `invalid_at`。手动「立即补全」会忽略失败冷却，
启动/路由触发的自动补全则按断点续跑。

### POST /pixiv/auto-fetch

手动触发（跳过 5 分钟冷却）。body `{ "albumId": "…" }` 只补该相册；省略 `albumId`
则把所有已启用 Pixiv 且目录正常的相册加入队列：

```json
{ "data": { "queued": 1, "status": { "running": true, "speed": "normal", "queued": [], "albums": [] } } }
```

速度由 `setting.json.pixiv.autoFetchSpeed`（`slow` / `normal` / `fast`）控制，可在
「设置 → Pixiv」调整；只影响元数据请求间隔，不会自动下载缺失分P。
用户暂停期间该端点返回 `queued: 0`，不会重新入队。

### POST /pixiv/auto-fetch/pause

持久化 `pixiv.autoFetchPaused = true`，清空队列与自动重试；正在运行的任务会在下一个作品边界停止。
返回最新 `PixivAutoFetchStatusDto`。

### POST /pixiv/auto-fetch/resume

清除暂停标记并重新排队所有启用 Pixiv 的相册（按断点跳过已完成作品），返回
`{ queued, status }`。

## 相册资产

以下端点要求相册已开启 `settings.pixivEnabled`，否则返回 `409 pixiv_disabled`。

### GET /albums/:albumId/assets/:assetId/pixiv

返回作品上下文。不会下载缺失分P，但会补写相册 `pixiv_asset_links`、`meta.pixiv` 与
全局 `pixiv.db`（包括 `invalid_at`），**不是纯只读**；只有 `POST .../pixiv/sync` 会下载分P。

```json
{
    "data": {
        "pixiv": true,
        "illustId": "123456",
        "pageIndex": 0,
        "illust": {
            "title": "Work 123456",
            "type": "illust",
            "caption": "line one\nline two",
            "userId": "42",
            "userName": "Pixiv Tester",
            "pageCount": 2,
            "xRestrict": 1,
            "tags": [{ "name": "tag-one", "translatedName": "Tag One" }],
            "pages": [{ "index": 0, "urls": { "original": "…" } }],
            "ugoira": null
        },
        "localPages": [{ "index": 0, "assetId": "…", "filename": "123456_p0.jpg" }],
        "missingPages": [1],
        "authRequired": false,
        "stale": false,
        "downloadedPages": [],
        "downloadErrors": []
    }
}
```

- 文件名不匹配且没有分P映射时返回 `{ "pixiv": false }`。
- 未登录或无有效 token 时返回 `authRequired: true`；`illust` 可能为 `null`，
  但 `localPages` 仍会返回。
- 远端刷新失败但本地有缓存时 `stale: true`。
- `?refresh=1` 忽略 7 天缓存。

### POST /albums/:albumId/assets/:assetId/pixiv/sync

显式同步并可按需下载缺失分P：

```json
{ "download": true }
```

返回结构同 GET，`downloadedPages` 是本次成功入库（或已存在并完成关联）的分P，
`downloadErrors` 是失败的分P。下载遵循全局 `pixiv.imageQuality`。

### GET /albums/:albumId/pixiv/tags

返回该相册本地 Pixiv 作品标签及引用数量：

```json
{ "data": [{ "tagId": "123", "name": "風景", "translatedName": "风景", "count": 12 }] }
```

### GET /albums/:albumId/assets/:assetId/pixiv/ugoira

返回 `application/zip`。首次请求会下载并缓存；之后直接复用本地 zip。
未登录且没有缓存时返回 `401 pixiv_auth_required`；非 ugoira 作品返回
`404 pixiv_ugoira_unavailable`。

## 设置字段

`GET/PATCH /settings` 中的 `pixiv`：

| 字段 | 说明 |
|---|---|
| `refreshToken` | 响应中始终为 `********`；提交掩码表示保持原值 |
| `accountId` / `accountName` / `account` / `premium` | 登录后写入的账号展示信息 |
| `networkMode` | `direct` / `proxy`，默认 `proxy` |
| `proxyUrl` | `networkMode=proxy` 时的 `http://`、`socks5://` 或 `socks5h://` 地址，默认 `socks5://127.0.0.1:10808`；带 `user:pass@` 凭据时响应里以 `***` 掩码，提交带 `***` 的地址回填已存真实凭据 |
| `imageQuality` | `original` / `large` / `medium` |
| `autoFetchSpeed` | 后台补全请求间隔：`slow`（1–3s）/ `normal`（100–1000ms）/ `fast`（50–300ms） |
| `autoFetchPaused` | 持久化暂停后台补全；重启后仍保持暂停 |

相册设置（`PATCH /albums/:albumId`）：

```json
{ "settings": { "pixivEnabled": true, "pixivAutoDownload": false } }
```

`pixivAutoDownload` 默认 `false`，缺失分P由用户手动触发下载。

## 错误码

| 错误码 | 状态 | 说明 |
|---|---|---|
| `pixiv_disabled` | 409 | 相册未启用 Pixiv |
| `pixiv_auth_required` | 401 | 需要登录 |
| `pixiv_auth_failed` | 401 | 登录或 token 刷新失败 |
| `pixiv_api_error` | 502 | Pixiv 返回异常或非法响应 |
| `pixiv_network_error` | 502 | 无法连接 Pixiv |
| `pixiv_rate_limited` | 429 | 请求过频 |
| `pixiv_illust_not_found` | 404 | 作品不存在或不可见 |
| `pixiv_image_not_found` | 404 | 作品没有可用的预览分P |
| `pixiv_ugoira_unavailable` | 404 | 没有可用的动图资源 |
| `pixiv_download_failed` | 502 | 图片/压缩包下载失败 |
