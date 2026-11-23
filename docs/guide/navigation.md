# 导航与布局

读完你知道四套布局各自负责什么、相册和设置是怎么按模块分页的，以及加一个模块要改哪几处。

## 四套布局

| 布局 | 用在哪些路由 | 侧边栏内容 |
|---|---|---|
| `layouts/default.vue` | `/`、`/pixiv`、`/jobs` | 相册 / Pixiv / 图库 / 任务 / 设置 |
| `layouts/library.vue` | `/library/**`（全局图库、全局标签） | 全局图库标题与范围、图库 / 标签二级导航 |
| `layouts/album.vue` | `/albums/:id/**`（照片、标签、重复、相似、回收站、任务、设置、单图查看器） | 相册名与资产数、照片 / 标签 / 重复文件 / 相似图片 / 回收站 / 任务 / 设置 |
| `layouts/settings.vue` | `/settings/**` | 设置八个模块的入口 |

四者都渲染 `components/AppSidebar.vue`：品牌区 + `#context` 插槽（上下文标题）+ `#nav` 插槽
（各自的导航项）+ 底部动作区。底部只留**主题切换**；语言切换不在框架里，见下文。
`default` 与 `library` 共用 `composables/useGlobalNav.ts` 的五项主导航，小屏底部导航项也来自它。

侧边栏与分区的骨架类（`px-shell`、`px-sidebar`、`px-side__*`、`px-section__*`、`px-form-grid`）
统一定义在 `app/assets/css/theme.css`，layout 和页面只引用变量，不各自复制一份样式。

## 小屏行为

按 HarmonyOS 断点分三档：

- **手机（≤599px）**：顶部条 56px（含安全区），汉堡在 logo 左侧、上下文标题居中、主题按钮在右；
  点汉堡，侧栏从左侧滑入并占满整屏高度，带遮罩与滚动锁，Esc / 点遮罩 / ✕ / 切路由收起。
  打开时焦点移到关闭按钮，Tab 只在抽屉内循环；关闭后焦点回到汉堡按钮。
- **平板（600–839px）**：侧栏收成 96px 图标栏，导航文字视觉隐藏但保留可访问名称，
  相册名两行截断；悬停图标可看到名称提示。
- **桌面（≥840px）**：完整 240px 侧栏；主内容左右留白 40px。

每个 layout 的内容区都有「跳到主要内容」链接（键盘首次 Tab 可见），导航项带
`aria-current="page"`。

相册与设置布局在侧栏顶部有一条明显的退出入口：相册内是「退出相册」（回相册列表），
设置内是「返回相册列表」，不用再找 logo。

首页与任务页在小屏还有一条底部导航（`MobileTabBar`，项目由 `layouts/default.vue` 传入）；
`layouts/library.vue` 的图库/标签页也会渲染它。`px-main` 在小屏预留了 `padding-bottom`，
最后一行内容不会被底栏压住。

标签筛选不在侧栏列出，而是在照片页顶部的标签下拉里选择（带命中数量，可清空）；
启用 Pixiv 的相册另有独立的 Pixiv 标签筛选，搜索会匹配作品标题/画师/Pixiv 标签。
全部标签的管理入口在「标签」页。

## 全部

首页相册列表顶部固定一个「全部」入口。它不落盘、不登记，只展示桌面查看器打开过的**离散图片**，
数量来自 `<dataDir>/data/picture.db` 的 `viewer_media`，点击进入 `/library`。
相册资产不进入这份散图库，浏览相册请点击对应相册卡片。

## 散图库

`/library` 只读取查看器打开过的离散图片记录，按内容 SHA-256 去重：

- 不再有「同步所有相册」按钮；相册资产不会聚合到这里。
- 标签栏展示散图标签；标签筛选写 `?tag=<tagId>`，可直接分享该筛选。
- 相册资产与相册标签只在各自相册内浏览和管理。

`/library/tags` 是独立的散图标签页，与相册「标签」页共用 `TagManager` 组件与排版：
新建/编辑、导入/导出 JSON、自动/随机配色、批量删除、合并、删除全部。更改只作用于散图标签，
不会影响任何相册的 `tag.db`。

## 相册模块分页

```
/albums/:id                 照片（虚拟瀑布流；顶部标签下拉筛选，落到 ?tag=<tagId>；
                            可进「批量管理」多选后批量重命名 / 删除）
/albums/:id/tags            标签管理（新建、编辑弹框、导出 JSON、删除；点击标签跳到该标签的照片）
/albums/:id/duplicates      重复文件（SHA-256 相同的副本；点缩略图看大图）
/albums/:id/similar         相似分组（pHash 汉明距离；点图进入查看器并在组内切换）
/albums/:id/jobs            本相册任务（复用 JobsPanel，保持在相册侧栏内）
/albums/:id/settings        相册设置（名称/描述、相册级阈值与自动打标、缩略图存储整理/清空、导出全部图片）
/albums/:id/assets/:assetId 单图查看器（信息面板、重命名、多标签增删、相似图片、
                            相册内或相似组内上一张/下一张）
/jobs                       全局任务页（`?album=:id` 可过滤）
```

重复与相似原来是相册页里的两个抽屉，现在各占一个路由：侧边栏点进去就是独立页面，
返回时相册上下文还在。相册级数据（`index.json` + 标签库）由 `useAlbumContext()` 拉一次，
`useState` 在同一个相册的子页之间共享，切页不重复请求；`pendingId` 用于合并 layout 与页面
同时发起的加载。

查看器从相似页进入时带 `?from=similar&group=<组 id>`，左右方向键只在该组内切换；
从相册网格进入时沿用照片页当前的 `sort/order/kind/tagId/pixivTag/q/favorite`，
用 `/assets/:assetId/neighbors` 取相邻资产，不受相册规模影响。

照片页支持三种视图，选择会保存在本机 `localStorage`：

| 视图 | 说明 |
|---|---|
| 瀑布流 | 默认；按原图比例排列，保留文件名与尺寸 |
| 矩阵 | 只显示图片，2px 圆角、4px 间距；列数可用工具栏 ±、`Ctrl/⌘ + 滚轮` 或移动端双指捏合调整，单图最小约 24px |
| 列表 | 虚拟化横向行，显示缩略图、名称、尺寸、时间与收藏/删除操作 |

矩阵列数上限按屏幕物理宽度分档（1080p 约 20 列，相册矩阵最多 32 列），并受网格实际宽度与
24px 最小缩略图宽度约束；Pixiv 资料库硬上限为 20 列，瀑布流自动列数上限为 8。
未达到上限时也不能继续增加，窗口变窄时会自动收敛当前列数。
滚轮/捏合连续调整时只更新列数数字，停手 90ms 后才重排一次布局；切换视图会按当前视图
重新取一页（矩阵 500 条、列表 300 条、瀑布流 120 条），快速滚动时按视口高度提前续拉。

查看器快捷键：

| 按键 | 操作 |
|---|---|
| `A` / `←` | 上一张 |
| `D` / `→` | 下一张 |
| `W` / `↑` | 放大 |
| `S` / `↓` | 缩小 |
| `0` / `R` | 重置缩放 |
| `I` | 打开 / 关闭文件信息 |
| `F` | 收藏 / 取消收藏 |
| `Space` | 播放 / 暂停动图或实况照片 |
| `?` | 快捷键帮助 |
| `Esc` | 逐级关闭弹窗、信息面板、查看器 |

输入框、下拉框或弹窗获得焦点时不会触发这些快捷键。

标签筛选走 URL query 而不是组件内状态：`/albums/:id?tag=…`，因此可以分享、可以后退，
侧边栏的标签项和照片页的筛选 chip 都由同一个 query 派生。

## 设置模块分页

```
/settings                 → 重定向到 /settings/appearance
/settings/appearance      预设 + 可换肤 Token + 实时预览
/settings/language        默认语言；切换即时生效（cookie + localStorage + PATCH /settings）
/settings/storage         数据目录、相册/模型根目录、存储后端与分区
/settings/thumbnails      缩略图尺寸、质量、库上限，以及 ffmpeg 抽帧
/settings/similarity      相似度开关与汉明阈值
/settings/ai              打标模式、本地模型 id、自动打标、下载并发、外部接口
/settings/pixiv           Pixiv 登录、网络/代理、画质、后台补全速度与暂停
/settings/models          模型清单下载/暂停/继续/取消/校验/删除
```

每个模块页共用 `components/SettingsModule.vue`（页头 + 加载/错误态）与
`components/SettingsSection.vue`（分区卡片 + 保存按钮/已保存标记）。
表单状态在 `useSettings()` 里，按模块提交 PATCH，`saving`/`saved` 用模块 key 区分，
所以「存储与路径」里的两个分区各自转自己的圈。

## 加一个模块要改的地方

1. 新建 `app/pages/settings/<module>.vue`，`definePageMeta({ layout: 'settings' })`。
2. 在 `app/layouts/settings.vue` 的 `modules` 里加入口（路由、图标、`settings.moduleXxx` 文案）。
3. 文案同时写进 `i18n/locales/zh-CN.json` 与 `en-US.json`。
4. 相册侧同理：`app/pages/albums/[id]/<module>.vue` + `definePageMeta({ layout: 'album' })`
   + `app/layouts/album.vue` 的 `modules`。
