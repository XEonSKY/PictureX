# 开发与工作流

读完你能搭起本地开发环境、按仓库约定提交改动，并知道新增业务资源时要动哪些文件。

> 领域规则以代码与 `docs/` 为准；本页只提供可执行的工作流入口。

## 环境

- Node **≥ 26**（`.nvmrc` 与 `engines.node` 锁定），pnpm **12**（`packageManager` 与
  `pnpm-workspace.yaml` 管理 workspace；本机未全局安装时用 `npx pnpm@12.21.0 ...`）。
- pnpm 包存储固定在仓库内 `.pnpm-store/`（`pnpm-workspace.yaml` 的 `storeDir`，已 gitignore），
  不会在分区根生成 `<盘符>:\.pnpm-store`；换机器后可删除该目录，由下一次 `pnpm install` 重建。
- 原生依赖：`better-sqlite3`、`sharp`、`onnxruntime-node`、`ffmpeg-static` / `ffprobe-static`。
  首次 `pnpm install` 会经 `scripts/ensure-ffmpeg.mjs` 从镜像补齐 ffmpeg 二进制。
- 国内网络默认走 npmmirror；模型下载默认 ModelScope，可用 `PX_MODEL_SOURCE=hf-mirror` 回退。
- Node 主版本不足时 `scripts/task.mjs` 与 CLI 入口都会直接报错退出。

## 常用命令

```bash
pnpm install            # 安装依赖 + 生成 Nuxt 类型 + 补 ffmpeg
pnpm dev                # Nuxt 开发服务器（默认 http://localhost:3000）
pnpm verify             # check + bootstrap + lint + typecheck + test（提交前必跑）

pnpm check              # tokens + i18n 错误码 + 前端硬编码 + docs 内链四项静态门禁
pnpm check:tokens       # design-tokens.css 与 theme-tokens.json 是否一致
pnpm check:i18n         # ApiError 错误码是否在 zh-CN / en-US 都有翻译
pnpm check:hardcode     # .vue 中是否出现用户可见中文或十六进制色值
pnpm check:docs         # docs/ 站内链接是否指向存在的页面
pnpm lint / typecheck / test
pnpm test:coverage      # 覆盖率门禁（statements 70 / branches 55 / functions 70 / lines 70）

pnpm tokens:gen         # 修改 Token 源后重新生成 design-tokens.css
pnpm logo:gen           # 重新生成 Logo PNG / favicon
pnpm docs:dev / docs:build / docs:preview
pnpm bench:ingest       # 入库基准（需先 pnpm dev）
pnpm clean              # 删除 dist/.nuxt/runtime 等可再生产物（保留 .dev/data）
```

所有根脚本都经 `scripts/task.mjs` 转发，自动识别 pnpm / yarn / bun / npm。

## 开发数据目录

优先级：`-dataDir` > `NUXT_DATA_DIR` > 开发 `<workspaceRoot>/.dev/data` > 生产 `~/.xeonsky/picturex`。

- 数据目录有单写者锁 `.picturex.lock`。开发服务器未退出时再起一个实例会因锁失败而退出；
  需要跳过锁时用 `PX_NO_LOCK=1`（仅限测试/特殊部署）。
- 停止开发服务器要杀 Nuxt 子进程：只结束 `pnpm dev` 包装进程不会释放锁。
- 数据库布局：数据根用 `data/*.db`，相册用 `<album>/data/*.db`；
  任何新数据库文件都必须经 `server/utils/data-dir.ts` 的 helper 定位，禁止手写路径。

## 分支与提交

```
main
 └─ feat|fix|chore/<scope>-<summary>     功能分支
     └─ feat/pN-<sub-id>                 子代理分支（可选）
```

- **未经用户明确要求，禁止 commit / tag / push**；要求提交时按逻辑改动分批，
  一个提交只做一件事，不把清理、重构、文档混在一起。
- **只有用户明确表示“发布新版本”才打 tag**；普通提交不打 tag。
- 版本遵循 semver，发布 tag 为 `vX.Y.Z`（当前稳定版 `v0.1.2`）。
  推送 `v*` 标签即自动编译并发布：`vX.Y.Z-rc.1`、`vX.Y.Z-beta.1`、`vX.Y.Z-alpha.1`
  等带后缀的按预发行版（prerelease）发布，无后缀的 `vX.Y.Z` 按正式版（latest）发布。
- 发布版本标题：`<type>(<scope>): <X.Y.Z> <标题内容>`，例 `feat(release): 0.1.0 首个正式版本`。
- 非发布提交标题：`<type>(<scope>): <当前稳定版>+<修订次数> <标题内容>`，
  例当前 `0.1.2` 的第 2 次修订 → `fix(server): 0.1.2+2 修正 Pixiv 分P映射`；
  修订次数从该稳定版发布后从 1 开始递增。
- 功能分支验收通过后 `--no-ff` 合并 `main`。
- 任何影响行为、命令、路径、状态机或错误码的改动，必须在同一提交更新 `docs/` 相关页面。
- 提交前跑 `pnpm verify`；文档改动至少跑 `pnpm docs:build`。
- 不提交 `.env`、密钥、数据库文件、`dist/`、`.dev/`、用户数据目录、下载分片。
- PR 描述包含：变更摘要、验收命令与结果、决策记录（未覆盖项/依赖理由/冲突取舍）。

## 改动落点

新增业务资源（相册、资产、标签、任务等）的最小闭环：

1. `server/database/schemas/` 定义表，并同步 `server/database/*.ts` 的幂等 DDL 与版本号。
2. `server/domain/` 实现查询与 DTO；路由只做校验与编排。
3. `server/hono/routes/` 链式声明路由，接入 `validateJson` / `validateQuery`，
   错误只抛 `ApiError`（Problem Details 由 `app.onError` 统一输出）。
4. `app/pages/` / `app/components/` 实现界面；文案写入 `i18n/locales` 两个文件。
5. 错误码同时补 zh-CN 与 en-US，运行 `pnpm check:i18n`。
6. 更新 `docs/api/` 对应端点页与 `docs/guide/album-format.md`（涉及存储格式时）。
7. 补 Vitest（2xx/4xx/422/404/409 与关键状态机），运行 `pnpm verify`。

前端优先复用既有 composable，而不是在页面里再写一份：

| 场景 | 复用点 |
|---|---|
| API 调用与错误翻译 | `useApi()`（禁止裸 `fetch`） |
| 相册上下文 / 标签 | `useAlbumContext()`、`useTagManager()` |
| 全局设置表单 | `useSettings()` |
| 视口内才加载图片 | `useVisibleImage()` |
| keyset 分页列表 | `useCursorFeed()` |
| 日期 / 数字 / 文件大小 | `useFormat()` |
| 视图模式与矩阵列数偏好 | `utils/view-preferences.ts` |
| Pixiv 后台补全状态 | `utils/pixiv-auto-fetch.ts` |

## 约定速查

- 4 空格缩进、单引号、分号；不靠 `eslint-disable` 绕过 `indent`。
- UI 只用 AntdvNext；写组件/主题前先用 `npx @antdv-next/cli info|demo|doc` 确认 API。
- 颜色、间距、圆角、字号、阴影、动效全部走 `--px-*` Token；`.vue` 不硬编码色值与间距。
- 用户可见文案禁止硬编码，错误码必须双语；用户内容（相册名、标签名、文件名、模型名）不翻译。
- 数据库时间列统一 `INTEGER`（Unix 秒），API 边界才转 ISO-8601；JSON 只存 `text`。
- 导入是唯一的原图写入点：只做原样复制 + 改名，入库后绝不改写原文件字节。
- 破坏性操作（批量删除、清空回收站、清理重复）必须带 `confirm: true`。
- 一个事实一个 home：格式与操作指南在 `docs/`，代码注释只写“为什么”。

## 常见问题

- **端口/锁被占用**：先确认 `.dev/data/.picturex.lock` 里的 pid 是否仍在运行；桌面端与 CLI
  不能同时写同一数据目录。
- **原生模块加载失败**：better-sqlite3 13 起改用 Node-API，预编译随 npm 包发布在
  `prebuilds/<platform>-<arch>.node`，不再按 Node/Electron ABI 下载；Electron 仍必须加载
  `prepare-runtime.mjs` 产出的 `runtime/`，不要直接加载 `dist/package`（其中的原生模块按
  当前 Node 平台准备，且需要 `bootstrap.cjs` 注入 `PX_SERVER_ROOT`）。
- **缩略图/图片不显示**：先看 `GET /albums/:id/thumbnails` 的 `generator` 与 `maintenance`
  状态，再看 `GET /jobs/disk` 是否有解码/预热任务在跑。
- **Pixiv 网络失败**：默认走本机代理；确认 `setting.json.pixiv.proxyUrl` 或切换 `direct`，
  并在「设置 → Pixiv」用 `POST /pixiv/test` 验证。
