# 相册格式

读完你能理解相册目录的每个文件、相册 `data/` 下三张 SQLite、数据根 `data/` 下的全局库与任务库的表结构，以及如何安全搬移相册。

**时间约定**：所有数据库时间列统一使用 `INTEGER` 存 Unix 秒级时间戳；API/DTO 边界才转换成
ISO-8601。0.1.0 是新基线，不读取更早的库结构或 JSON 文件。

## 目录

```
<dataDir>/albums/<albumId>/
  index.json
  data/
    tag.db
    picture.db
    pixiv.db
  storage/
    0001/
      <uuidv7>.jpg
    0002/
      <uuidv7>.webp
```

`<albumId>` 是 UUID v7。相册本体没有外部依赖，复制整个目录即可搬移；路径变化后
`setting.json.albumsRoot` 不变也没关系，因为相册内部只使用相对 `storageKey`。
缩略图是可再生的缓存，统一存 `<dataDir>/data/thumbnails.db`，不随相册目录搬移；
搬移后仍按 `index.json.id` 复用同一份缩略图行，缺失时会自动重新生成。
导入与 AI 任务同样不随相册搬移：它们集中在 `<dataDir>/data/task.db`，按 `album_id` 归属。

## 自定义路径与失联检测

相册可以放在任何本地目录（其它磁盘、NAS 挂载点都行），创建时填绝对路径即可：

```bash
curl -X POST http://localhost:3000/api/v1/albums \
  -H 'content-type: application/json' \
  -d '{"name":"2026 旅行","dir":"D:/Photos/2026-trip"}'
```

- 相册登记表 `<albumsRoot>/.albums.json` 是「PictureX 认哪些相册」的唯一事实源：
  首次运行（还没有登记表）会扫描 `albumsRoot` 自动登记已有相册；之后只认登记表。
- 指向一个已经存在的相册目录时直接登记（不改名），因此搬移相册后重新登记即可恢复。
- 图形界面里不用手打路径：创建相册的「相册目录」旁点「浏览…」打开内建目录选择器
  （Windows 盘符 / Unix 根目录与主目录都支持，可逐级进入、可切隐藏目录、也可粘贴路径）；
  首页的「关联已有相册」、相册页「导入本地文件夹」用的是同一个选择器。
- 服务启动和 `GET /albums` 会检查登记目录是否存在：不存在时返回 `missing: true`，
  首页顶部给出提示并给卡片打「目录不存在」标记；把目录放回去后自动恢复。
- **解除关联**只删登记、不动磁盘：目录和文件原样保留，之后可用「关联已有相册」加回来；
  所以手动丢进 `albumsRoot` 的旧相册不会被自动重新发现，需要在界面上主动关联。
  只有显式要求（API `?deleteFiles=true`）才会连目录一起删除。
- 每次打开相册都会做一次轻量对账：清掉指向已删除资产的重复文件行，校正资产数与封面。

## 数据库按需加载

`index.json` 是目录发现与列表的唯一依据，**列表与启动流程从不打开 SQLite**。
`data/picture.db`、`data/tag.db`、`data/pixiv.db` 与数据根 `data/thumbnails.db` 在真正访问相册时才创建并缓存连接，
空闲 15 分钟自动关闭，避免同时持有大量相册库的文件句柄。
因此刚创建的相册目录里只有 `index.json`，第一次入库或浏览时才出现 `data/` 与其中的 `.db`。
导入与 AI 任务不在此列：它们统一存在 `<dataDir>/data/task.db`，任务页只打开这一个库。

## index.json

```json
{
    "schemaVersion": 1,
    "id": "01a167eb-b046-7742-b060-4dabd084a850",
    "name": "2026 旅行",
    "description": "夏天",
    "coverAssetId": "01a167eb-b151-709e-ad3b-691e7e5b03e6",
    "assetCount": 128,
    "createdAt": "2026-10-23T08:41:01.907Z",
    "updatedAt": "2026-10-23T08:41:02.073Z",
    "settings": {
        "similarityThreshold": 6,
        "autoTag": true,
        "pixivEnabled": true,
        "pixivAutoDownload": false
    }
}
```

`settings` 是相册级功能覆盖，`similarityThreshold` / `autoTag` 的 `null` 表示跟随全局 `setting.json`：

| 字段 | 说明 |
|---|---|
| `similarityThreshold` | 相似分组阈值（0–64） |
| `autoTag` | 导入完成后是否自动 AI 打标 |
| `pixivEnabled` | 是否在详情页识别 Pixiv 文件名并读取作品信息 |
| `pixivAutoDownload` | 是否自动下载缺失分P；默认 `false`，由用户手动触发 |

旧相册没有 `similarityThreshold` / `autoTag` 时按 `null` 处理；
`pixivEnabled` 缺省为 `false`，`pixivAutoDownload` 缺省为 `false`。写入 `index.json` 时自动补全。

`assetCount` 与 `coverAssetId` 由入库/删除后统一刷新，避免前端打开每个相册库统计。

## data/tag.db

标签主数据只存这里（`picture.db.asset_tags` 只存关联）。**只保存应用自身生成/用户创建的标签；
Pixiv 作品标签存在 `pixiv.db`，不进入 `tag.db`**。WAL 模式，连接参数与其它库一致。

### tags

| 列 | 说明 |
|---|---|
| `id` | UUID v7 |
| `name` | 展示名称（保留用户写法） |
| `name_key` | 小写归一化键，唯一索引，用于大小写不敏感去重 |
| `color` | 十六进制颜色，可为空 |
| `created_at` | INTEGER，Unix 秒级时间戳 |

### tag_meta

| key | 说明 |
|---|---|
| `corrupt` | 标签库不可用、回退到内存库时为 `1`；写接口返回 `tag_file_corrupt` |

标签库版本只认 `PRAGMA user_version`（当前 `4`）；`tags` 没有 `updated_at`，也没有
未使用的 `tags_name_idx`，`tag_meta` 不写 `schema_version` 行。

## data/picture.db

WAL 模式；连接参数固定 `busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`。

### album_meta

| key | 说明 |
|---|---|
| `next_seq` | 下一个存储序列号（唯一事实源） |
| `similarity_index` | 相似度索引快照（阈值、已算 pHash 数、资产数、分组数、时间） |
| `fts_version` | 搜索索引版本，当前为 `3`（只索引 `filename`/`caption`）；低于 `3` 时每次打开重建并清掉 `meta.ocr` |

库版本只认 `PRAGMA user_version`（当前 `6`），不再有 `schema_version` 这类重复行。

### assets

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID v7 |
| `storage_key` | TEXT UNIQUE | `storage/0001/<uuidv7>.<ext>` |
| `filename` | TEXT | 原文件名 |
| `ext` | TEXT | 小写扩展名 |
| `mime` | TEXT | 嗅探结果 |
| `kind` | TEXT | `image` / `gif` / `dynamic` / `svg` / `video` |
| `size` | INTEGER | 字节 |
| `width` / `height` | INTEGER | 可空 |
| `duration_ms` | INTEGER | 视频时长 |
| `sha256` | TEXT | 内容哈希（精确去重） |
| `phash` | TEXT | 16 位十六进制（视觉相似） |
| `taken_at` | INTEGER | EXIF/视频拍摄时间（Unix 秒，可空） |
| `added_at` | INTEGER | 入库时间（Unix 秒） |
| `deleted_at` | INTEGER | 非空表示在回收站；列表/统计/导出默认排除 |
| `meta` | TEXT | JSON：EXIF、视频信息、`ai` 打标结果、Live Photo 的 `live` sidecar、Pixiv 身份 `pixiv: { illustId, pageIndex }`；应用元数据的唯一事实源 |
| `pixiv_illust_id` | TEXT 生成列 | `json_extract(meta, '$.pixiv.illustId')` |
| `pixiv_illust_num` | INTEGER 生成列 | 作品 ID 数值（非 Pixiv 为 0），供 `sort=pixivId` |

索引：`sha256`、`phash`、`added_at`、`taken_at`、`filename`、`deleted_at`，以及
`coalesce(taken_at, added_at)` 排序索引。

列表分页另建五个部分索引（只在未删除资产上有条目）：`(added_at, id)`、
`(coalesce(taken_at, added_at), id)`、`(filename, id)`、`(favorite, added_at, id)`、
`(pixiv_illust_num, id)`，条件均为 `WHERE deleted_at IS NULL`。keyset 游标用行值比较 `(sort, id) < (?, ?)`，
让 2 万级相册也能直接顺序扫描索引，而不是选 `deleted_at` 索引后全表临时排序。
索引首次创建后执行一次 `ANALYZE assets` 写入统计信息。

Live Photo 的 `meta.live` 形如
`{ "storageKey": "storage/0001/<uuid>.mov", "mime": "video/quicktime", "size": 1234 }`；
sidecar 在删除/清空回收站时与原图一起清理。

`assets_fts` 是 FTS5 trigram 表（`asset_id`、`filename`、`caption`），
由 `assets` 的 INSERT/UPDATE/DELETE 触发器维护；`q` 少于 3 个字符时退回 LIKE。

### asset_tags

`(asset_id, tag_id)` 复合主键，`asset_id` 外键级联删除；`tag_id` 只引用 `tag.db.tags`。

### duplicate_files

SHA-256 重复但未复制的来源文件：

| 列 | 说明 |
|---|---|
| `id` | UUID v7 |
| `asset_id` | 已存在的首个资产 |
| `source_path` | 导入时的绝对路径（仅用于重复提示，应用不会改动） |
| `filename` / `size` / `sha256` | 文件信息 |
| `found_at` | 记录时间 |

唯一索引 `(sha256, source_path)`，`asset_id` 外键级联删除。

### 导入 / AI 任务

任务表不在相册库里：`import_jobs` 与 `ai_jobs` 统一存在 `<dataDir>/data/task.db`，
带 `album_id` 列归属相册（见 [运行期数据目录](/guide/data-dir)）。因此全局「任务」页只打开一个库，
不再逐个打开相册数据库；相册解除关联时按 `album_id` 清理其任务行。
旧相册 `picture.db` 里的任务行会在首次打开时搬进任务库并删除旧表。

### similar_groups / similar_group_items

相似度索引的持久化结果，导入结束后由后台补齐 pHash 并重建：

| 表 | 列 |
|---|---|
| `similar_groups` | `id`、`threshold`、`representative_id`（外键级联）、`item_count`、`max_distance` |
| `similar_group_items` | `(group_id, asset_id)` 复合主键、`distance`；两个外键都级联删除 |

每个资产最多属于一个分组；资产被删除后由下一次后台重建修正。

### pixiv_asset_links

分P → 本地资产映射（**留在 `picture.db`**，因为它外键依赖 `assets(id)` 的级联删除，
删资产时映射必须同步消失）：

| 列 | 说明 |
|---|---|
| `asset_id` | TEXT PK，外键 `assets(id)` 级联删除 |
| `illust_id` / `page_index` | 分P标识，联合唯一 |

导入时按文件名 `^<illustId>_p<index>` 自动补链；文件重命名后仍按映射识别。

### pixiv_fetch_marks

后台补全断点：`illust_id`（PK）、`status`（`done` / `failed` / `missing`）、`attempted_at`（Unix 秒）。
`done` 且详情仍在 7 天缓存内 → 跳过；`failed` 30 分钟内不重复检查；`missing` 表示
Pixiv 已返回 404（删除/不可见），永久跳过，同时在相册副本与全局 `illusts.invalid_at` 记录。
每次相册补全开始前会裁剪断点：`done` 超过 7 天、`failed` 超过 24 小时的行删除，
`missing` 永久保留。

## 相册 Pixiv 副本 `data/pixiv.db`

只装本相册实际存在的作品，表结构与数据根的全局 `pixiv.db` **完全同构**，因此把相册目录复制到
另一台设备后，不需要重新联网就能读到作品详情：

| 表 | 说明 |
|---|---|
| `illusts` | 作品详情（标题/类型/简介/画师 id/分P数/尺寸/受限与 AI 类型/统计/`pages` 紧凑数组/`ugoira`/`fetched_at`/`invalid_at`）；仅凭文件名识别到的作品先写 `fetched_at = 0` 占位行；`invalid_at > 0` 表示 Pixiv 已确认删除/不可见，成功详情会清零 |
| `users` | 该相册出现过的画师（`user_id` PK、`name`、`account`、`updated_at`） |
| `tags` | Pixiv 标签字典（`tag_id` 自增主键、`name`、`name_key` 唯一、`translated_name`） |
| `illust_tags` | 作品 ↔ 标签关系，带原始顺序；随 `illusts` 级联删除 |
| `meta` | 该副本自身的状态键值 |

数据流方向：**相册副本是事实源**。拉到详情时先写本相册副本再写全局库；
`server/pixiv/database-sync.ts` 在启动、打开相册、补全/导入后把每个启用 Pixiv 的相册副本
重放进 `<dataDir>/data/pixiv.db`（更旧的快照不会回退全局详情），并按该相册的映射补占位行。
全局库因此可以随时删除重建；失效标记也随副本汇总，但比失效观察更新的成功快照会保留有效。
副本只保留被映射引用的作品：永久删除资产后，
`pruneAlbumPixivData` 会裁掉不再被引用的作品、标签关系、悬空标签与画师。

全局 `pixiv.db` 的 `PRAGMA user_version` 当前为 `5`，相册副本为 `2`（新增 `illusts.invalid_at`）。

## 任务库 `<dataDir>/data/task.db`

导入与 AI 任务不再散落在各相册库里：

| 表 | 列 |
|---|---|
| `import_jobs` | `id` PK、`album_id`、`root_path`、`status`、`cursor`、`total/processed/added/duplicates/skipped/errors`、`error`、`started_at/updated_at/finished_at` |
| `ai_jobs` | `id` PK、`album_id`、`mode`、`status`、`total/processed/errors`、`error`、`started_at/updated_at/finished_at` |

索引 `(album_id, started_at)` 与 `(album_id, root_path, status)` 支撑相册任务列表与断点续导查找。
任务历史属于数据根，**不随相册目录搬移**；相册解除关联时按 `album_id` 清理其任务行。

## 缩略图库 `<dataDir>/data/thumbnails.db`

缩略图是缓存，可以随时停止服务后删除整个 `<dataDir>/data/thumbnails.db`，再次浏览时重建。
导入是唯一的文件写入点：只把源文件原样复制进 `storage/` 并改名为新的 storageKey；入库后
**不得再修改原文件字节**（不做 EXIF 清理/回写、不原地转码或重压）。原图参与 SHA-256 内容寻址，
任何字节变化都会破坏去重、ETag 与内容哈希关联。HEIC/RAW 预览、缩略图与视频转码流是独立生成物，
会剥离 EXIF/容器元数据。

| 列 | 说明 |
|---|---|
| `album_id` + `asset_id` | 复合主键（每个尺寸一张表，尺寸即表名） |
| `mime` | 目前为 `image/webp` |
| `blob` | BLOB |
| `width` / `height` | 实际缩略图尺寸 |
| `size_bytes` | `blob` 长度，用于 LRU |
| `created_at` / `last_accessed_at` | LRU 依据 |

BLOB **按尺寸分表**存放：`thumbnails_s256`、`thumbnails_s512`、`thumbnails_s1024` …
表名由整数尺寸拼接（尺寸必须落在 16–8192 才会建表），主键因次只剩 `(album_id, asset_id)`。
分表后读写、LRU 淘汰与损坏行清理只碰目标尺寸那张表，索引更小、局部性更好，
也不会像单表那样在一次网格滚动里跨尺寸扫描百万行。
`thumbnail_sizes(size, created_at)` 登记已建出的尺寸；事实源仍是 `sqlite_master`，
登记表缺失时按表名前缀重新扫描，不会漏。

数据库 `PRAGMA user_version` 当前为 `6`；`thumb_meta(album_id, key, value)` 按相册保存
`total_bytes`，由**每张分表**的 INSERT/UPDATE/DELETE 触发器增量维护，写入时无需全表 `sum`。
写入后若总大小超过 `thumbnails.dbMaxSizeMb`，按 `last_accessed_at` 批量淘汰到上限的 90%；
`cleanupCorrupted()` 会删除 `length(blob) <> size_bytes` 的行。

`thumbnail_failures` 记录生成失败的资产与生成参数指纹（尺寸 + quality），
同一参数下命中后直接 404，避免每次网格滚动都重新解码；参数变化后会自动重试。
导入完成后后台低优先级预热最小配置尺寸；其它尺寸按请求懒生成。已有较小尺寸时立即返回并在
后台升级（stale-while-revalidate），已有更大尺寸直接复用。
开启 `thumbnails.cacheFirst` 后浏览请求只返回已缓存档位，缺图也只进后台队列并立即 404，
不再同步解码原图；前端瓦片按退避自动重试，后台生成完成后自动出现。`thumb_meta.warmup_cursor` 保存预热
游标，`warmup_completed_at` 记录最近完成时间；清空缩略图会同时重置游标。

自动维护在连接空闲关闭前和每小时执行：数据量或文件超过 `dbMaxSizeMb` 时 LRU 淘汰到 90%、
清理 `length(blob) <> size_bytes` 的坏行、`wal_checkpoint(TRUNCATE)`，并在空闲页
或“文件大小明显大于实际数据”时执行 `VACUUM`。所有连接设置
`journal_size_limit=33554432`，避免长期运行把 `<dataDir>/data/thumbnails.db-wal` 撑大。
`DELETE /albums/:albumId/thumbnails` 只清空该相册的行与负缓存并重置预热游标，之后按需重建。
可在设置里关闭 `thumbnails.autoOptimize`，或在相册设置页手动「立即整理」。

## 存储分区

```
sequence = album_meta.next_seq
partition = floor(sequence / partitionSize) + 1
storageKey = storage/<partition 补零到 4 位>/<uuidv7>.<ext>
```

- 默认 `partitionSize = 8192`，10 万文件约 13 个分区。
- 序列号在 SQLite 事务中分配，进程崩溃最多产生空号，不会重复。
- 只支持 `sequence` 模式；`setting.json` 中读到其它值会直接报错。

## 搬移与备份

1. 停止服务（释放 SQLite 句柄）。
2. 复制整个 `<albumId>` 目录。
3. 放到目标 `albumsRoot` 下，目录名保持 `<albumId>`。
4. 首次运行（还没有 `.albums.json` 登记表）会自动扫描；已有登记表时不会自动发现新目录，
   需在首页用「关联已有相册」登记。

不要只复制 `storage/` 或只复制数据库；两者必须一起搬移。
