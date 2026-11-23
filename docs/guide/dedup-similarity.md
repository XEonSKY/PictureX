# 去重与相似

读完你能解释 SHA-256 与 pHash 的分工、阈值含义，以及批量保留/删除的语义。

## SHA-256：精确去重

入库时对每个文件流式计算 SHA-256：

- 已存在相同哈希：**不复制**文件，把来源路径写入 `picture.db.duplicate_files`，
  导入计数 `duplicates + 1`。
- 不存在：分配序列、复制到 `storage/`、写入 `assets`。

因此同一份文件只存一份，但你能在「重复文件」里看到所有来源路径，并移除记录。
**应用不会删除相册目录以外的源文件**，需要释放空间时请在文件管理器中自行处理。

### 重复组接口

`GET /albums/:id/groups/duplicates` 按 `duplicate_files.sha256` 分组，返回：

```json
{
    "data": [
        {
            "key": "a6f5...",
            "count": 3,
            "asset": { "id": "...", "filename": "blue-copy.jpg" },
            "duplicates": [
                {
                    "id": "01a1...",
                    "sourcePath": "D:/Photos/blue.jpg",
                    "filename": "blue.jpg",
                    "size": 3119,
                    "foundAt": "..."
                }
            ]
        }
    ]
}
```

移除记录：

```http
DELETE /albums/:id/duplicates/:duplicateId
```

只移除 `duplicate_files` 记录，不删除磁盘文件；`deleteFile` 参数已不再生效。

## pHash：感知相似

1. 读取图片，按 32×32 灰度缩放（自动纠正 EXIF 旋转）。
2. 对 32×32 做二维 DCT（行列分离，O(n³)）。
3. 取左上 8×8 低频系数，以中位数（不含 DC）二值化，得到 64 bit / 16 位十六进制。

相同的构图即使重新压缩、轻微调色，汉明距离也很小；完全不同的图片距离接近 32。

性能：SHA-256 由 worker_threads 池并行读取+哈希（OpenSSL 自动启用 SHA-NI / ARM Crypto），
文件解码交给 libvips（SIMD + 多线程），pHash 按 CPU 核数并发处理；导入入库与后台索引都会
随核心数提速。

## 相似分组

导入只负责 SHA-256 去重与入库；pHash 与分组在导入结束后由后台相似度索引补齐，
结果持久化在 `similar_groups` / `similar_group_items`。

`GET /albums/:id/groups/similar?threshold=8&limit=20`

- 默认阈值取 `setting.json.similarity.hammingThreshold`（8）。
- 阈值越小越严格；建议 6–10。
- 分组算法：按 phash 排序后，与已有组的代表比较，距离 ≤ 阈值则加入；
  复杂度 O(n·g)，避免 10 万资产两两比较，且只在后台重建时执行。
- 返回每组资产及到代表图的 `distance` 与 `score = 1 - distance / 64`。
- `meta.rebuilding` 为 `true` 时表示正在按新阈值/新资产重建，前端会自动轮询刷新；
  阈值变化不再在请求线程里全库重算。

## UI 策略

- 重复组：左侧保留已入库资产，右侧列出磁盘副本；可勾选批量移除记录，
  也可以「清除全部重复记录」一键处理所有分组。清理后分组直接消失，
  磁盘上的源文件全部保持原样，应用不会读取或删除相册目录以外的文件。
- 相似组：可调阈值滑杆；「保留最佳」按分辨率面积优先、文件大小次优选择保留项，
  其余从相册删除（同时删除存储文件）。批量删除同样走二次确认。
  阈值改动会写回相册设置（`index.json.settings.similarityThreshold`），下次打开沿用；
  索引重建时顶部显示「已索引 / 总数」进度条，批量删除也显示完成进度。
  点缩略图直接打开大图，查看器会带着分组信息，左右键/箭头只在该组内切换。

「保留最佳」会把同组其它图片移入回收站，可在回收站恢复；永久删除需要再次在回收站执行删除。

## 错误码

| code | 场景 |
|---|---|
| `asset_not_found` | 资产不存在 |
| `asset_file_missing` | 原件已从存储丢失 |
