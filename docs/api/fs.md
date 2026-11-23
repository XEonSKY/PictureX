# 目录浏览 API

读完你知道内建目录选择器背后调了什么，以及它能看到/看不到什么。

这两个端点只给**本机**的创建/关联相册流程用：只列目录、不读文件内容，
服务默认只监听 `127.0.0.1`。目录选择器（`components/DirectoryPicker.vue`）就是它们的唯一调用方。

## GET /fs/roots

返回可快速跳转的位置：`albumsRoot`、它的父目录，以及 Windows 各盘符（`C:\`、`D:\`…）
或 Unix 的 `/` 与用户主目录。默认情况下父目录就是 `dataDir`，因此 roots 可能包含数据目录本身；
端点只列目录、不读文件内容。

```json
{
    "data": [
        { "path": "C:\\", "name": "C:\\", "isAlbum": false },
        { "path": "D:\\", "name": "D:\\", "isAlbum": false },
        { "path": "D:\\Workspace\\PictureX\\.dev\\data\\albums", "name": "…", "isAlbum": false }
    ]
}
```

`isAlbum` 表示该目录自身是否含 `index.json`。

## GET /fs/list

查询参数：

| 参数 | 说明 |
|---|---|
| `path` | 必填，绝对路径 |
| `showHidden` | `true` 时包含 `.` 开头的目录，默认隐藏 |

```json
{
    "data": {
        "path": "D:\\Workspace\\PictureX\\.dev\\data\\albums",
        "parent": "D:\\Workspace\\PictureX\\.dev\\data",
        "isAlbum": false,
        "entries": [
            {
                "name": "01a168b8-42da-7200-9ade-31597db74ad1",
                "path": "D:\\…\\01a168b8-42da-7200-9ade-31597db74ad1",
                "isAlbum": true,
                "hidden": false
            }
        ]
    }
}
```

只返回子目录（符号链接指向目录时按目录处理），文件一律不列；目录不可读时返回
`403 fs_permission_denied`，路径不存在 `404 fs_not_found`，不是目录 `422 fs_not_directory`。

## 错误

| status | code | 场景 |
|---|---|---|
| 403 | `fs_permission_denied` | 无权限读取目录 |
| 404 | `fs_not_found` | 路径不存在 |
| 422 | `fs_not_directory` | 路径不是目录 |
