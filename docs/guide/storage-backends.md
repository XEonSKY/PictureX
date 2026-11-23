# 存储后端

读完你知道 `StorageAdapter` 的契约、local 的分区实现，以及如何新增 quark/oss/ftp。

## 接口

`apps/web/server/storage/types.ts`：

```ts
interface StorageAdapter {
    readonly kind: 'local' | 'quark' | 'oss' | 'ftp'
    put(input: { sequence: number, ext: string, sourcePath?: string, data?: Buffer }): Promise<StoredObject>
    open(key: string): Promise<Readable>
    stat(key: string): Promise<{ size: number, mtimeMs: number }>
    exists(key: string): Promise<boolean>
    delete(key: string): Promise<void>
    localPath(key: string): string | null
}
```

`localPath` 是 Range 下载的快速通道：local 返回绝对路径，远端返回 `null`，
路由会退化为 `open()` 的完整流。

## local 实现

`apps/web/server/storage/local.ts`：

- 目标键：`storage/<4 位分区>/<uuidv7>.<ext>`。
- 写入：`put` 复制 `sourcePath` 或直接写 `data`，自动建父目录。
- 安全：所有 key 解析后必须位于相册目录内，越界抛错（防目录穿越）。
- 删除：`force` 删除，不存在不报错。
- 适配器按「后端 + 相册目录」缓存在 `registry.ts`。

## 选择后端

`setting.json.storage.default`：

```json
{ "default": "local", "partitionSize": 8192, "partitionMode": "sequence" }
```

`storageForAlbum(albumDir, settings)` 根据后端返回适配器；`quark` / `oss` / `ftp`
目前是 `server/storage/stubs.ts` 中的占位实现，任何调用都会抛 501 `storage_backend_not_implemented`。
「设置 → 存储与路径」中这些选项已禁用，`PATCH /settings` 返回 422；手动把
`setting.json` 改成非 `local` 会在启动时直接报错。

## 新增远端后端

1. 在 `server/storage/` 新建 `quark.ts`，实现 `StorageAdapter`。
2. `put` 必须返回与 `storageKeyFor()` 相同格式的 key（分区 + uuidv7 + ext），
   以保证元数据与本地模式一致。
3. `open` 返回 Node `Readable`；`stat` 返回字节数与 mtime。
4. 在 `registry.ts` 的 `createStorageAdapter` 中注册。
5. 远端不支持 `localPath`，返回 `null`；文件路由会走完整流，不做 Range 分片。
6. 为 `put/open/delete` 补 Vitest（含不存在、权限失败、路径越界）。
7. 更新本文与 `docs/api/assets.md` 的 Range 说明。

## 一致性约束

- `picture.db.assets.storage_key` 是唯一键；同一文件重复入库不会覆盖已有 key。
- 永久删除资产时先删数据库行、再删存储对象与缩略图；文件删不掉只记 warning 并留下可清扫的
  孤儿文件，绝不留下指向已删文件的僵尸记录。
- 远端后端上线前，缩略图与 pHash 生成仍然在本地完成；只有原件存储迁移到远端。
