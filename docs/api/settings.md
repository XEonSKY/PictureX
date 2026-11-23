# 设置 API

读完你能读写 `setting.json`、切换主题，并知道哪些字段可热更新。

## GET /settings

```json
{
    "data": {
        "schemaVersion": 1,
        "albumsRoot": "D:\\Workspace\\PictureX\\.dev\\data\\albums",
        "modelsRoot": "D:\\Workspace\\PictureX\\.dev\\data\\models",
        "storage": { "default": "local", "partitionSize": 8192, "partitionMode": "sequence" },
        "thumbnails": { "dbMaxSizeMb": 2048, "sizes": [256, 512, 1024], "quality": 80, "autoOptimize": true, "cacheFirst": false },
        "ai": {
            "labelMode": "zero-shot",
            "device": "auto",
            "localModelId": "clip-vit-base-patch32",
            "captioningModelId": "vit-gpt2-image-captioning",
            "external": { "enabled": false, "baseUrl": "", "apiKey": "", "model": "" },
            "autoTag": false,
            "downloadConcurrency": 4,
            "autoResumeDownload": false
        },
        "similarity": { "enabled": true, "algorithm": "phash", "hammingThreshold": 8 },
        "pixiv": {
            "refreshToken": "********",
            "accountId": "42",
            "accountName": "Pixiv Tester",
            "account": "tester",
            "premium": true,
            "networkMode": "proxy",
            "proxyUrl": "socks5://127.0.0.1:10808",
            "imageQuality": "original",
            "autoFetchSpeed": "normal",
            "autoFetchPaused": false
        },
        "ffmpeg": { "enabled": true, "path": "auto" },
        "theme": { "preset": "light", "overrides": {} },
        "i18n": { "defaultLocale": "zh-CN", "locales": ["zh-CN", "en-US"] }
    },
    "meta": { "dataDir": "D:\\Workspace\\PictureX\\.dev\\data" }
}
```

## PATCH /settings

深合并的部分更新，返回完整设置：

```json
{
    "thumbnails": { "dbMaxSizeMb": 4096, "quality": 85 },
    "similarity": { "hammingThreshold": 6 }
}
```

可更新字段：`albumsRoot`、`modelsRoot`、`storage`、`thumbnails`、`ai`（含 `external`）、
`similarity`、`pixiv`、`ffmpeg`、`theme`、`i18n`。

`storage.partitionMode` 只接受 `"sequence"`；其它值返回 422。当前构建只支持
`storage.default = "local"`，其它后端返回 422 `storage_backend_not_implemented`，
手动写入 `setting.json` 也会在启动时被拒绝。
路径字段会在加载/保存设置时按需创建目录（`albumsRoot`、`modelsRoot`）；修改 `albumsRoot`
会把旧登记表合并到新位置。

- `ai.external.apiKey` 与 `pixiv.refreshToken` 在响应中始终是 `********`；把该掩码原样提交表示
  “保持原值”，提交空字符串才会清空。`pixiv.networkMode=proxy` 时 `proxyUrl` 支持 HTTP CONNECT、
  `socks5://` 与 `socks5h://`；地址里的 `user:pass@` 凭据在响应中一律以 `***` 掩码返回，提交带 `***`
  的地址会回填已存的真实凭据（只改 host/port 不会丢密码），无凭据的地址不受影响。
- `ai.external.baseUrl` 保存时只允许 `https://`，`http://` 仅限 `localhost`/`127.0.0.1`/`::1`
  回环，否则返回 422 `validation_failed`（防止 API Key 与原图明文过网）。历史写入的非合规地址不会
  让应用崩溃，但下次编辑该字段时必须改成合规值。
- `pixiv.autoFetchSpeed` 为后台补全间隔（`slow` 1–3s /
  `normal` 100–1000ms / `fast` 50–300ms）。登录、网络与下载质量详见 [`/api/pixiv`](/api/pixiv)。
- 有模型下载进行中时修改 `modelsRoot` 或 `ai.downloadConcurrency` 返回 `409 settings_busy`。

## PATCH /settings/theme

```json
{ "preset": "dark", "overrides": { "color-brand": "#0A59F7" } }
```

返回 `{ "data": { "preset": "dark", "overrides": {...} } }`。
覆盖项会被白名单过滤，非法值被丢弃。

## GET /settings/ai/devices

检测本机 ONNX Runtime 可用的执行后端，并给出当前设置下实际生效的设备：

```json
{
    "data": {
        "platform": "win32",
        "arch": "x64",
        "preference": "auto",
        "available": [
            { "id": "cpu", "label": "CPU", "kind": "cpu" },
            { "id": "dml", "label": "DirectML", "kind": "gpu" }
        ],
        "active": "dml",
        "accelerated": true,
        "acceleratorModelId": "clip-vit-base-patch32-fp16",
        "acceleratorInstalled": true
    }
}
```

- `available` 来自 `onnxruntime-node` 的 `listSupportedBackends()`，不是平台猜测。
- `active` 为 `null` 表示回退 CPU；`accelerated` 与 `active` 同步。
- 只有对应模型的 `-fp16` 条目已安装时才会启用加速；`ai.device` 为 `cpu` 时始终 CPU。

## 错误

| status | code |
|---|---|
| 409 | `settings_busy` |
| 422 | `validation_failed` / `storage_backend_not_implemented` |
| 500 | `internal_error` |

## 安全

`ai.external.apiKey` 与 `pixiv.refreshToken` 只保存在本机 `setting.json`；日志通过 Pino `redact`
脱敏，API 响应只返回掩码。`pixiv.proxyUrl` 里的 `user:pass@` 同样只回显掩码，绝不把 `***` 落盘。

所有请求都有 **2 MiB 请求体上限**（在鉴权之前只读声明的 `content-length` 头判定）：超限返回
`413 payload_too_large`。合法请求体都被 Zod 限制在 ≤500 条目，远低于该上限。

设置环境变量 `PX_AUTH_TOKEN` 后，除 `/api/v1/health` 外所有 API 都要求令牌：
`Authorization: Bearer <token>`、`x-picturex-token`、`?token=<token>` 或 `picturex.token` cookie。
浏览器首次访问 `http://<host>:<port>/?token=<token>` 会把令牌落到 cookie 并从地址栏移除。
**桌面端会自动生成一次性 `PX_AUTH_TOKEN`** 并把令牌写入 Electron 会话 cookie，本机其它进程直连端口
会拿到 401（详见 [`/guide/desktop`](/guide/desktop)）。
数据目录还会写入 `.picturex.lock`，同一目录同时只允许一个 PictureX 进程写入；
确实需要并行时用 `PX_NO_LOCK=1` 显式关闭（自行承担并发写风险）。
