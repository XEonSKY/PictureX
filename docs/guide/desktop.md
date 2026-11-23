# 桌面端（Electron）

PictureX 桌面端是 Web 版的 Electron 外壳：不复制 UI、不重新实现业务逻辑，
主进程启动 `dist/package` 里的 Nitro 服务，再用 `BrowserWindow` 加载
`http://127.0.0.1:<空闲端口>`。发布流水线构建 Windows、Linux 与 macOS 安装包。

## 目录

```
apps/desktop/
  src/main/          主进程（单实例、空闲端口、utilityProcess、窗口、菜单、日志、查看器协议与窗口）
  src/preload/       查看器窗口用到的 contextBridge 预加载脚本
  scripts/           prepare-runtime.mjs、run-electron.mjs、electron-builder.mjs
  resources/         splash.html、icon.png、installer.nsh（查看器「打开方式」关联，非默认）
  runtime/           prepare-runtime 生成（git 忽略）
  out/               tsc 编译产物（git 忽略）
```

`runtime/` 是唯一能被 Electron 加载的服务端产物：它统一了原生模块的
平台二进制、裁剪了多余架构，并注入了 `server/bootstrap.cjs`。

## 前置条件

- Node >= 26
- 本地开发支持 Windows / Linux / macOS；安装包在对应平台构建
- 先在仓库根目录构建 Web 与 npm 包，产出 `dist/package`：

```bash
pnpm desktop:build       # 一条命令：Web/Nitro + npm 包 + runtime + 主进程
```

依赖与二进制默认走 npmmirror（`.npmrc` 的 `registry`、`electron_mirror`、
`electron_builder_binaries_mirror`），国内网络无需额外配置。

## 开发

```bash
pnpm desktop:build      # 首次或 Web 改动后，产出完整的桌面运行时
pnpm desktop:dev        # 准备 runtime + 编译主进程 + 启动 Electron
```

只改前端时，可以连接 Nuxt 开发服务器，避免反复构建 `dist/package`：

```bash
# 终端 A
pnpm dev

# 终端 B
PX_DESKTOP_WEB_URL=http://localhost:3000 pnpm desktop:dev:web
```

`desktop:dev:web` 不启动本地 Nitro 服务，直接加载开发地址。

## 打包

```bash
pnpm desktop:build         # 先完整编译（等同上面的桌面构建）
pnpm desktop:dist          # 在 desktop:build 基础上生成 Windows x64 NSIS
pnpm desktop:dist:linux    # Linux x64 AppImage
pnpm desktop:dist:mac      # macOS 当前架构 dmg + zip
```

Linux / macOS 安装包需要在对应平台构建（CI 已覆盖），
不要把 Windows 上生成的 runtime 直接交给其它平台的 electron-builder。

桌面端脚本也支持显式架构：

```bash
pnpm --dir apps/desktop run dist:mac:x64
pnpm --dir apps/desktop run dist:mac:arm64
```

产物位于 `dist/desktop/`：

| 平台 | 产物 |
| --- | --- |
| Windows | `PictureX-<version>-win-x64-setup.exe` |
| Linux | `PictureX-<version>-linux-x64.AppImage` |
| macOS | `PictureX-<version>-mac-<arch>.dmg` / `.zip` |

- `scripts/run-electron.mjs` 与 `scripts/electron-builder.mjs` 会设置
  `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`，二进制走 npmmirror。
- better-sqlite3 13 自带 Node-API 预编译，`prepare-runtime` 直接校验并裁剪，
  不再按 Electron ABI 下载；`--force` 可重新准备 runtime。
- 安装包默认未签名；发布流水线在提供 `WIN_CSC_*` / `MAC_CSC_*` 与 Apple 公证变量时会
  自动签名/公证，缺少凭据时产物保持未签名。macOS 未签名版本首次打开需在系统设置中允许，
  或使用 `xattr -dr com.apple.quarantine` 解除隔离。

## CI 发布

`.github/workflows/release.yml` 在推送 `v` 开头的标签时触发：

1. `guard` 校验标签提交是否在 `main` 上，不在则直接失败。
2. 版本号从标签推导（`v0.2.0` → `0.2.0`），同步根、Web、桌面端与 CLI 四个
   `package.json`。
3. 四个矩阵任务分别构建 Windows x64、Linux x64、macOS arm64、macOS x64，
   每个任务同时产出当前平台的 npm tarball（含平台相关原生模块）。
4. 汇总为 GitHub Release，附件包括三个平台安装包与四个 npm tarball，
   npm tarball 命名带平台/架构后缀。

## 文档站点（GitHub Pages）

`.github/workflows/docs.yml` 在 `main` 更新 `docs/`（含 `docs/.vitepress/`）或依赖文件时
构建 VitePress 并部署到 GitHub Pages。

- 自定义域名：`picturex.xeonsky.com`，由 `docs/public/CNAME` 随产物发布。
- 仓库需要在 Settings → Pages 中把 Source 设为 **GitHub Actions**，
  并把 Custom domain 填为 `picturex.xeonsky.com`。
- DNS 添加 CNAME 记录：`picturex` → `<GitHub 用户名或组织>.github.io`。

## 运行时与原生模块

- Electron 固定 `45.4.1`（Node 26）。
- better-sqlite3 `13.x` 改用 Node-API，预编译随 npm 包发布在
  `prebuilds/<platform>-<arch>.node`，同一份二进制可被 Node 26 与 Electron 45 加载，
  不再需要 `electron-v<ABI>` 预编译或 node-gyp 重建。
- `prepare-runtime.mjs` 会校验当前平台的预编译存在，并删除其它平台的 `.node`；
  同时复制 `ffmpeg-static` / `ffprobe-static` 二进制（ffprobe 只保留当前平台/架构）。
- Nitro 入口是 ESM；`utilityProcess` 通过生成的 `server/bootstrap.cjs` 动态 import。
  bootstrap（以及 npm CLI）必须在 import 前写入 `process.env.PX_SERVER_ROOT` 和
  `globalThis._importMeta_ = { url: <入口 file URL>, env }`，否则 Nitro 顶层
  `createRequire(globalThis._importMeta_.url)` 会拿到 `file:///_entry.js` 占位地址，
  服务以 `ERR_INVALID_ARG_VALUE` 退出（表现为「服务启动失败 code 1」）。
- 升级 better-sqlite3 时确认 npm 包仍包含目标平台预编译；升级 Electron 时同步
  `prepare-runtime.mjs` 的版本断言。

## 数据与端口

- 数据目录与 CLI 共用 `~/.xeonsky/picturex`，可用 `PX_DESKTOP_DATA_DIR` 覆盖。
  同一数据目录有 `.picturex.lock` 单写者锁：桌面端运行时再启动 CLI 会明确报错，反之亦然。
- 监听 `127.0.0.1` 的空闲端口，启动后轮询 `/api/v1/health` 判定就绪。
- **自带一次性访问令牌**：主进程生成随机 `PX_AUTH_TOKEN` 传给本地服务，并在就绪后把令牌写入 Electron
  会话的 `picturex.token` cookie，主窗口与查看器窗口的同源请求自动携带；本机其它进程直连端口只能拿到
  401。`/api/v1/health` 探针与 HTML 首屏不受令牌影响，因此这一层对用户完全透明。
- 单实例锁保证只一个进程；**相册主窗口唯一**：重复启动只会恢复并聚焦已有窗口。
  查看器窗口是同一进程内的额外窗口，可以多个并存（见下方「图片/视频查看器」）。
- 关闭主窗口默认隐藏到系统托盘；托盘点击或双击可再次打开。托盘菜单提供
  「显示 PictureX」与「退出」；Linux 桌面托盘不可用时退化为关闭即退出。
- 窗口尺寸保存在 Electron `userData`；开发态 userData 为 `PictureX (dev)`，
  与安装版隔离。
- 日志：`<userData>/logs/desktop.log` 与 `server.log`，可通过菜单
  「文件 → 打开日志目录」直接打开。

## 图片/视频查看器（非默认「打开方式」）

桌面端把自己注册成常见图片/视频的**「打开方式」候选**，但**不改动系统默认查看器**——
`.ext` 的默认关联与 UserChoice 都不写，你原本用什么打开图片仍然用什么。卸载时反向清理。

- 右键图片/视频 → 「打开方式」→ 选 PictureX，即弹出一个**无侧栏**的查看器窗口。
- 一次打开多个文件会各开一个窗口（同进程内多窗口）；窗口关掉不影响单实例。
- 图片/视频字节由 Electron 主进程经自定义 `pxfile://` 协议直接读取本地文件，**HTTP 服务
  从不读取相册以外的磁盘路径**；协议只服务被显式登记过的文件，拒绝任意路径。
- 打标数据存到数据目录里的**散图库**，与相册写路径隔离（相册只读，不改相册标签文件）：
  - `<dataDir>/data/picture.db`：查看器看过的离散图片/视频记录与标签关联；不聚合相册资产；
  - `<dataDir>/data/tag.db`：查看器手工标签；相册标签与 Pixiv 标签都不写入这里；
  - **一律按内容 SHA-256 关联**，不按路径——同一张图改名字或移动位置后重新打开，
    标签与记录依旧跟着这张内容走。
  - 浏览器里的 `/library` 也能浏览同一批散图记录与标签，不需要打开桌面查看器。

> 只有桌面壳具备这个查看器能力；浏览器里访问 `/viewer` 会显示「仅桌面端可用」。

## 自动更新与签名

- 安装版启动后会每 6 小时检查一次更新，「帮助 → 检查更新」可手动触发。
- 更新源通过 `PX_UPDATE_URL` 指定 generic 目录（release 产物里的 `latest.yml` 与安装包）。
  构建时设置该变量会额外生成 `latest.yml`；未设置时只产出安装包。
- Windows 签名读取 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`，macOS 读取
  `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`；macOS 公证还需要 `APPLE_ID`、
  `APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。缺少凭据时产物为未签名版本。
- macOS 使用 hardened runtime 与 `resources/entitlements.mac.plist`，公证由
  `scripts/notarize.cjs` 在 afterSign 阶段可选执行。
- Linux AppImage 的自动更新依赖 AppImage 运行环境，当前仅提示手动下载。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PX_DESKTOP_DATA_DIR` | 覆盖数据目录（默认 `~/.xeonsky/picturex`） |
| `PX_DESKTOP_RUNTIME` | 指定 `bootstrap.cjs` 路径，跳过默认 runtime |
| `PX_DESKTOP_WEB_URL` | 直接加载该地址，不启动本地服务（配合 Nuxt dev） |
| `PX_AUTH_TOKEN` | API 访问令牌；桌面端每次启动自动注入一次性令牌（无需手动设置），CLI/Web 端局域网开放时才手动配置 |
| `PX_UPDATE_URL` | 更新 feed 目录（generic），例如 `https://example.com/picturex/` |

## 故障排查

- 提示「缺少桌面运行时」：先执行 `pnpm build:npm`，再执行 `pnpm desktop:dev`。
- 服务启动失败：查看 `<userData>/logs/server.log`，确认 127.0.0.1 未被安全软件拦截。
- 原生模块报错：确认 `apps/desktop/runtime/server/node_modules/better-sqlite3/prebuilds/`
  中存在当前平台的 `.node`，重新执行 `pnpm desktop:build`（或 `--force` 准备 runtime）。
- 不要提交 `apps/desktop/runtime`、`out` 或 `dist`。
