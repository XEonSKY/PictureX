# 下载与更新

PictureX 提供 Windows、macOS 与 Linux 安装包，并区分「发行版」与「预发行版」两条更新通道。

## 下载

| 平台 | 发行版 | 预发行版 |
| --- | --- | --- |
| Windows x64 | [下载安装包](https://github.com/XEonSKY/PictureX/releases/latest) | [查看预发行版](https://github.com/XEonSKY/PictureX/releases) |
| macOS arm64 | [下载 dmg](https://github.com/XEonSKY/PictureX/releases/latest) | [查看预发行版](https://github.com/XEonSKY/PictureX/releases) |
| Linux x64 | [下载 AppImage](https://github.com/XEonSKY/PictureX/releases/latest) | [查看预发行版](https://github.com/XEonSKY/PictureX/releases) |

所有历史版本与校验文件都在 [GitHub Releases](https://github.com/XEonSKY/PictureX/releases)。

- Windows：`PictureX-<version>-win-x64-setup.exe`
- macOS（Apple Silicon）：`PictureX-<version>-mac-arm64.dmg`
- Linux：`PictureX-<version>-linux-x86_64.AppImage`

## 更新通道

安装包内置更新源，无需手动配置：

| 通道 | 更新目录 |
| --- | --- |
| 发行版 | <https://picturex.xeonsky.com/update/latest/> |
| 预发行版 | <https://picturex.xeonsky.com/update/pre/> |

- 客户端按当前版本号自动选择：版本号带 `-rc` / `-beta` / `-alpha` 使用 `pre`，其余使用 `latest`。
- 可用环境变量 `PX_UPDATE_URL` 整体覆盖更新目录（调试或私有部署时使用）。
- 启动后每 6 小时检查一次，也可通过「帮助 → 检查更新」手动触发。

## 更新行为

1. 发现新版本后在后台**静默预下载**，不打断当前使用。
2. 下载完成后才弹窗询问是否「立即重启」安装；选择稍后不会安装。
3. 退出应用时不会静默安装，安装必须由用户确认。
4. Windows（NSIS）与 Linux（AppImage）使用 blockmap 差量下载；macOS dmg 为整包下载。
