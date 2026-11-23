# 设计系统与运行时换肤

读完你能定位 Token 源文件、把新组件接入 Token 与 AntdvNext，并安全扩展换肤白名单。

## 意图层

设计意图来自 HarmonyOS 官方设计规范：

- 色彩层级：primary 90% / secondary 60% / tertiary 40% / fourth 20%，最小对比度 3:1。
- 布局：8vp 网格、4/8 间距；圆角 4/8/16/20/32；断点 600 / 840。
- 组件：40px 按钮圆角 8，28px 小按钮圆角 14；平板侧栏 96px，PC 抽屉 240px。
- 字体：`apps/web/public/fonts/` 下的 HarmonyOS Sans SC 与 HMSymbol。

具体取值以 `apps/web/shared/theme-tokens.json` 与生成的 `design-tokens.css` 为准。

当 prose 与 Sketch 冲突时，以 Sketch 尺寸为准。

## Token 层

唯一源文件：`apps/web/shared/theme-tokens.json`。

```
shared（两套主题共用）
  font-family-* / font-size-* / font-weight-* / line-height-* / letter-spacing-*
  space-1…16 / radius-* / motion-* / layout-* / control-height-* / z-*
light / dark
  color-*（品牌、语义、文本四级、背景、边框、滚动条、阴影）
```

`pnpm tokens:gen` 生成 `app/assets/css/design-tokens.css`：

```css
:root,
[data-theme="light"] {
    --px-color-brand: #0A59F7;
    /* @themable */
    --px-color-bg-page: #F1F3F5;
}
[data-theme="dark"] {
    --px-color-brand: #317AF7;
}
```

命名固定 `--px-<类别>-<语义>`。`design-tokens.css` 是生成物，禁止手改；
`scripts/generate-tokens.mjs --check` 可用于 CI 防漂移（`test/theme.test.ts` 也校验关键值）。

## 组件层

`app/app.vue` 用 `computed` 把 Token 映射到 AntdvNext：

| Token | ConfigProvider 字段 |
|---|---|
| `color-brand` | `colorPrimary` / `colorLink` / `colorInfo` |
| `color-text-primary/secondary/tertiary` | `colorText` / `colorTextSecondary` / `colorTextTertiary` |
| `color-bg-page/surface/elevated` | `colorBgLayout` / `colorBgContainer` / `colorBgElevated` |
| `color-border(-strong)` | `colorBorderSecondary` / `colorBorder` |
| `radius-xs/sm/md` | `borderRadiusSM` / `borderRadius` / `borderRadiusLG` |
| `control-height-*` | `controlHeightSM` / `controlHeight` / `controlHeightLG` |
| `font-family-base` / `font-size-body` | `fontFamily` / `fontSize` |

算法随预设切换：`antdTheme.defaultAlgorithm` / `antdTheme.darkAlgorithm`。
`ConfigProvider.locale` 由当前 `vue-i18n` locale 派生。

`theme.css` 只负责全局惯例（字体、滚动条、选中、页面过渡、AntdvNext 覆盖），
所有值引用 `var(--px-*)`；`.vue` 的 scoped 样式同样只引用 Token。

## 运行时换肤流程

1. 权威源：`setting.json.theme`。
2. 首屏缓存：`localStorage['picturex.theme']` + cookie `picturex.theme`。
3. SSR：`server/middleware/00-theme.ts` 优先读 cookie，其次 `setting.json`，写入 `event.context.pxTheme`。
4. `<head>` 内联脚本（`server/plugins/02-theme.ts`）在样式生效前设置 `data-theme` 与覆盖变量，
   并回写 cookie。
5. `app/plugins/theme.ts` 同步 `useState('px-theme')`，`useHead` 输出 `data-theme` 与覆盖 CSS。
6. `useTheme()` 的写操作：更新状态 → CSS 变量 → localStorage + cookie → `PATCH /settings/theme`。
7. 页面加载后主题即时生效；刷新保持；首屏无闪烁。

## 换肤白名单

只有 `theme-tokens.json.themable` 中的 Token 允许用户覆盖：

```
color-brand, color-brand-hover, color-success, color-warning, color-danger,
color-bg-page, color-bg-surface, color-text-primary, color-text-secondary,
radius-sm, radius-md, font-size-body
```

新增白名单项：

1. 加入 `themable` 数组并 `pnpm tokens:gen`。
2. 页面级不应依赖该 Token 的对比度；必要时提供深/浅两套合理默认值。
3. 在 `app/components/ThemeStudio.vue` 的 `tokenLabels` 补可读名称。
4. 覆盖值会经过 `normalizeThemeState` 过滤，非法值直接丢弃。

## 新组件检查清单

- [ ] 已用 `npx @antdv-next/cli info <Component>` 确认 Props/Events/Slots
- [ ] 尺寸/圆角/间距来自 Token，无硬编码色值或 px
- [ ] 40px 标准控件、28px 小控件、卡片圆角 16、28px 按钮圆角 14
- [ ] 文本层级使用 primary/secondary/tertiary/fourth
- [ ] 深色主题下对比度 ≥ 3:1
- [ ] hover/focus 不引起布局回流
- [ ] 框架区域禁止选中，内容区允许选中
- [ ] 动效 ≤ 350ms，`prefers-reduced-motion` 下关闭
- [ ] 文案走 i18n，图标按钮有 `aria-label`
- [ ] 在 599 / 839 / 1023 / 1279 断点检查布局

## skill 未覆盖项

- AntdvNext 内部组件的 token 名称与 HarmonyOS 组件并非一一对应，映射以视觉结果为准。
- HMSymbol 只覆盖部分图标；其余图标使用 `@antdv-next/icons`，尺寸/颜色仍走 Token。
- 官方文档中的手机 vp 与桌面 px 在本项目统一按 px 使用（Web 端）。
- 动效曲线采用 HarmonyOS 的 standard/emphasized/exit 三套，未逐组件定制。
