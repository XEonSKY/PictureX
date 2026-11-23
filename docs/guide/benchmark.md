# 入库基准

读完你知道如何复现基准、当前实测数据，以及 10 万文件时的预期规模与瓶颈。

## 方法

`scripts/benchmark-ingest.mjs` 通过真实 HTTP API 驱动：

1. 生成 N 张 16×16 PNG。每张 PNG 在 IEND 前插入唯一 `tEXt` 块，因此
   SHA-256 唯一、视觉完全相同（pHash 相同，便于验证相似分组）。
2. `POST /albums` 创建基准相册，`POST /albums/:id/imports` 启动导入。
3. 每 250ms 轮询 `/api/v1/health`（记录峰值 RSS/堆）与导入任务。
4. 导入结束后读取 `albumsRoot`，统计分区分布、`storage` 大小、
   `picture.db`（含 WAL）与 `<dataDir>/data/thumbnails.db`（含 WAL）大小。
5. 调用 `/groups/similar?threshold=8` 记录相似分组耗时。
6. 默认删除基准相册与媒体目录；`--keep` 保留。

```bash
pnpm dev   # 终端 A
node scripts/benchmark-ingest.mjs --count 2000   # 终端 B
# 或 pnpm bench:ingest --count 2000
```

参数：`--base-url http://localhost:3000`、`--count N`、`--dir <媒体目录>`、`--keep`。

## 实测（2026-10-23，Windows 10 x64，Node 24.22，NVMe）

> 下表是 Node 24 基线的历史数据，用于容量与瓶颈参考。迁移到 Node 26 后尚未重跑；
> 改动导入/哈希/缩略图热路径时，请用 `pnpm bench:ingest` 重新采样并在 PR 里附上新数据。

| 文件数 | 导入耗时 | 吞吐 | 峰值 RSS | 峰值堆 | 分区 | storage | picture.db | 缩略图库 | 相似分组 |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 1.4 s | 73.8 files/s | 2.0 GB | 150.5 MB | 1 | 12.8 KB | 4 KB | 92 KB | 7 ms（1 组） |
| 2000 | 21.8 s | 91.7 files/s | 2.1 GB | 301.7 MB | 1 | 258.7 KB | 5.1 MB | 5.6 MB | 10 ms（1 组） |

说明：

- 基准运行在 **Nuxt 开发服务器**上，RSS 包含 Vite/HMR、Nuxt 运行时与已加载的
  ONNX runtime；生产构建的常驻内存应单独测量。
- 2000 个文件仍落在分区 `0001`（`partitionSize = 8192`）。
- 相册库（`<album>/data/picture.db`）约 2.5 KB/资产（含 WAL），缩略图库在 `<dataDir>/data/thumbnails.db`。导入完成后后台串行预热最小配置尺寸，其它尺寸按
  浏览请求增长；表中旧数据来自预生成版本，仅作容量上限参考。
- 相似分组 2000 个同 phash 资产耗时 10 ms，受 `limit=50` 分组上限保护。

## 10 万文件外推

按 92 files/s：

- 导入耗时约 **18 分钟**（不含模型下载与 AI 打标）。
- 分区数 `ceil(100000 / 8192) = 13`。
- 同尺寸源图下统一 `<dataDir>/data/thumbnails.db` 的空库约 **4 KB**，随预热与浏览过的图片增量
  增长（按相册计预算）；实际相册请按预热比例估算，并调整 `thumbnails.dbMaxSizeMb`。
- 前端使用 keyset 分页 + 虚拟瀑布流，滚动只渲染可视区；缩略图按 512/256 降级。

## 瓶颈与调参

| 环节 | 观察 | 调整 |
|---|---|---|
| 缩略图 | 导入后后台预热最小尺寸；慢盘自动降并发，已有小图先返回 | 减小 `thumbnails.sizes` 或降低 `quality`；预热可暂停 |
| pHash | 32×32 灰度 + DCT，单张毫秒级 | 视频不计算 pHash |
| 哈希 | 流式 SHA-256，受磁盘读带宽限制 | 使用本地 SSD；避免网络盘 |
| 数据库 | WAL + 每 10 个文件一次进度写 | 不要逐文件写 `import_jobs` |
| 相似分组 | O(n·g)，g 为组数 | 提高阈值会合并更多组，g 下降 |
| 模型推理 | ONNX CPU，单张数百毫秒到数秒 | 分批打标；高峰期限流 |

## 复现报告

脚本会把完整 JSON 写到 `.dev/benchmark-report.json`，包含：

```json
{
    "count": 2000,
    "elapsedMs": 21800,
    "filesPerSecond": 91.7,
    "peakRssBytes": 2100000000,
    "peakHeapBytes": 301700000,
    "partitions": [{ "name": "0001", "files": 2000 }],
    "storageBytes": 264900,
    "pictureDbBytes": 5100000,
    "thumbnailsDbBytes": 5600000,
    "similarGroups": 1,
    "similarMs": 10
}
```
