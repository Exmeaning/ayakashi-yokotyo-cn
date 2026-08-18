#!/usr/bin/env node
/**
 * 把 i18n/zh-Hans.json 里的译文注入 mirror/，输出可直接托管的 dist/。
 *
 * 做三件事：
 *   1. 按 AST 位置精确替换 app.bundle.js 里的字符串字面量（不做正则全文替换，避免误伤代码）
 *   2. 替换 index.html 的文本节点与 alt/title/content 等属性
 *   3. 改造成「离线可用 + 可被 iframe 嵌入」：去掉 GTM 与 Google Fonts 等外部请求，
 *      站外绝对链接改回相对路径，补一份中文字体覆盖样式
 *
 * 用法：
 *   node scripts/apply-i18n.mjs             # 未翻译的条目保留日文
 *   node scripts/apply-i18n.mjs --strict    # 存在未翻译条目则失败（适合 CI）
 *   node scripts/apply-i18n.mjs --keep-tracking   # 保留原站 GTM（默认移除）
 *   node scripts/apply-i18n.mjs --site-url https://user.github.io/repo/   # 写死绝对 OG/canonical 地址
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR = join(ROOT, 'mirror');
const DIST = join(ROOT, 'dist');
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
};
const STRICT = process.argv.includes('--strict');
const KEEP_TRACKING = process.argv.includes('--keep-tracking');
const UPSTREAM = 'https://pjsekai.sega.jp/ayakashi-yokotyo/';

// ---------------------------------------------------------------- 翻译表

const table = JSON.parse(await readFile(join(ROOT, 'i18n/zh-Hans.json'), 'utf8'));

/** @type {Map<string,string>} 日文原文 -> 译文（只含已填写的） */
const zh = new Map();
let totalEntries = 0;
const untranslated = [];
for (const [kind, group] of Object.entries(table)) {
  if (kind.startsWith('_') || typeof group !== 'object') continue;
  for (const [ja, value] of Object.entries(group)) {
    totalEntries++;
    if (typeof value === 'string' && value.trim()) zh.set(ja, value);
    else untranslated.push({ kind, ja });
  }
}

/** 译文里必须保留的东西：{占位符} 与 HTML 标签 */
const warnings = [];
for (const [ja, value] of zh) {
  for (const ph of ja.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []) {
    if (!value.includes(ph)) warnings.push(`占位符 ${ph} 在译文中丢失: ${ja.slice(0, 30)}`);
  }
  const jaTags = (ja.match(/<[a-z][^>]*>/gi) ?? []).length;
  const zhTags = (value.match(/<[a-z][^>]*>/gi) ?? []).length;
  if (jaTags !== zhTags) {
    warnings.push(`HTML 标签数量不一致 (${jaTags} -> ${zhTags}): ${ja.slice(0, 30)}`);
  }
}

// ---------------------------------------------------------------- dist 骨架

await rm(DIST, { recursive: true, force: true });
await cp(MIRROR, DIST, { recursive: true });

// ---------------------------------------------------------------- bundle

/** JSON.stringify 已处理引号/反斜杠/控制字符；U+2028、U+2029 在 JSON 里合法，但在 JS 源码里是换行符，必须再转义一层 */
// U+2028 / U+2029 在 JSON 字符串里合法，但在 JS 源码里算换行符，必须再转义一层
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/** 把译文编码成一个安全的 JS 双引号字符串字面量 */
const jsString = (s) =>
  JSON.stringify(s).split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');

const bundlePath = 'assets/js/common/app.bundle.js';
const bundleSrc = await readFile(join(MIRROR, bundlePath), 'utf8');
const ast = acorn.parse(bundleSrc, { ecmaVersion: 'latest', sourceType: 'script' });

/** @type {{start:number,end:number,to:string}[]} */
const edits = [];
const queueEdit = (node) => {
  if (typeof node?.value !== 'string') return;
  const replacement = zh.get(node.value);
  if (replacement === undefined) return;
  edits.push({ start: node.start, end: node.end, to: jsString(replacement) });
};

walk.simple(ast, {
  Literal: queueEdit,
  // acorn-walk 不会递归非 computed 的属性键，而角色名字典 {"イチカ":"ichika"} 正是这种形式。
  // 它必须和 name:"イチカ" 一起翻译，否则运行时 Ye[name] 查不到 slug，头像会全变成 icon_secret。
  Property(node) {
    if (!node.computed && node.key.type === 'Literal') queueEdit(node.key);
  },
});
edits.sort((a, b) => a.start - b.start);

let out = '';
let cursor = 0;
for (const e of edits) {
  out += bundleSrc.slice(cursor, e.start) + e.to;
  cursor = e.end;
}
out += bundleSrc.slice(cursor);
await writeFile(join(DIST, bundlePath), out);

// ---------------------------------------------------------------- index.html

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

let html = await readFile(join(MIRROR, 'index.html'), 'utf8');

/** 替换文本节点。先把 script/style 内容遮成等长空白，保证下标能对回原串 */
function replaceTextNodes(src) {
  const masked = src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => ' '.repeat(m.length));
  const re = />([^<]+)</g;
  let result = '';
  let last = 0;
  let hits = 0;
  for (let m; (m = re.exec(masked)); ) {
    const raw = m[1];
    const text = raw.trim();
    const replacement = zh.get(text);
    if (!replacement) continue;
    const at = m.index + 1; // 跳过 '>'
    const offset = raw.indexOf(text);
    result += src.slice(last, at + offset) + escapeText(replacement);
    last = at + offset + text.length;
    hits++;
  }
  return { html: result + src.slice(last), hits };
}

const textPass = replaceTextNodes(html);
html = textPass.html;

let attrHits = 0;
html = html.replace(
  /\b(alt|title|placeholder|content|aria-label)(\s*=\s*")([^"]*)(")/gi,
  (whole, name, eq, value, close) => {
    const replacement = zh.get(value);
    if (!replacement) return whole;
    attrHits++;
    return `${name}${eq}${escapeAttr(replacement)}${close}`;
  },
);

// 语言标记
html = html.replace(/<html lang="ja">/i, '<html lang="zh-Hans">');
html = html.replace(
  /<meta property="og:locale" content="ja_JP">/i,
  '<meta property="og:locale" content="zh_CN">',
);

const removals = [];

// 原站的 Google Tag Manager：离线环境下是无效外部请求，也不该把访客数据发去原站
if (!KEEP_TRACKING) {
  const before = html.length;
  html = html.replace(
    /[ \t]*<!-- Google Tag Manager -->[\s\S]*?<!-- End Google Tag Manager -->\n?/i,
    '',
  );
  html = html.replace(/[ \t]*<noscript><iframe[^>]*googletagmanager[\s\S]*?<\/noscript>\n?/gi, '');
  if (html.length !== before) removals.push('Google Tag Manager');
}

// Google Fonts：外部请求；而且 Zen Kaku Gothic Antique 是日文字体，
// 缺少「这/说/们/么」等简体专用字，中文文本反而会大面积回退。改用本地中文字体栈。
{
  const before = html.length;
  html = html.replace(
    /[ \t]*<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>\n?/gi,
    '',
  );
  html = html.replace(/[ \t]*<link[^>]*fonts\.googleapis\.com[^>]*>\n?/gi, '');
  if (html.length !== before) removals.push('Google Fonts');
}

// 原站就 404 的 apple-touch-icon，去掉免得控制台报错
html = html.replace(/[ \t]*<link rel="apple-touch-icon"[^>]*>\n?/i, '');

// 指向原站的绝对地址改成相对，站点挂到任何子路径下都能跑（Pages 的 /<repo>/ 也一样）
html = html.split(UPSTREAM).join('./');

// og:image / canonical 这类需要绝对地址才有意义，部署时用 --site-url 传入自己的域名
const SITE_URL = arg('site-url', '');
if (SITE_URL) {
  const base = SITE_URL.replace(/\/*$/, '/');
  html = html.replace(
    /(<(?:meta|link)[^>]*(?:property="og:(?:url|image)"|name="twitter:image"|rel="canonical")[^>]*(?:content|href)=")\.\/([^"]*)(")/gi,
    (_m, head, path, tail) => `${head}${base}${path}${tail}`,
  );
}

// 追加中文字体覆盖
const ZH_CSS = 'assets/css/zh-cn.css';
html = html.replace(
  /(<link rel="stylesheet" href="\.\/assets\/css\/app\.css[^>]*>)/i,
  `$1\n    <link rel="stylesheet" href="./${ZH_CSS}">`,
);

await writeFile(join(DIST, 'index.html'), html);

await mkdir(join(DIST, 'assets/css'), { recursive: true });
await writeFile(
  join(DIST, ZH_CSS),
  `/* 简体中文字体覆盖。原站用 Zen Kaku Gothic Antique（日文字体），
   简体专用字会缺字回退，这里换成覆盖简体的系统字体栈。
   若要贴近原版字形，可自行 vendored 一份中文黑体到 assets/fonts/ 并在此 @font-face 引入。 */
:root {
  --font-zh: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Source Han Sans SC",
    "Microsoft YaHei", "Zen Kaku Gothic Antique", "Helvetica Neue", Arial, sans-serif;
}

body,
button,
input,
textarea,
select {
  font-family: var(--font-zh);
}

/* 中文没有日文那样的假名节奏，行距略收紧一点更接近原版观感 */
.c-content__text,
.p-home__description-text {
  letter-spacing: 0.02em;
}
`,
);

// ---------------------------------------------------------------- 静态托管所需的附加文件

// GitHub Pages 默认过一遍 Jekyll，会忽略下划线开头的文件。
await writeFile(join(DIST, '.nojekyll'), '');

// Cloudflare Pages / Netlify 读这个文件设响应头。GitHub Pages 不支持自定义头，
// 但它默认也不发 X-Frame-Options，所以 iframe 嵌入照样可用，只是没法收紧来源。
await writeFile(
  join(DIST, '_headers'),
  `/*
  Content-Security-Policy: frame-ancestors *
  X-Content-Type-Options: nosniff

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
);

// ---------------------------------------------------------------- 报告

const translatedCount = zh.size;
const pct = totalEntries ? ((translatedCount / totalEntries) * 100).toFixed(1) : '0.0';
console.log('汉化产物已生成 -> dist/');
console.log(`  翻译进度      ${translatedCount}/${totalEntries} (${pct}%)`);
console.log(`  bundle 替换   ${edits.length} 处字符串字面量`);
console.log(`  html 替换     ${textPass.hits} 处文本节点 / ${attrHits} 处属性`);
if (removals.length) console.log(`  已移除外部依赖 ${removals.join('、')}`);

if (warnings.length) {
  console.log(`\n  ! ${warnings.length} 条译文校验警告：`);
  for (const w of warnings.slice(0, 20)) console.log(`    ${w}`);
}

if (untranslated.length) {
  const byKind = {};
  for (const u of untranslated) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  console.log(
    `\n  未翻译 ${untranslated.length} 条（构建时保留日文原文）：` +
      Object.entries(byKind)
        .map(([k, n]) => ` ${k}=${n}`)
        .join(''),
  );
  if (STRICT) {
    console.error('\n--strict：存在未翻译条目，构建失败');
    process.exit(1);
  }
}
if (warnings.length && STRICT) {
  console.error('\n--strict：存在译文校验警告，构建失败');
  process.exit(1);
}
