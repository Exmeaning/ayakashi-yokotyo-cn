#!/usr/bin/env node
/**
 * 抓取 pjsekai.sega.jp/ayakashi-yokotyo 的完整离线镜像到 mirror/。
 *
 * 站点是一个单页 webpack 应用：所有剧情数据、UI 文案、资源路径都硬编码在
 * assets/js/common/app.bundle.js 里，没有任何运行时 JSON 接口。
 * 所以资源清单 = index.html 里的引用 + bundle 里的字符串字面量 + 少量运行时拼接的路径。
 *
 * 用法：
 *   node scripts/fetch-site.mjs            # 增量（已存在则跳过）
 *   node scripts/fetch-site.mjs --force    # 全部重下
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(ROOT, 'mirror');
const BASE = 'https://pjsekai.sega.jp/ayakashi-yokotyo/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 8;

/** 入口文件：必须先有它们才能推导出其余资源 */
const ENTRIES = [
  'index.html',
  'assets/css/app.css',
  'assets/js/common/app.bundle.js',
  'assets/js/common/app.bundle.js.LICENSE.txt',
];

/**
 * bundle 在运行时拼接、无法从静态字符串直接抓到的路径。
 * - 头像图标：Ke="assets/webp/common/icon" + "/icon_" + slug + ".webp" / "_silhouette.webp"
 * - 静音图标："assets/images/common/" + ("icon_sound_on.svg" | "icon_sound_off.svg")
 */
const ICON_BASE = 'assets/webp/common/icon';
const EXTRA = ['assets/images/common/icon_sound_off.svg', `${ICON_BASE}/icon_secret.webp`];

/**
 * 原站本身就是 404 的引用，不算抓取失败：
 * - apple-touch-icon.png：index.html 里引了但线上没有这个文件
 * - icon_player_silhouette.webp：主角没有剪影态，只有已知角色才有
 */
const KNOWN_MISSING = new Set([
  'assets/images/common/apple-touch-icon.png',
  `${ICON_BASE}/icon_player_silhouette.webp`,
]);

/** 从 bundle 里读出「立绘名 -> 图标 slug」映射，用来展开头像清单 */
function extractIconSlugs(bundle) {
  const marker = '"自分":"player"';
  const at = bundle.indexOf(marker);
  if (at < 0) return [];
  const open = bundle.lastIndexOf('{', at);
  const close = bundle.indexOf('}', at);
  const map = JSON.parse(bundle.slice(open, close + 1));
  return [...new Set(Object.values(map))];
}

/** 从 bundle 里读出结局 OGP 图映射并生成路径清单 (assets/webp/ogp/ogp_ed_<hash>.webp) */
function extractEndingOgpPaths(bundle) {
  const marker = 'function nt(e){var t=tt[e]';
  const at = bundle.indexOf(marker);
  if (at < 0) return [];
  const open = bundle.lastIndexOf('{', at);
  const close = bundle.indexOf('}', open);
  const jsonStr = bundle.slice(open, close + 1);
  const validJson = jsonStr.replace(/([{,])(\d+):/g, '$1"$2":');
  const map = JSON.parse(validJson);
  return Object.values(map).map((hash) => `assets/webp/ogp/ogp_ed_${hash}.webp`);
}

/** 从任意文本里刮出 assets/... 静态资源路径 */
function scrapeAssetPaths(text) {
  const re = /assets\/[A-Za-z0-9_./-]+\.(?:webp|mp3|svg|png|jpe?g|ico|json|css|js|txt)/g;
  return text.match(re) ?? [];
}

/**
 * CSS 里的背景图写成 url(../webp/common/bg_body_pc.webp)，是相对 CSS 文件自身的，
 * 上面那个只认 "assets/" 开头的正则一个都抓不到。必须按 CSS 所在目录解析。
 */
function scrapeCssUrls(css, cssPath) {
  const dir = new URL(cssPath, 'file:///');
  const out = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const ref = m[2].trim();
    if (!ref || ref.startsWith('data:') || /^[a-z]+:/i.test(ref)) continue;
    const resolved = new URL(ref, dir).pathname.replace(/^\/+/, '');
    out.push(resolved);
  }
  return out;
}

/** 立绘有窄屏专用版本：bundle 在 max-width:500px 时把 /character/ 换成 /character/sp/ */
function spVariants(paths) {
  return paths
    .filter((p) => p.includes('assets/webp/content/character/') && !p.includes('/sp/'))
    .map((p) => p.replace('/character/', '/character/sp/'));
}

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function download(relPath, maxRetries = 3) {
  const dest = join(MIRROR, relPath);
  if (!FORCE && (await exists(dest))) return { relPath, status: 'skip' };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(new URL(relPath, BASE), {
        headers: { 'User-Agent': UA, Referer: BASE },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return { relPath, status: `HTTP ${res.status}` };

      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return { relPath, status: 'ok' };
    } catch (err) {
      if (attempt === maxRetries) {
        return { relPath, status: err.message || 'fetch failed' };
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function downloadAll(paths, label) {
  const queue = [...paths];
  const results = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        results.push(await download(next));
      }
    }),
  );
  const ok = results.filter((r) => r.status === 'ok').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const failed = results.filter((r) => r.status !== 'ok' && r.status !== 'skip');
  const expected = failed.filter((r) => KNOWN_MISSING.has(r.relPath));
  const bad = failed.filter((r) => !KNOWN_MISSING.has(r.relPath));
  console.log(
    `${label}: ${ok} 下载, ${skip} 已存在, ${bad.length} 失败` +
      (expected.length ? `, ${expected.length} 原站即缺失（已忽略）` : ''),
  );
  for (const b of bad) console.log(`  ! ${b.relPath} -> ${b.status}`);
  return bad;
}

const failures = [];
failures.push(...(await downloadAll(ENTRIES, '入口文件')));

const html = await readFile(join(MIRROR, 'index.html'), 'utf8');
const bundle = await readFile(join(MIRROR, 'assets/js/common/app.bundle.js'), 'utf8');
const css = await readFile(join(MIRROR, 'assets/css/app.css'), 'utf8');

const slugs = extractIconSlugs(bundle);
const iconPaths = slugs.flatMap((s) => [
  `${ICON_BASE}/icon_${s}.webp`,
  `${ICON_BASE}/icon_${s}_silhouette.webp`,
]);
const endingOgpPaths = extractEndingOgpPaths(bundle);

const scraped = [
  ...scrapeAssetPaths(html),
  ...scrapeAssetPaths(bundle),
  ...scrapeAssetPaths(css),
  ...scrapeCssUrls(css, 'assets/css/app.css'),
  ...EXTRA,
  ...iconPaths,
  ...endingOgpPaths,
];

const all = [...new Set([...scraped, ...spVariants(scraped)])]
  .filter((p) => !ENTRIES.includes(p))
  .sort();

console.log(
  `推导出 ${all.length} 个资源（角色头像 ${slugs.length}×2，结局 OGP 图 ${endingOgpPaths.length} 张，含窄屏 sp 立绘与 CSS 背景图）`,
);
failures.push(...(await downloadAll(all, '资源')));

await writeFile(
  join(ROOT, 'i18n', 'asset-manifest.json'),
  `${JSON.stringify({ base: BASE, fetchedAt: new Date().toISOString(), files: [...ENTRIES, ...all] }, null, 2)}\n`,
);

if (failures.length) {
  console.error(`\n${failures.length} 个资源抓取失败`);
  process.exit(1);
}
console.log('\n镜像完成 -> mirror/');
