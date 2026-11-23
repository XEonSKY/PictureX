# @xeonsky/picturex

PictureX：本地优先、支持 i18n、可运行时换肤的 AI 相册。
每个相册都是自包含目录（index.json / data/*.db / storage），
缩略图缓存统一存放在数据根目录的 data/thumbnails.db 中（按 album_id、尺寸分表隔离）。

## 运行

```bash
npx @xeonsky/picturex web

# 或全局安装
npm i -g @xeonsky/picturex
picturex web
```

## 常用参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `-p, --port <port>` | 监听端口 | 8830 |
| `-H, --host <host>` | 监听地址（局域网开放用 0.0.0.0） | 127.0.0.1 |
| `-d, --data-dir <dir>` | 数据目录 | `~/.xeonsky/picturex` |
| `-o, --open` | 启动后自动打开浏览器 | 关闭 |

## 数据目录

- `<dataDir>/setting.json`：全局设置。
- `<dataDir>/albums/<albumId>/`：相册（含元数据、标签、两个 SQLite 库与原件）。
- `<dataDir>/models/index.json`：模型清单。
- `<dataDir>/.download/index.json`：下载任务清单。

要求 Node >= 26。
