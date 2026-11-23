---
layout: home

hero:
  name: PictureX
  text: 本地优先的 AI 相册
  tagline: 相册自包含 · SHA-256 + pHash 去重 · CLIP/ViT-GPT2 打标 · 运行时换肤 · 中英双语
  image:
    src: /logo.svg
    alt: PictureX
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 相册格式
      link: /guide/album-format
    - theme: alt
      text: API
      link: /api/albums

features:
  - title: 文件留在本地
    details: 每个相册是自包含目录（元数据、索引与原件），可整体搬移；缩略图缓存放在数据根目录以加速加载，相册资产不进入全局图库。
  - title: 双重去重
    details: SHA-256 精确去重记录来源路径，pHash 感知相似识别并按汉明距离分组。
  - title: 零样本 + 生成式
    details: 内置 CLIP 零样本与 ViT-GPT2 描述打标，可切换外部 OpenAI 兼容接口并自动降级。
  - title: 10 万级浏览
    details: 相册级 SQLite + keyset 分页 + 虚拟瀑布流，大相册滚动不白屏。
  - title: 运行时换肤
    details: 设计 Token 单一事实源，light/dark 与用户覆盖即时生效、刷新保持、首屏无闪烁。
  - title: 全站 i18n
    details: zh-CN 默认、en-US 可选；文案、日期数字格式与 AntdvNext locale 同步切换。
---
