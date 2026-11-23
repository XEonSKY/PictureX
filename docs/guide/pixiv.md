# Pixiv 集成

只对单个相册按需启用。启用后，打开形如 `127978234_p0.jpg` 的图片详情时，
PictureX 会从 Pixiv App API 读取作品信息，并把本地已管理的其它分P一起展示。

## 启用

1. 打开「设置 → Pixiv」，粘贴 Pixiv refresh token 并配置网络方式。
2. 进入相册「设置 → 相册级功能」，打开「启用 Pixiv 支持」。
3. 需要自动补齐缺失分P时，再打开「自动下载缺失分P」。

自动下载默认关闭。关闭时，详情页会列出缺失分P，由你点击「下载缺失分P」后才开始下载。

## 登录（仅 Refresh Token）

PictureX 不提供浏览器登录或登录页反代。请在外部获取 refresh token 后，粘贴到
「设置 → Pixiv → 使用 Token 登录」。

### 获取 Refresh Token

- **Pixez 客户端**：登录后进入「账号 → 编辑账号」，点击「Export Token」复制
  refresh token（该入口要求账号已验证邮箱）。
- **开源工具**：例如 `gppt login`（get-pixivpy-token）或 `pixiv_auth.py`，在浏览器完成
  Pixiv 登录后命令行会输出 `refresh_token`。
- 不要使用来历不明的在线“取 Token”网站。refresh token 等价于账号访问权限，泄露后
  应立即在 Pixiv 修改密码并重新获取。

Token 登录本身也需要服务端能访问 `oauth.secure.pixiv.net`；请先在下方配置可用的
代理。token 只保存在本机 `<dataDir>/setting.json`，`GET /settings` 返回
`********` 掩码。Pixiv 可能轮换 refresh token，服务端会自动保存新值。

受限内容（`x_restrict > 0`）需要有效 Token 才能读取；未配置时仍可看到本地已有的分P。

## 国内网络

| 模式 | 行为 |
|---|---|
| 直连 | 使用系统 DNS 与 TLS，适合可正常访问 Pixiv 的网络 |
| HTTP 代理 | 通过 `http://host:port` 的 CONNECT 隧道访问 |
| SOCKS5 代理 | `socks5://host:port` / `socks5h://host:port`，由代理侧解析域名 |

默认网络模式是 `proxy`，代理地址默认 `socks5://127.0.0.1:10808`。
`i.pximg.net` 图片请求始终带 Pixiv `Referer`。

## 元数据与分P

- 作品信息与标签列表缓存到相册副本 `<album>/data/pixiv.db`（表结构与全局库同构），默认 7 天内不重复请求；
  同一份数据同时写入全局 `<dataDir>/data/pixiv.db` 的 `illusts/users/tags/illust_tags`。另一个相册
  遇到同一作品时可直接复用全局缓存，不再请求 Pixiv。详情面板的刷新按钮会强制更新并同时刷新
  两份缓存。
- 分P与本地资产的映射写入相册 `picture.db` 的 `pixiv_asset_links`（外键依赖 `assets`，因此不拆进副本库）。
  导入时文件名匹配即可自动关联；文件被重命名后仍按映射关系识别。
- 缺失分P按「设置 → Pixiv → 分P下载质量」选择原图 / 大图 / 中图，下载后通过正常入库
  流程写入相册（SHA-256 去重、存储分区、`index.json` 对账）。
- 未配置 Token 时不会发起下载；已删除（回收站）的同内容资产不会被自动恢复。
- AI 标记按 `illust_ai_type` 判断：`1` 为非 AI，`2` 为 AI 生成，`0` 为未设置；
  不能用 `> 0` 判断，否则普通作品会被误标。
- Pixiv 作品标签只作为作品详情展示（`pixiv.db.illust_tags`），**不写入相册或全局 `tag.db`**；
  相册标签页、全局图库筛选与 AI 打标都只看到应用标签。
- Pixiv 作品不参与 AI 打标：导入时在 `assets.meta.pixiv` 记录身份，AI 候选同时排除
  `pixiv_asset_links` 与 Pixiv 文件名，避免覆盖作者维护的标签。

## 导入时先行建映射

文件名符合 `pixivId_pN` 时，图片入库的同一流程会立即创建映射，不等待联网：

- 相册 `picture.db.pixiv_asset_links` 写入 `asset_id ↔ illust_id/page_index`；
- 全局 `pixiv.db.illusts` 写入 `fetched_at = 0` 的占位行；
- 导入完成后在后台触发作品信息补全与全局汇总；拉取到的完整详情写入相册副本 `<album>/data/pixiv.db`
  与全局 `illusts`，作为最终数据。占位阶段不写详情，因此不会覆盖后续同步结果。
- 相册 `data/pixiv.db` 副本只保留被本相册映射引用的作品，避免随目录跨设备同步无关数据；
  `picture.db.pixiv_fetch_marks` 在每次相册补全前裁剪：`done` 超过 7 天（元数据缓存已过期）、
  `failed` 超过 24 小时的行删除，`missing` 永久保留。

## 全局 Pixiv 库

`<dataDir>/data/pixiv.db` 汇总所有启用 Pixiv 的相册，只保留 5 张表：

- `illusts`：所有作品完整详情（标题、作者 ID、标签关系通过 `illust_tags`、分P、ugoira 等）；
- `users`：画师信息，按 `user_id` 唯一；
- `tags`：Pixiv 标签字典，`name_key` 大小写不敏感唯一；
- `illust_tags`：作品 ↔ 标签关系，带原始顺序；
- `meta`：迁移与最近同步状态。

`pages` 以紧凑数组 `[[square, medium, large, original], ...]` 存储，数组下标就是分P序号。
按文件名识别到的作品先写 `fetched_at = 0` 占位行；详情同步后覆盖，更旧的快照不会回退数据。
应用在启动、打开相册、补全或导入后自动合并汇总；**asset 映射只存在于相册库**，所以复制整个
相册目录到另一台设备时，Pixiv 映射与作品信息会一起带走。

## 首页 Pixiv 资料库

首页提供「Pixiv 资料库」入口（侧栏也有 Pixiv），打开 `/pixiv` 即可脱离相册浏览全局库：

- 顶部统计作品/已补全/待补全/已失效/画师/标签/动图数量与最近汇总时间；
- 图片优先使用本地相册里的同一分P，本地没有才从 Pixiv 拉取并缓存原图；
- 搜索标题、作品 ID、画师名/账号、Pixiv 标签名或译名；按补全状态、类型、标签、画师排序筛选，
  列表使用 keyset 游标分页；与照片页一致支持瀑布流 / 矩阵 / 列表三种视图，矩阵可用 ± 调整
  列数，视图与列数会记住；
- 启用 Pixiv 的相册在未保存过排序时默认按作品 ID 从大到小；照片页可按作品标题/画师/
  Pixiv 标签搜索，并保留独立的 Pixiv 标签筛选；
- 详情抽屉展示标题、画师、发布时间、尺寸、浏览/收藏、标签、简介与全部分P缩略图，
  点击分P或主图会打开全屏预览（←/→ 切换分P，Esc 关闭），并列出该作品在哪些相册里有
  本地分P，可直接跳转到对应资产；
- 占位作品会标记「待补全」；已删除/不可见的作品标记「已失效」，可用状态筛选单独查看，
  详情抽屉会说明已停止自动同步，「刷新详情」是唯一会重试失效作品的入口；
- 「同步数据库」立即执行一次全局汇总；「后台补全」区域复用设置页的进度、暂停/继续与开始补全。

封面与分P预览通过服务端 `GET /pixiv/library/image` 加载：先查已登记相册的本地分P，
命中时直接返回该资产的原图/缩略图；本地没有时，大图/原图会下载 Pixiv 原图并缓存到
`<dataDir>/data/cloud.db.pixiv_locals`，小尺寸继续轻量代理。地址只从库内 `pages` 读取；
所有取图调用都走 `pixivImageStream`，它先校验 pximg 主机白名单再发请求。
页面只做预览，**不会修改任何原始文件**；large/original 会写 `cloud.db`。

`cloud.db` 有容量上限：默认 2 GiB，可用 `PX_PIXIV_CLOUD_MAX_MB`（≥64）调整。
每次写入后按 `last_accessed_at` 精确淘汰到上限的 80%，总量统计走 `size_bytes`
覆盖索引，不会为统计去读 BLOB 页；缓存的都是可重新下载的原图，淘汰不影响相册数据。
未配置 Token 或网络不可用时，作品信息仍可浏览，封面会按请求失败处理。

## 后台自动补全

启用 Pixiv 的相册会在服务启动 15 秒后、以及每次打开或重新开启时，自动把尚未缓存的作品信息
排队补全（`server/pixiv/auto-fetch.ts` + `server/plugins/06-pixiv-auto-fetch.ts`）：

- 全局只有一个 worker，多个相册也按队列**串行**处理；同一作品只请求一次。
- 每个需要联网的作品之间随机等待，速度由「设置 → Pixiv → 补全速度」控制：
  慢速 1–3 秒、标准 100–1000ms、快速 50–300ms。已有相册元数据（7 天缓存内）或处于断点
  冷却期的作品在开始前就被过滤，**不计入进度 total/processed**，也不会逐个检查；
  全局缓存命中但仍需回填本相册详情的作品仍会处理。
- 只拉取元数据，**不会**自动下载缺失分P、也不写 `tag.db`；下载仍需在详情页手动触发或
  由相册 `pixivAutoDownload` 控制。
- 作品返回 404（删除/不可见）时，立即在相册副本和全局 `pixiv.db` 记录 `invalid_at`，
  此后不再进入补全队列、不再自动联网；已有详情保留可浏览，详情抽屉提供手动「刷新详情」重试。
- 未配置 Token 时不发起网络请求；鉴权失败会停止本轮；单个作品被删除/不可见只记为
  `deleted` 并继续，不会因为连续 5 个失效作品把整轮任务停掉。连续 5 次其它失败会暂停，
  2 分钟后自动重试。关闭相册 Pixiv 或删除相册会在下一个作品处停止。
- 规避限流：所有 Pixiv API 请求共享一个最小间隔闸门（150ms + 抖动）；每 60 次真实网络请求
  休息 15–20 秒**只在自动补全的单相册本轮内计数**，详情页、资料库与 OAuth 不触发批次休息。
  收到 429 时按 `Retry-After` 暂停整轮（1–30 分钟）并自动续跑，之后的请求会按惩罚倍数降速，
  连续成功后逐步恢复。
- 「设置 → Pixiv → 后台补全」轮询 `GET /pixiv/auto-fetch`，显示当前相册、`processed / total`
  进度条、联网/缓存回填/已是最新/已失效/失败计数、限流暂停原因与自动继续时间；
  「立即补全」会跳过冷却把已启用 Pixiv 的相册重新入队。
- 每个作品的补全结果写入相册 `picture.db.pixiv_fetch_marks`：已完成的作品重启后直接跳过，
  失败作品 30 分钟内不重复检查，已失效作品永久跳过，因此退出后再次启动会从断点继续，
  而不是从头重新检查。
- 「暂停补全」会把暂停状态写入 `setting.json` 并清空队列/自动重试，运行中的任务在当前作品
  结束后停止；重启后仍保持暂停。点「继续补全」重新排队，已处理的作品按断点跳过。

## 动图

`type = ugoira` 的作品会读取 `/v1/ugoira/metadata`。播放时前端拉取 zip，
在浏览器端解压帧并按 Pixiv 提供的逐帧延时绘制到 canvas；不依赖服务端解压库。
zip 缓存位于 `<dataDir>/cache/pixiv/ugoira/<illustId>.zip`。

## 数据位置

```
<album>/data/picture.db
  pixiv_asset_links    (illust_id, page_index) → asset_id（外键依赖 assets，留在主库）
  pixiv_fetch_marks    后台补全断点（仅本相册作品）

<album>/data/pixiv.db
  illusts users tags illust_tags meta   本相册用到的作品/画师/Pixiv 标签（与全局库同构）

<dataDir>/data/pixiv.db
  illusts users tags illust_tags meta   所有相册副本的重放汇总（无 asset 映射，可删除重建）

<dataDir>/cache/pixiv/
  downloads/<illustId>/    下载中的临时文件（成功入库后删除）
  ugoira/<illustId>.zip    动图压缩包缓存
```

## 安全边界

- 只从 `app-api.pixiv.net` / `oauth.secure.pixiv.net` / `i.pximg.net` / `s.pximg.net`
  拉取数据；图片与 zip URL 还会做主机白名单校验，避免 API 返回任意地址造成 SSRF。
- Pixiv token 不会返回给前端明文；所有 API 调用都在服务端完成。
- 代理只用于 Pixiv 请求，不影响其它网络请求。
