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

/** 采用日中双语（日文小字在上，中文在下）的文本分类 */
const BILINGUAL_KINDS = new Set(['dialogue', 'choice', 'ending-title', 'ending-hint']);

for (const [kind, group] of Object.entries(table)) {
  if (kind.startsWith('_') || typeof group !== 'object') continue;
  for (const [ja, value] of Object.entries(group)) {
    totalEntries++;
    if (typeof value === 'string' && value.trim()) {
      if (BILINGUAL_KINDS.has(kind)) {
        // 合成为日中双语格式：{ja}日文原文{/ja}中文译文
        zh.set(ja, `{ja}${ja}{/ja}${value}`);
      } else {
        zh.set(ja, value);
      }
    } else {
      untranslated.push({ kind, ja });
    }
  }
}

/** 译文里必须保留的东西：{占位符} 与 HTML 标签 */
const warnings = [];
for (const [ja, fullValue] of zh) {
  const value = fullValue.startsWith('{ja}')
    ? fullValue.slice(fullValue.indexOf('{/ja}') + 5)
    : fullValue;
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
let bundleSrc = await readFile(join(MIRROR, bundlePath), 'utf8');

/**
 * 注入双语渲染补丁函数：
 * 1. Sn: 分词器支持 {ja}...{/ja} 标记
 * 2. An: DOM 渲染器输出 .c-bilingual-ja 与 .c-bilingual-zh 双层结构
 * 3. En: 打字机动画在中文逐字播放的同时，日文预先/同步在上方显示
 * 4. ha: Backlog 列表项渲染日中双语
 * 5. choice: 分歧选项列表项渲染日中双语
 * 6. ending: 结局列表项渲染日中双语
 */
function patchCode(src, target, replacement, label) {
  if (!src.includes(target)) {
    throw new Error(`Bundle patch failed: "${label}" target not found`);
  }
  return src.replace(target, replacement);
}

// 1. Sn 分词器补丁
bundleSrc = patchCode(
  bundleSrc,
  'function Sn(e){for(var t=[],n=0,a=!1,r=String(e||"");n<r.length;)if(M()(r).call(r,"{p}",n))t.push({type:"pause"}),n+=3;else if(M()(r).call(r,"{em}",n))a=!0,n+=4;else if(M()(r).call(r,"{/em}",n))a=!1,n+=5;else{var c=U()(G()(r).call(r,n));n+=c.length,t.push({type:"char",value:c,em:a})}return t}',
  'function Sn(e){for(var t=[],n=0,a=!1,j=!1,r=String(e||"");n<r.length;)if(M()(r).call(r,"{ja}",n))j=!0,n+=4;else if(M()(r).call(r,"{/ja}",n))j=!1,n+=5;else if(M()(r).call(r,"{p}",n))t.push({type:"pause",ja:j}),n+=3;else if(M()(r).call(r,"{em}",n))a=!0,n+=4;else if(M()(r).call(r,"{/em}",n))a=!1,n+=5;else{var c=U()(G()(r).call(r,n));n+=c.length,t.push({type:"char",value:c,em:a,ja:j})}return t}',
  'Sn (tokenizer)',
);

// 2. An 渲染器补丁
bundleSrc = patchCode(
  bundleSrc,
  'function An(e,t){e.replaceChildren();var n="",a=null,r=function(){if(n){if(a){var t=document.createElement("span");t.className="c-in-em",t.textContent=n,e.append(t)}else e.append(document.createTextNode(n));n=""}};T()(t).call(t,(function(e){"char"===e.type&&(a!==e.em&&(r(),a=e.em),n+=e.value)})),r()}',
  'function An(e,t){e.replaceChildren();var jW=document.createElement("div");jW.className="c-bilingual-ja";var zW=document.createElement("div");zW.className="c-bilingual-zh";var hasJa=!1,jT="",zT="",jE=null,zE=null;function flJ(){if(jT){if(jE){var el=document.createElement("span");el.className="c-in-em",el.textContent=jT,jW.append(el)}else jW.append(document.createTextNode(jT));jT=""}}function flZ(){if(zT){if(zE){var el=document.createElement("span");el.className="c-in-em",el.textContent=zT,zW.append(el)}else zW.append(document.createTextNode(zT));zT=""}}T()(t).call(t,(function(it){if("char"===it.type){if(it.ja){hasJa=!0,jE!==it.em&&(flJ(),jE=it.em),jT+=it.value}else{zE!==it.em&&(flZ(),zE=it.em),zT+=it.value}}})),flJ(),flZ(),hasJa?e.append(jW,zW):e.append(zW)}',
  'An (renderer)',
);

// 3. En 打字机补丁
bundleSrc = patchCode(
  bundleSrc,
  'function En(e){var t=rn(".c-content__content-dialogue-text"),n=rn(".c-content__content-dialogue-icon");if(t){kn(),Ht=e,Jt=!0,t.replaceChildren(),null==n||n.classList.remove("is-visible");var a=Sn(e),r=[],c=0,s=function(){if(c>=a.length)return kn(),Jt=!1,void(null==n||n.classList.add("is-visible"));var e=a[c];c+=1,"pause"!==e.type?(r.push(e),An(t,r),Gt=I()(s,25)):Gt=I()(s,450)};Gt=I()(s,25)}}',
  'function En(e){var t=rn(".c-content__content-dialogue-text"),n=rn(".c-content__content-dialogue-icon");if(t){kn(),Ht=e,Jt=!0,t.replaceChildren(),null==n||n.classList.remove("is-visible");var a=Sn(e),jToks=a.filter(function(x){return x.ja}),zToks=a.filter(function(x){return!x.ja}),r=[].concat(jToks),c=0;An(t,r);var s=function(){if(c>=zToks.length)return kn(),Jt=!1,void(null==n||n.classList.add("is-visible"));var e=zToks[c];c+=1,"pause"!==e.type?(r.push(e),An(t,r),Gt=I()(s,25)):Gt=I()(s,450)};Gt=I()(s,25)}}',
  'En (typewriter)',
);

// 4. Backlog 双语渲染补丁
bundleSrc = patchCode(
  bundleSrc,
  'var o=document.createElement("p");o.className="c-in-dialogue",o.textContent=t.text,a.append(r,o),e.append(a)',
  'var o=document.createElement("p");o.className="c-in-dialogue";var bm=/^\\{ja\\}([\\s\\S]*?)\\{\\/ja\\}([\\s\\S]*)$/.exec(t.text);if(bm){var jB=document.createElement("div");jB.className="c-bilingual-ja",jB.textContent=bm[1];var zB=document.createElement("div");zB.className="c-bilingual-zh",zB.textContent=bm[2];o.append(jB,zB)}else{o.textContent=t.text}a.append(r,o),e.append(a)',
  'ha (backlog)',
);

// 5. Choice 选项双语渲染补丁
bundleSrc = patchCode(
  bundleSrc,
  'c.className="c-choice__content-list-item-text",c.textContent=e.text,n.append(r,c),t.append(n),a.append(t)',
  'c.className="c-choice__content-list-item-text";var chm=/^\\{ja\\}([\\s\\S]*?)\\{\\/ja\\}([\\s\\S]*)$/.exec(e.text);if(chm){var jC=document.createElement("span");jC.className="c-choice-ja",jC.textContent=chm[1];var zC=document.createElement("span");zC.className="c-choice-zh",zC.textContent=chm[2];c.append(jC,zC)}else{c.textContent=e.text}n.append(r,c),t.append(n),a.append(t)',
  'choice (options)',
);

// 6. Ending 结局列表双语渲染补丁
bundleSrc = patchCode(
  bundleSrc,
  'o&&(o.textContent=c?r.title:"???"),u&&(u.textContent=s?"ヒント：？？？":r.hint,u.classList.toggle("is-hidden",c))',
  '(function(){if(o){if(c&&r.title){var otm=/^\\{ja\\}([\\s\\S]*?)\\{\\/ja\\}([\\s\\S]*)$/.exec(r.title);if(otm){o.replaceChildren();var jO=document.createElement("span");jO.className="c-ending-ja",jO.textContent=otm[1];var zO=document.createElement("span");zO.className="c-ending-zh",zO.textContent=otm[2];o.append(jO,zO)}else o.textContent=r.title}else o.textContent="???"}if(u){var hStr=s?"ヒント：？？？":r.hint;if(hStr){var uhm=/^\\{ja\\}([\\s\\S]*?)\\{\\/ja\\}([\\s\\S]*)$/.exec(hStr);if(uhm){u.replaceChildren();var jU=document.createElement("span");jU.className="c-hint-ja",jU.textContent=uhm[1];var zU=document.createElement("span");zU.className="c-hint-zh",zU.textContent=uhm[2];u.append(jU,zU)}else u.textContent=hStr}u.classList.toggle("is-hidden",c)}})()',
  'ending (titles & hints)',
);

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
    const biMatch = /^\{ja\}([\s\S]*?)\{\/ja\}([\s\S]*)$/.exec(replacement);
    const formatted = biMatch
      ? `<span class="c-bilingual-ja">${escapeText(biMatch[1])}</span><span class="c-bilingual-zh">${escapeText(biMatch[2])}</span>`
      : escapeText(replacement);
    result += src.slice(last, at + offset) + formatted;
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

// 追加中文字体覆盖与免责声明样式
const ZH_CSS = 'assets/css/zh-cn.css';
html = html.replace(
  /(<link rel="stylesheet" href="\.\/assets\/css\/app\.css[^>]*>)/i,
  `$1\n    <link rel="stylesheet" href="./${ZH_CSS}">`,
);

// 注入进入前免责声明与致谢弹窗
const DISCLAIMER_HTML = `
    <!-- 进入前免责声明与致谢 -->
    <div class="c-disclaimer js-disclaimer" id="site-disclaimer" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <div class="c-disclaimer__backdrop"></div>
      <div class="c-disclaimer__inner">
        <div class="c-disclaimer__dialog">
          <div class="c-disclaimer__head">
            <span class="c-disclaimer__head-sub">PROJECT SEKAI · あやかし横丁</span>
            <h2 class="c-disclaimer__head-title" id="disclaimer-title">进入前提示与免责声明</h2>
          </div>
          <div class="c-disclaimer__content">
            <section class="c-disclaimer__section">
              <div class="c-disclaimer__section-title">
                <span class="c-disclaimer__badge">版权声明</span>
                <span>游戏版权及素材归属</span>
              </div>
              <p class="c-disclaimer__section-text">
                本项目游戏版权、素材等所有权均归 <strong>SEGA / Colorful Palette</strong> 所有。本站仅供个人学习交流与非商业研究，严禁用于任何商业用途。
              </p>
            </section>

            <section class="c-disclaimer__section">
              <div class="c-disclaimer__section-title">
                <span class="c-disclaimer__badge">汉化说明</span>
                <span>AI 生成技术提示</span>
              </div>
              <p class="c-disclaimer__section-text">
                本站汉化使用 <strong>AI 生成技术</strong> 辅助翻译与润色，可能不是很准确，敬请各位玩家理解与包涵。
              </p>
            </section>

            <section class="c-disclaimer__section">
              <div class="c-disclaimer__section-title">
                <span class="c-disclaimer__badge">支持与致谢</span>
                <span>特别鸣谢</span>
              </div>
              <p class="c-disclaimer__section-text">
                感谢 <strong>moesekai</strong> (<a href="https://pjsk.moe" target="_blank" rel="noopener noreferrer" class="c-disclaimer__link">pjsk.moe</a>) 的大力支持！
              </p>
            </section>
          </div>

          <div class="c-disclaimer__foot">
            <div class="c-disclaimer__countdown-track">
              <div class="c-disclaimer__countdown-bar js-disclaimer-bar"></div>
            </div>
            <button class="c-disclaimer__btn js-disclaimer-btn" type="button" disabled>
              <span class="c-disclaimer__btn-text js-disclaimer-btn-text">请仔细阅读 (10s)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <script>
      (function() {
        var disclaimer = document.getElementById('site-disclaimer');
        if (!disclaimer) return;
        var btn = disclaimer.querySelector('.js-disclaimer-btn');
        var btnText = disclaimer.querySelector('.js-disclaimer-btn-text');
        var bar = disclaimer.querySelector('.js-disclaimer-bar');
        var duration = 10;
        var remaining = duration;

        function tick() {
          if (remaining > 0) {
            btn.disabled = true;
            if (btnText) btnText.textContent = '请仔细阅读 (' + remaining + 's)';
            if (bar) bar.style.width = (((duration - remaining) / duration) * 100) + '%';
            remaining--;
            setTimeout(tick, 1000);
          } else {
            btn.disabled = false;
            disclaimer.classList.add('is-ready');
            if (btnText) btnText.textContent = '我已阅读并知悉 · 进入游戏';
            if (bar) bar.style.width = '100%';
          }
        }

        btn.addEventListener('click', function() {
          if (btn.disabled) return;
          disclaimer.classList.add('is-dismissed');
          setTimeout(function() {
            disclaimer.remove();
          }, 400);
        });

        tick();
      })();
    </script>`;

html = html.replace('</body>', `${DISCLAIMER_HTML}\n  </body>`);

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

/* ---------------------------------------------------------------- 日中双语排版样式 */
.c-content__content-dialogue {
  min-height: calc(264 * var(--vw-scale));
  height: auto;
  max-height: calc(380 * var(--vw-scale));
  padding: calc(48 * var(--vw-scale)) calc(48 * var(--vw-scale)) calc(40 * var(--vw-scale));
}

.c-bilingual-ja {
  display: block;
  font-size: calc(18 * var(--vw-scale));
  line-height: 1.35;
  color: #7a0e15;
  opacity: 0.85;
  margin-bottom: calc(6 * var(--vw-scale));
  white-space: pre-wrap;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.c-bilingual-zh {
  display: block;
  font-size: calc(28 * var(--vw-scale));
  line-height: 1.55;
  color: var(--c-black, #142E5A);
  font-weight: 600;
  white-space: pre-wrap;
  letter-spacing: 0.03em;
}

.c-bilingual-zh .c-in-em {
  font-size: 1.2em;
  font-weight: 700;
  color: var(--c-red, #D93843);
}

/* 选项双语排版 */
.c-choice__content-list-item-text {
  display: flex;
  flex-direction: column;
  gap: calc(4 * var(--vw-scale));
}

.c-choice-ja {
  display: block;
  font-size: calc(18 * var(--vw-scale));
  line-height: 1.3;
  color: #7a0e15;
  opacity: 0.85;
  white-space: pre-wrap;
}

.c-choice-zh {
  display: block;
  font-size: calc(26 * var(--vw-scale));
  line-height: 1.45;
  font-weight: 600;
  color: var(--c-black, #142E5A);
  white-space: pre-wrap;
}

/* Backlog 历史记录双语排版 */
.c-backlog__content-backlog-list-item .c-bilingual-ja {
  font-size: calc(18 * var(--vw-scale));
  color: #7a0e15;
  opacity: 0.85;
  margin-bottom: calc(4 * var(--vw-scale));
}

.c-backlog__content-backlog-list-item .c-bilingual-zh {
  font-size: calc(24 * var(--vw-scale));
  color: #3f2a1d;
  line-height: 1.5;
}

/* 结局一览双语 */
.c-ending-ja,
.c-hint-ja {
  display: block;
  font-size: calc(16 * var(--vw-scale));
  line-height: 1.3;
  color: #7a0e15;
  opacity: 0.85;
}

.c-ending-zh,
.c-hint-zh {
  display: block;
}

/* ---------------------------------------------------------------- 进入前免责声明弹窗 */
.c-disclaimer {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-content: center;
  width: 100vw;
  height: 100svh;
  opacity: 1;
  visibility: visible;
  transition: opacity 0.35s ease, visibility 0.35s linear;
}

.c-disclaimer.is-dismissed {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.c-disclaimer__backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--c-black, #142E5A) 82%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.c-disclaimer__inner {
  position: relative;
  z-index: 2;
  margin: 0 auto;
  width: min(calc(708 * var(--vw-scale)), 92vw);
  max-height: 92svh;
  display: flex;
  flex-direction: column;
}

.c-disclaimer__dialog {
  display: flex;
  flex-direction: column;
  max-height: 92svh;
  background: var(--c-white, #FFFBF5);
  border: solid calc(4 * var(--vw-scale)) var(--c-brown, #7A0E15);
  border-radius: calc(24 * var(--vw-scale));
  box-shadow:
    0 calc(8 * var(--vw-scale)) calc(30 * var(--vw-scale)) rgba(0, 0, 0, 0.45),
    calc(4 * var(--vw-scale)) calc(4 * var(--vw-scale)) 0 #fffaf3 inset;
  overflow: hidden;
}

.c-disclaimer__head {
  padding: calc(28 * var(--vw-scale)) calc(32 * var(--vw-scale)) calc(20 * var(--vw-scale));
  background: linear-gradient(135deg, #7a0e15 0%, #d93843 100%);
  color: var(--c-white, #FFFBF5);
  text-align: center;
  border-bottom: solid calc(3 * var(--vw-scale)) var(--c-brown, #7A0E15);
}

.c-disclaimer__head-sub {
  display: inline-block;
  font-size: calc(18 * var(--vw-scale));
  letter-spacing: 0.12em;
  font-weight: 700;
  color: var(--c-yellow, #FFC248);
  margin-bottom: calc(4 * var(--vw-scale));
}

.c-disclaimer__head-title {
  margin: 0;
  font-size: calc(34 * var(--vw-scale));
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.3;
  color: var(--c-white, #FFFBF5);
  text-shadow: 0 calc(2 * var(--vw-scale)) calc(4 * var(--vw-scale)) rgba(0, 0, 0, 0.35);
}

.c-disclaimer__content {
  overflow-y: auto;
  padding: calc(28 * var(--vw-scale)) calc(32 * var(--vw-scale));
  display: flex;
  flex-direction: column;
  gap: calc(20 * var(--vw-scale));
  -webkit-overflow-scrolling: touch;
}

.c-disclaimer__content::-webkit-scrollbar {
  width: calc(6 * var(--vw-scale));
}
.c-disclaimer__content::-webkit-scrollbar-thumb {
  background: #d0b394;
  border-radius: calc(10 * var(--vw-scale));
}

.c-disclaimer__section {
  padding: calc(20 * var(--vw-scale)) calc(24 * var(--vw-scale));
  background: #fbf5eb;
  border: solid calc(2 * var(--vw-scale)) var(--c-beige, #E7D5BD);
  border-radius: calc(16 * var(--vw-scale));
  box-shadow: 0 calc(2 * var(--vw-scale)) calc(6 * var(--vw-scale)) rgba(0, 0, 0, 0.04);
}

.c-disclaimer__section-title {
  display: flex;
  align-items: center;
  gap: calc(12 * var(--vw-scale));
  font-size: calc(24 * var(--vw-scale));
  font-weight: 700;
  color: var(--c-brown, #7A0E15);
  margin-bottom: calc(10 * var(--vw-scale));
}

.c-disclaimer__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: calc(2 * var(--vw-scale)) calc(12 * var(--vw-scale));
  font-size: calc(16 * var(--vw-scale));
  font-weight: 700;
  color: var(--c-white, #FFFBF5);
  background: var(--c-red, #D93843);
  border-radius: 999em;
  letter-spacing: 0.04em;
}

.c-disclaimer__section-text {
  font-size: calc(21 * var(--vw-scale));
  line-height: 1.65;
  color: #3f2a1d;
  letter-spacing: 0.03em;
  margin: 0;
}

.c-disclaimer__section-text strong {
  font-weight: 700;
  color: var(--c-brown, #7A0E15);
}

.c-disclaimer__link {
  color: var(--c-red, #D93843);
  text-decoration: underline;
  font-weight: 700;
  text-underline-offset: calc(3 * var(--vw-scale));
  transition: opacity 0.2s ease;
}

.c-disclaimer__link:hover {
  opacity: 0.75;
}

.c-disclaimer__foot {
  padding: calc(18 * var(--vw-scale)) calc(32 * var(--vw-scale)) calc(28 * var(--vw-scale));
  background: #fdfaf6;
  border-top: solid calc(2 * var(--vw-scale)) var(--c-beige, #E7D5BD);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: calc(14 * var(--vw-scale));
}

.c-disclaimer__countdown-track {
  width: 100%;
  height: calc(8 * var(--vw-scale));
  background: var(--c-beige, #E7D5BD);
  border-radius: 999em;
  overflow: hidden;
}

.c-disclaimer__countdown-bar {
  width: 0%;
  height: 100%;
  background: linear-gradient(90deg, var(--c-yellow, #FFC248) 0%, var(--c-red, #D93843) 100%);
  border-radius: 999em;
  transition: width 0.95s linear;
}

.c-disclaimer__btn {
  display: grid;
  place-content: center;
  position: relative;
  width: min(calc(520 * var(--vw-scale)), 100%);
  height: calc(88 * var(--vw-scale));
  border: solid calc(4 * var(--vw-scale)) var(--c-brown, #7A0E15);
  border-radius: 999em;
  background-color: var(--c-beige, #E7D5BD);
  box-shadow:
    calc(4 * var(--vw-scale)) calc(4 * var(--vw-scale)) 0 #fffaf3 inset,
    calc(6 * var(--vw-scale)) calc(6 * var(--vw-scale)) 0 color-mix(in srgb, #000 14%, transparent);
  cursor: not-allowed;
  opacity: 0.65;
  filter: grayscale(0.6);
  transition: all 0.3s ease;
}

.c-disclaimer.is-ready .c-disclaimer__btn {
  background-color: var(--c-red, #D93843);
  cursor: pointer;
  opacity: 1;
  filter: none;
  animation: disclaimer-btn-pulse 2s infinite;
}

@keyframes disclaimer-btn-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow:
      calc(4 * var(--vw-scale)) calc(4 * var(--vw-scale)) 0 #fffaf3 inset,
      0 0 calc(12 * var(--vw-scale)) rgba(217, 56, 67, 0.45);
  }
  50% {
    transform: scale(1.02);
    box-shadow:
      calc(4 * var(--vw-scale)) calc(4 * var(--vw-scale)) 0 #fffaf3 inset,
      0 0 calc(22 * var(--vw-scale)) rgba(217, 56, 67, 0.7);
  }
}

@media (any-hover: hover) {
  .c-disclaimer.is-ready .c-disclaimer__btn:hover {
    transform: scale(1.04);
  }
}

.c-disclaimer__btn-text {
  font-weight: 700;
  font-size: calc(28 * var(--vw-scale));
  letter-spacing: 0.06em;
  line-height: 1;
  color: #7A0E15;
}

.c-disclaimer.is-ready .c-disclaimer__btn-text {
  color: var(--c-white, #FFFBF5);
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
