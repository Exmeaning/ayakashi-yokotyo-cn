# 汉化清单

原站：<https://pjsekai.sega.jp/ayakashi-yokotyo/index.html>
镜像抓取时间见 `i18n/asset-manifest.json` 的 `fetchedAt`。

## 站点是怎么构成的

一个 webpack 打包的单页应用，没有任何运行时接口。**全部剧情数据、UI 文案、资源路径都硬编码在
`assets/js/common/app.bundle.js` 这一个 311 KB 的压缩文件里**，没有可替换的语言包，也没有外部 JSON。

这决定了汉化路线：不可能只改几个语言文件，只能对 bundle 做字符串级替换。为此
`scripts/extract-strings.mjs` 用 acorn 解析 AST 把文本抽成翻译表，
`scripts/apply-i18n.mjs` 再按 AST 节点位置精确写回，**不做正则全文替换**（会误伤代码）。

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `mirror/assets/js/common/app.bundle.js` | 311 KB | 唯一的脚本，剧情 + 逻辑 + UI 全在里面 |
| `mirror/index.html` | 30 KB | 静态骨架，含首页文案、注意事项、页脚、各弹窗模板 |
| `mirror/assets/css/app.css` | 56 KB | 无日文，**不需要汉化** |
| 图片 / 音频 | 26 MB | 少数图片有内嵌文字，见下文 |

## 需要汉化的文本（共 1290 条唯一原文 / 出现 2457 次）

工作文件：`i18n/zh-Hans.json`，key = 日文原文，value = 译文，留空表示未翻译（构建时保留日文）。
`i18n/source.ja.json` 是机器生成的索引，带每条原文的出现次数和 AST 路径（如 `routeD_3.choices[1].text`），
方便定位上下文，**不要手改**。

| 分组 | 条数 | 内容 | 现状 |
| --- | --- | --- | --- |
| `speaker` | 42 | 说话人名 + 角色头像字典键 | ✅ 已完成 |
| `ui` | 16 | 分享文案、快进按钮、内置浏览器警告等 | ✅ 已完成 |
| `html-text` | 30 | 首页说明、数据丢失注意事项、页脚版权、弹窗按钮 | ✅ 已完成 |
| `html-attr` | 13 | `alt` / `title` / `meta description` / OG 描述 | ✅ 已完成 |
| `dialogue` | 1093 | 剧情正文，**主要工作量** | ⬜ 待翻译 |
| `choice` | 42 | 分歧选项 | ⬜ 待翻译 |
| `ending-title` | 27 | 结局名 | ⬜ 待翻译 |
| `ending-hint` | 27 | 结局提示（「ヒント：…」） | ⬜ 待翻译 |

### 翻译时必须注意的四件事

1. **`speaker` 组牵连头像，改动必须整组一致。**
   bundle 里有个字典 `{"イチカ":"ichika", ...}`，运行时用说话人名去查
   `assets/webp/common/icon/icon_<slug>.webp`。结局一览的角色头像就靠它。
   代码是 `icon = 字典[人名] ? icon_<slug>.webp : icon_secret.webp`，
   所以**只翻了 `name:` 而漏翻字典键，结局一览会整屏变成问号图**。

   本工程用「按原文全局替换」而不是「按出现位置逐条替换」正是为了自动保证这一点：
   同一个 `"イチカ"` 无论出现在字典键、`name:` 还是 `name === "自分"` 这种判断里，都会被替换成同一个译文。
   代价是**同一句原文全站只能有一个译法**。`scripts/extract-strings.mjs` 运行时会列出跨分类复用的条目。

2. **保留占位符。** `ui` 组的 `"{characterName}と一緒に"` 里的 `{characterName}` 是运行时替换的变量。
   `apply-i18n` 会检查占位符丢失并报警告。

3. **保留 HTML 标签。** `ui` 组有一条是整段 HTML（X 内置浏览器警告），译文要保留 `<div>` / `<p>` / `<br>` 结构。
   `apply-i18n` 会比对标签数量。

4. **换行 `\n` 是排版的一部分。** 对话框宽度固定，原文用 `\n` 手工断行。
   中文比日文短，通常需要重新决定断行位置，而不是照搬原文的换行。

## 需要重绘的图片（内嵌日文）

这些文字烧在图片里，脚本无法处理，需要美工重做。路径相对 `mirror/assets/`：

| 文件 | 内嵌文字 | 用在哪 |
| --- | --- | --- |
| `webp/common/logo_ayakashi-yokotyo.webp` | あやかし横丁の夏休み | 首页主 logo（147 KB，最显眼） |
| `webp/index/btn_start.webp` | ゲームを始める！ | 首页开始按钮 |
| `webp/index/bnr_share.webp` | このサイトをシェア！ | 首页分享横幅 |
| `webp/common/ttl_endinglist.webp` | エンディングリスト / Ending list | 结局一览标题 |
| `webp/clear/ttl_clear.webp` | Congratulations あやかし事件解決！ | 通关画面标题 |
| `webp/clear/txt_clear.webp` | （淡色装饰文字） | 通关画面背景文字 |
| `webp/clear/btn_post.webp` | X 結果をポスト！ | 通关画面分享按钮 |
| `webp/ogp/ogp.webp` | logo + あやかし事件を解決して夏祭りを成功させよう！ | 社交分享缩略图 |

**不要动**的图片：`logo_pjsekai` / `logo_sega` / `logo_colorfulpalette` / `logo_crypton` /
`logo_piapro` / `icon_app` 是品牌标识；`img_app-store.webp` 与 `img_google-play.webp`
是应用商店官方徽章，若要本地化应换成官方提供的中文版徽章，而不是自己重绘。

其余图片（角色立绘、场景背景、头像、装饰、SVG 图标）不含文字，无需处理。

## 字体

原站用 Google Fonts 的 **Zen Kaku Gothic Antique**，是日文字体，缺「这 / 说 / 们 / 么」等简体专用字。
直接沿用会大面积缺字回退，所以 `apply-i18n` 移除了 Google Fonts 引用，
并生成 `assets/css/zh-cn.css` 换成简体字体栈。想贴近原版字形就自行 vendored 一份中文黑体到
`assets/fonts/` 并在该文件里 `@font-face` 引入。

## 对原站的其他改动

`apply-i18n` 除了替换文本，还做了这些（都写在 `scripts/apply-i18n.mjs` 里，各有注释）：

- 移除 Google Tag Manager（`GTM-WFZ2TXP`）：离线环境下是无效外部请求，也不该把访客数据发去原站。
  想保留就加 `--keep-tracking`。
- 移除 Google Fonts 的 `preconnect` 与样式表引用（理由见上）。
- 移除 `apple-touch-icon` 引用：原站这个文件本身就是 404。
- `html lang` 改 `zh-Hans`，`og:locale` 改 `zh_CN`。
- 指向 `https://pjsekai.sega.jp/ayakashi-yokotyo/` 的绝对地址改成相对路径，
  这样站点挂在任意子路径（含 Pages 的 `/<repo>/`）都能跑。
  `--site-url` 可以把 `og:image` / `canonical` 再写回绝对地址。

## 原站本身就缺的资源

抓取脚本把这两条列为「已知缺失」，不算失败：

- `assets/images/common/apple-touch-icon.png` —— `index.html` 引用了但线上 404
- `assets/webp/common/icon/icon_player_silhouette.webp` —— 主角没有剪影态
- （另外 CSS 里引用的 `assets/webp/content/bg_content_normal.webp` 在原站也是 404，
  但它不在抓取清单的解析结果里，故未列入）

## 存档数据

游戏用 `localStorage` 存进度，键名前缀 `ayakashiYokotyo.`
（旧版 `ayakashiYokotyo.soundEnabled` / `ayakashiYokotyo.unlockedEndings` 会被迁移进新键）。
换浏览器、清缓存、无痕模式都会丢档 —— 这也是首页那几条注意事项在说的事。
跨源 iframe 嵌入时浏览器可能分区或屏蔽存储，见 `docs/embedding.md`。
