# 快速开始

读完你能在 10 分钟内跑起 PictureX、创建第一个相册并完成一次本地导入。

## 环境

- Node.js **>= 26**
- pnpm（仓库使用 pnpm 工作区；npm/yarn/bun 也可运行根脚本）
- Windows / macOS / Linux

仓库自带 `.npmrc`，默认使用 npmmirror（含 Electron 与 electron-builder 二进制镜像）：

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 安装与启动

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。开发期数据落在仓库根 `.dev/data/`（已 git 忽略）。

首次启动会：

1. 创建数据目录与 `setting.json`（缺失字段补默认并原子回写）。
2. 初始化模型清单 `models/index.json`。
3. 注入主题脚本到 `<head>`，避免深色主题首屏闪烁。

## 第一个相册

1. 首页点击「创建相册」，填写名称（例如 `2026 旅行`）。
2. 进入相册，点击「导入」，点「浏览…」选本地文件夹（也可以直接粘贴路径，例如 `D:/Photos/2026`）。
3. 导入会跳转到「任务」页，实时显示进度：
   - `total`：导入到的受支持文件数
   - `added`：新入库
   - `duplicates`：SHA-256 完全相同的文件（记录来源路径，不复制）
   - `skipped` / `errors`：不支持或读取失败
4. 导入完成后返回相册，瀑布流按入库时间倒序展示。

支持格式：JPEG/PNG/GIF/WebP/AVIF/HEIC/TIFF/BMP/SVG/MP4/MOV/WebM/MKV/AVI。
视频元数据与抽帧依赖 ffmpeg；安装时若 `ffmpeg-static` 下载失败，`scripts/ensure-ffmpeg.mjs`
会从镜像补齐，失败时只影响视频缩略图。

## 浏览与查看

进入相册后侧边栏换成相册上下文：照片 / 标签 / 重复文件 / 相似图片 / 回收站 / 任务 / 设置；
标签筛选在照片页顶部下拉（带命中数），不再在侧栏列出数量。

- 照片页支持文件名搜索与排序（最新/最早/拍摄时间/文件名），布局见[导航与布局](/guide/navigation)。
- 点击缩略图打开查看器：滚轮缩放、拖拽平移、`Esc` 返回、方向键切换。
- 右侧面板展示 EXIF、SHA-256、pHash、存储键、标签与相似图片；一张图可以挂多个标签，
  点标签上的 `×` 移除，用「选择标签」继续追加。

## 支持的格式

静态图（JPEG/PNG/WebP/AVIF/TIFF/BMP）、动图（GIF/动画 WebP）、SVG、视频（MP4/MOV/WebM/MKV/AVI）
与 Live Photo（图片 + 同名 MOV/MP4 sidecar，sidecar 会一起导入）。

HEIC/HEIF 与常见 RAW 会在导入时提取 JPEG 预览；原图保留，查看器显示预览。
浏览器不能原生播放的视频（MKV/AVI 等）由内置 ffmpeg 实时转码为 MP4 流。

## 去重、相似与 AI

- `/albums/<id>/duplicates`：按 SHA-256 列出完全相同的来源文件，可移除记录；
  应用不删除相册目录以外的源文件。
- `/albums/<id>/similar`：按 pHash 汉明距离分组，可调阈值、批量保留最佳。
- `/albums/<id>/tags`：新建、改名、改色、删除标签（标签主数据在 `tag.db`；支持搜索、排序与分页）。
- 相册页工具条的「AI 打标」：零样本（CLIP）/ 生成式（ViT-GPT2）/ 外部接口；
  本地模型需先在「设置 → 模型管理」下载。
- 该相册的任务：侧边栏「任务」进入 `/albums/<id>/jobs`，仍留在相册二级侧栏里，只显示本相册的导入/打标/下载任务。
- 相册卡片菜单里的「解除关联」只把相册移出列表，磁盘目录与文件保留；需要重新加入时用首页「关联已有相册」。

## 设置

设置按模块分页，左侧模块导航：主题外观、语言、存储与路径、缩略图与视频、
去重与相似、AI 打标、Pixiv、模型管理。语言切换在「设置 → 语言」，切换即时生效。

## 生产运行（CLI）

```bash
pnpm build
pnpm build:npm
npx ./dist/package web --port 8830 --data-dir /var/lib/picturex
```

或全局安装后，对局域网开放必须同时设置访问令牌：

```bash
PX_AUTH_TOKEN='一段足够随机的字符串' picturex web --host 0.0.0.0 --data-dir /var/lib/picturex
```

`--host` 不是回环地址且未设置 `PX_AUTH_TOKEN` 时，服务会**直接拒绝启动**（CLI 与 Nitro
启动守卫都会拦），因为此时接口对局域网开放、没有任何认证，同网段访客可读取全部相册并
借 ffmpeg 转码执行任意程序。首次可用 `http://<地址>:<端口>/?token=<令牌>` 让浏览器落到 cookie。
确实要在可信网络无鉴权开放时，显式设置 `PX_ALLOW_INSECURE_BIND=1`（不建议）。

服务会校验 `Origin` 与 `Host`：绑定回环时只接受回环 Host；绑定 `0.0.0.0` 时接受本机各网卡的
IP 字面量；用反向代理或自定义域名访问需把域名加入 `PX_ALLOWED_HOSTS`（逗号分隔），否则
`403 host_not_allowed`。

默认数据目录：开发 `<仓库根>/.dev/data`，生产 `~/.xeonsky/picturex`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 构建 Nitro 产物到 `dist/nuxt` |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 三连 |
| `pnpm check:i18n` | 校验错误码翻译 |
| `pnpm tokens:gen` | 由 JSON 重新生成 `design-tokens.css` |
| `pnpm logo:gen` | 重新生成 Logo PNG 与 favicon |
| `pnpm bench:ingest --count 2000` | 入库基准（需先 `pnpm dev`） |
| `pnpm docs:dev` | 文档站点 |

## 排查

| 现象 | 处理 |
|---|---|
| 模型下载失败 | 默认使用 ModelScope；可设 `PX_MODEL_SOURCE=hf-mirror` 回退 HF 镜像，`PX_MODEL_MIRROR` 覆盖 HF 主机名 |
| 视频没有缩略图 | 检查设置中 ffmpeg 是否启用，`node_modules/ffmpeg-static/ffmpeg.exe` 是否存在 |
| 端口被占用 | `pnpm dev --port 3001` 或 CLI `--port` |
| 数据位置不对 | 显式传 `-dataDir <path>` 或设置 `NUXT_DATA_DIR` |
