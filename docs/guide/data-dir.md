# 数据目录与设置

读完你能准确知道 PictureX 把哪些文件放在哪里，以及 `setting.json` 每个字段的含义。

## 解析优先级

高 → 低：

1. 命令行 `-dataDir <path>` / `--data-dir` / `--dataDir`
2. 环境变量 `NUXT_DATA_DIR`
3. 开发模式：`<workspaceRoot>/.dev/data`
4. 生产模式：`~/.xeonsky/picturex`

解析逻辑只在 `apps/web/server/utils/data-dir.ts`。CLI 未显式传 `--data-dir` 时不设置
`NUXT_DATA_DIR`，交给服务端按上述规则解析。

## 目录布局

```
<dataDir>/
  setting.json
  data/
    picture.db            # 散图库（查看器打开过的离散图片/视频记录 + 标签关联）
    tag.db                # 全局标签主数据（只含应用标签）
    pixiv.db              # 全局 Pixiv 汇总（illusts/users/tags/illust_tags/meta；不含 asset 映射）
    thumbnails.db         # 统一缩略图库（按 album_id 隔离、按尺寸分表）
    task.db               # 统一的导入 / AI 任务（import_jobs / ai_jobs，按 album_id 归属）
    cloud.db              # Pixiv 云端原图缓存（pixiv_locals；仅本地没有的图片）
  albums/
    .albums.json            # 相册登记表（id / dir / name），决定列表里有哪些相册
    <albumId>/
      index.json
      data/
        tag.db              # 首次访问该相册时才创建
        picture.db          # 同上
        pixiv.db            # 本相册用到的作品详情（与全局 pixiv.db 同构，随相册搬移）
      storage/<4 位分区>/<uuidv7>.<ext>
  models/
    index.json
    <modelId>/...
  .download/
    index.json
    <modelId>/*.part
    <modelId>/*.session.json
  cache/
    pixiv/
      downloads/<illustId>/     # 下载中的分P临时文件
      ugoira/<illustId>.zip     # 动图压缩包缓存
```

`albumsRoot` 与 `modelsRoot` 可以在设置中改成其它绝对路径；下载目录与缩略图库固定跟着 `dataDir`。
相册本体可以放到任意本地目录，登记表 `albums/.albums.json` 决定列表里有哪些相册；
`albumsRoot` 只是默认位置与登记表的家。目录丢失的相册会在启动与列表里标成 `missing`。

`<dataDir>/data/` 下的 `picture.db` / `tag.db` 是**散图库**：只保存桌面查看器打开过的离散图片/视频记录与
手工标签，**不聚合任何相册资产或相册标签**。相册数据只在各自 `data/picture.db` / `data/tag.db` 中维护。
散图库可以随时删除重建。

`<dataDir>/data/pixiv.db` 是**全局 Pixiv 库**：保存 `illusts`（作品详情）、`users`（画师）、
`tags` + `illust_tags`（Pixiv 标签及关系）与 `meta`（同步状态）。按文件名识别到的作品先写
`fetched_at = 0` 的占位行，详情补全后覆盖。`asset ↔ illust/page` 映射**不在全局库**，
只保存在相册 `picture.db.pixiv_asset_links`，随相册目录搬移用于跨设备同步。

`<dataDir>/data/cloud.db` 的 `pixiv_locals` 存 Pixiv 资料库本地缺失时下载的原图，按
`(illust_id, page_index)` 唯一；相册里已有的图片不会重复复制。缓存上限默认 2 GiB
（`PX_PIXIV_CLOUD_MAX_MB` 可调，≥64），超出后按最近访问时间淘汰到 80%；
这些字节都可以重新下载，删掉不影响任何相册数据。

首页的「全部」就是这份散图库的只读视图，不产生额外目录或数据库。
标签库不可用时只读浏览降级为空，写入返回 `tag_file_corrupt`，需先恢复备份。

## setting.json

启动时用 Zod 校验；缺失字段补默认并原子回写。完整默认值：

```json
{
    "schemaVersion": 1,
    "albumsRoot": "<dataDir>/albums",
    "modelsRoot": "<dataDir>/models",
    "storage": {
        "default": "local",
        "partitionSize": 8192,
        "partitionMode": "sequence"
    },
    "thumbnails": {
        "dbMaxSizeMb": 2048,
        "sizes": [256, 512, 1024],
        "quality": 80,
        "autoOptimize": true
    },
    "ai": {
        "labelMode": "zero-shot",
        "device": "auto",
        "localModelId": "clip-vit-base-patch32",
        "captioningModelId": "vit-gpt2-image-captioning",
        "external": {
            "enabled": false,
            "baseUrl": "",
            "apiKey": "",
            "model": ""
        },
        "autoTag": false,
        "downloadConcurrency": 4,
        "autoResumeDownload": false
    },
    "similarity": {
        "enabled": true,
        "algorithm": "phash",
        "hammingThreshold": 8
    },
    "pixiv": {
        "refreshToken": "",
        "accountId": "",
        "accountName": "",
        "account": "",
        "premium": false,
        "networkMode": "proxy",
        "proxyUrl": "socks5://127.0.0.1:10808",
        "imageQuality": "original",
        "autoFetchSpeed": "normal",
        "autoFetchPaused": false
    },
    "ffmpeg": {
        "enabled": true,
        "path": "auto"
    },
    "theme": {
        "preset": "light",
        "overrides": {}
    },
    "i18n": {
        "defaultLocale": "zh-CN",
        "locales": ["zh-CN", "en-US"]
    }
}
```

| 字段 | 说明 |
|---|---|
| `storage.default` | `local` / `quark` / `oss` / `ftp`；后三者目前是 stub |
| `storage.partitionSize` | 每个分区文件数，默认 8192 |
| `storage.partitionMode` | 只支持 `sequence`；其它值启动直接报错 |
| `thumbnails.dbMaxSizeMb` | 每个相册在统一 `<dataDir>/data/thumbnails.db` 中的 BLOB 预算，超出按相册 LRU 淘汰到 90% |
| `thumbnails.sizes` | 生成哪些尺寸（px） |
| `ai.labelMode` | 默认 AI 模式：`zero-shot` / `generative` |
| `ai.external` | OpenAI 兼容接口配置；`apiKey` 只存本机 |
| `ai.autoTag` | 导入完成后自动对新增资产打标 |
| `ai.downloadConcurrency` | 模型下载分片并发（1–16） |
| `similarity.hammingThreshold` | 相似分组阈值（0–64，越小越严格） |
| `pixiv.refreshToken` | Pixiv refresh token，只存本机，接口返回掩码 |
| `pixiv.networkMode` | `direct` / `proxy`（HTTP CONNECT 或 SOCKS5），默认 `proxy`，详见 [Pixiv 集成](/guide/pixiv) |
| `pixiv.imageQuality` | 缺失分P下载质量：`original` / `large` / `medium` |
| `ffmpeg.path` | `auto` 使用 ffmpeg-static；只接受文件名匹配 `ffmpeg`/`ffprobe` 的绝对路径（防被写入任意可执行文件），非法值经 `PATCH /settings` 返回 422 |
| `theme.preset` / `overrides` | 主题预设与白名单 Token 覆盖；覆盖值按 Token 类型校验（`color-*` 只接受十六进制/函数色，其它只接受长度值），非法值被忽略 |
| `i18n.defaultLocale` | 默认语言偏好；当前语言仍优先使用 cookie / 浏览器语言 |

## 读写保证

- 所有 JSON 清单（setting、相册 index/tag、模型、下载）都走
  `server/utils/atomic-json.ts` 的 `tmp + rename` 原子写。
- 损坏 JSON 会重命名为 `*.corrupt-<timestamp>` 后回退默认值。
- `setting.json` 在进程内缓存；PATCH `/settings` 后立即原子回写并刷新缓存。

## 迁移与备份

- 整个 `dataDir` 可直接备份；相册目录是自包含单元，可单独搬移（见[相册格式](/guide/album-format)）。
- 迁移后如使用自定义 `albumsRoot` / `modelsRoot`，需要同步修改 `setting.json` 或通过
  「设置 → 数据与路径」保存。
- 不要手动删除 `picture.db-wal` / `thumbnails.db-wal`；请停止服务后再备份。
