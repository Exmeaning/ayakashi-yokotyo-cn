# 嵌入与部署

## 本地起服务

```bash
npm run build          # 生成 dist/
npm run serve          # http://127.0.0.1:5173/
```

或者一步：`npm run dev`。想看日文原版：`node scripts/serve.mjs --dir mirror`。

服务器挂了三个入口：

| 路径 | 用途 |
| --- | --- |
| `/` | 汉化站点 |
| `/ayakashi-yokotyo/` | 同一份内容挂在子路径下，用来验证站点不依赖固定根路径 |
| `/embed-demo` | iframe 嵌入示例页 |

`scripts/serve.mjs` 不是随便一个静态服务器，它专门处理了两件事：

- **Range 请求**：BGM/SE 是 mp3，`<audio>` 拖进度和 Safari 的音频加载都依赖 `206 Partial Content`。
- **不发 `X-Frame-Options`**：这个头没有「按来源放行」的表达能力，一旦发出去浏览器就优先当拒绝。
  改用 `Content-Security-Policy: frame-ancestors`，默认 `*`，可以收紧：

  ```bash
  node scripts/serve.mjs --frame-ancestors "https://your-site.example"
  ```

## 嵌到别的页面里

```html
<iframe
  src="https://your-host.example/ayakashi-yokotyo/"
  title="妖怪小巷的暑假"
  allow="autoplay; fullscreen"
  referrerpolicy="no-referrer"
  style="width: 100%; max-width: 430px; aspect-ratio: 9 / 16; border: 0"
></iframe>
```

几个实测要点：

- **`allow="autoplay"` 必须有**，否则 iframe 的权限策略会挡掉 BGM。
  游戏本身是点了开始按钮才出声，符合浏览器的用户手势要求。
- **尺寸按竖屏给**。这是移动端优先的布局，宽度 ≤ 500px 时会自动切到窄屏专用立绘
  （`assets/webp/content/character/sp/`），所以给一个 9:16 左右的容器最贴近真机。
- **跨源嵌入会影响存档**。游戏用 `localStorage` 存进度；作为第三方 iframe 时，
  Safari 默认屏蔽、Chrome 会做存储分区，表现是「每次进来都从头开始」。
  要保住存档就把它放在与父页面同源的路径下（反向代理到同一域名），而不是跨域 iframe。
- 站点内所有资源路径都是相对的，**挂在任意子目录都能跑**，不需要改配置。

## 部署到 Pages

产物 `dist/` 是纯静态目录，26 MB 左右，任何静态托管都能直接放。
`apply-i18n` 会一并生成两个托管用文件：

- `.nojekyll` —— GitHub Pages 默认过一遍 Jekyll，会吞掉下划线开头的文件。
- `_headers` —— Cloudflare Pages / Netlify 用它设响应头（`frame-ancestors` 与 assets 长缓存）。

### GitHub Pages

仓库 Settings → Pages → Source 选 **GitHub Actions**，然后推到 `main`。
`.github/workflows/deploy.yml` 会自动构建并发布，`--site-url` 用
`actions/configure-pages` 给出的 `base_url`，所以 `og:image` / `canonical` 会是正确的绝对地址。

注意 GitHub Pages **不支持自定义响应头**，`_headers` 不生效。
但它默认也不发 `X-Frame-Options`，所以 iframe 嵌入照样可用，只是没法限制来源。

### Cloudflare Pages

```
构建命令：npm ci && node scripts/apply-i18n.mjs --site-url https://<你的域名>/
输出目录：dist
```

`_headers` 在这里是生效的，想限制嵌入来源就改里面的 `frame-ancestors`。

### 任意静态托管 / 自建

```bash
npm ci
node scripts/apply-i18n.mjs --site-url https://your-host.example/path/
# 把 dist/ 整个丢上去即可
```

自建 nginx 的话记得开 `Accept-Ranges`（默认开）并**不要**加 `X-Frame-Options`。

## CI

`.github/workflows/ci.yml` 在 PR 和推送时会：

1. 重跑抽取，`git diff --exit-code i18n/source.ja.json` 确认抽取表与仓库一致
   （防止有人手改生成文件，或 mirror 变了没重新抽取）；
2. 构建 `dist/`；
3. 起本地服务器跑 `scripts/smoke-test.mjs`，真用 Chrome 点进剧情，
   检查资源无 404、无 JS 异常、人名是中文、**结局一览的头像没退化成 `icon_secret`**；
4. 把截图作为 artifact 上传。

第 3 步那个头像检查是有来由的：人名和头像字典键必须同步翻译，
漏一边的话页面不会报错，只是头像静默变成一片问号图 —— 只有真跑一遍才看得出来。
