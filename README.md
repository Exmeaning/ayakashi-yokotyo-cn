# あやかし横丁の夏休み — 离线镜像与简体中文汉化工程

プロジェクトセカイ 特设页面《あやかし横丁の夏休み》（妖怪小巷的暑假）的完整离线镜像，
外加一套可复现的汉化流水线：抽取原文 → 填译文 → 注入产物 → 本地起服务 / 部署 Pages。

原站：<https://pjsekai.sega.jp/ayakashi-yokotyo/index.html>

## 快速开始

```bash
npm ci
npm run build     # 把 i18n/zh-Hans.json 的译文注入 mirror/，产出 dist/
npm run serve     # http://127.0.0.1:5173/
```

想直接看日文原版：`node scripts/serve.mjs --dir mirror`

## 目录

```
mirror/          原站离线镜像（日文，234 个文件 / 26 MB，勿手改）
i18n/
  source.ja.json   机器生成的原文索引：分类、出现次数、AST 路径。勿手改
  zh-Hans.json     翻译工作文件：key = 日文原文，value = 译文
  asset-manifest.json  抓取到的资源清单与时间
scripts/
  fetch-site.mjs      抓取 / 更新镜像
  extract-strings.mjs 用 acorn 解析 bundle，抽出待汉化文本
  apply-i18n.mjs      注入译文 + 离线化 + 可嵌入改造，产出 dist/
  serve.mjs           本地服务器（支持 Range、允许 iframe 嵌入）
  smoke-test.mjs      用 Chrome 真跑一遍游戏做验收
docs/
  localization-inventory.md  需要汉化什么、有哪些坑 ← 先看这个
  embedding.md               嵌入与部署
dist/                构建产物（gitignored）
```

## 汉化怎么做

原站是 webpack 单页应用，**剧情和 UI 文案全硬编码在一个压缩 bundle 里**，没有语言包可换。
所以流程是：

```bash
npm run extract   # 从 mirror/ 抽原文，合并进 i18n/zh-Hans.json（保留已填译文）
# 编辑 i18n/zh-Hans.json，把 value 填上中文
npm run build     # 按 AST 位置精确写回，产出 dist/
npm run test      # Chrome 冒烟测试
```

进度：**1290 条唯一原文，已完成 101 条**（人名 / UI / HTML 全部完成，
剩下 1093 条剧情正文 + 42 条选项 + 54 条结局名与提示待翻译）。
未翻译的条目在构建时保留日文，可以随时构建、随时看效果。

分类明细、必须注意的坑（尤其是**人名与头像字典键必须同步翻译**）、
需要美工重绘的 8 张内嵌文字图片，都在 [`docs/localization-inventory.md`](docs/localization-inventory.md)。

## 部署

`dist/` 是纯静态目录，所有路径相对，挂在任意子目录都能跑。
推到 `main` 会由 `.github/workflows/deploy.yml` 自动发布到 GitHub Pages
（仓库 Settings → Pages → Source 选 GitHub Actions）。
Cloudflare Pages / 自建 nginx 的配置见 [`docs/embedding.md`](docs/embedding.md)。

## 关于版权

镜像内容的著作权属于株式会社 SEGA 及其关联公司，本仓库仅用于个人学习与非商业的本地化研究，
不含任何原始素材的再分发授权。请勿公开部署为可被搜索引擎索引的站点，也不要用于商业用途。
