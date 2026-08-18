#!/usr/bin/env node
/**
 * 从 mirror/ 抽取所有需要汉化的文本。
 *
 * 产出两个文件：
 *   i18n/source.ja.json   机器生成，勿手改。记录每条原文的分类、出现次数、AST 路径。
 *   i18n/zh-Hans.json     翻译工作文件。按分类分组，key = 日文原文，value = 译文（空串 = 未翻译）。
 *                         重新运行本脚本会保留已填写的译文，并增删条目。
 *
 * 关键设计：翻译表以「原文字符串」为键做全局替换，而不是按出现位置逐条替换。
 * 原因是 bundle 里的角色名既是显示文本，又是查头像用的字典键
 * （Ye = {"イチカ":"ichika", ...}，运行时用 name 去查 icon_ichika.webp），
 * 还被 name === "自分" 这类判断用作比较值。全局同值替换能让三者自动保持一致，
 * 逐条替换反而会把它们拆散、导致头像丢失。代价是同一句原文在全站只能有一个译法。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'mirror/assets/js/common/app.bundle.js');
const HTML = join(ROOT, 'mirror/index.html');
const SOURCE_OUT = join(ROOT, 'i18n/source.ja.json');
const TRANSLATION_OUT = join(ROOT, 'i18n/zh-Hans.json');

const JAPANESE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * 这些属性的值按定义就是给玩家看的文本，不做日文字符判断直接收录，
 * 否则像 name:"？？？"、title:"???" 这种全角/半角占位符会被漏掉。
 */
const TEXT_KEYS = new Set(['text', 'name', 'characterName', 'title', 'hint']);

/** 分组顺序 = 翻译文件里的呈现顺序，也是同一条原文归属分类的优先级 */
const KIND_ORDER = [
  'speaker', // 说话人名 / 头像字典键，改动会牵连头像查找，务必整表一致
  'dialogue', // 剧情正文
  'choice', // 分歧选项
  'ending-title', // 结局名
  'ending-hint', // 结局提示
  'ui', // 界面按钮、提示、弹窗等散落文案
  'html-text', // index.html 里的可见文本节点
  'html-attr', // index.html 里的 alt / title / meta content 等属性
];

const keyName = (node) =>
  node.type === 'Identifier' ? node.name : node.type === 'Literal' ? String(node.value) : null;

const hasProp = (objectNode, name) =>
  objectNode?.type === 'ObjectExpression' &&
  objectNode.properties.some((p) => p.type === 'Property' && keyName(p.key) === name);

/** 由 AST 祖先链拼出可读路径，例如 routeD_3.choices[1].text */
function astPath(ancestors) {
  const parts = [];
  for (let i = 0; i < ancestors.length - 1; i++) {
    const node = ancestors[i];
    const child = ancestors[i + 1];
    if (node.type === 'Property' && node.value === child) {
      const k = keyName(node.key);
      if (k) parts.push(k);
    } else if (node.type === 'ArrayExpression') {
      const idx = node.elements.indexOf(child);
      if (idx >= 0 && parts.length) parts[parts.length - 1] += `[${idx}]`;
    }
  }
  return parts.join('.');
}

// ---------------------------------------------------------------- bundle

const bundleSrc = await readFile(BUNDLE, 'utf8');
const ast = acorn.parse(bundleSrc, { ecmaVersion: 'latest', sourceType: 'script' });

/** @type {Map<string, {kinds:Set<string>, count:number, paths:Set<string>}>} */
const found = new Map();
const templateHits = [];

function record(value, kind, path, force = false) {
  if (!force && !JAPANESE.test(value)) return;
  if (!value.trim()) return;
  let entry = found.get(value);
  if (!entry) found.set(value, (entry = { kinds: new Set(), count: 0, paths: new Set() }));
  entry.kinds.add(kind);
  entry.count += 1;
  if (path && entry.paths.size < 4) entry.paths.add(path);
}

walk.fullAncestor(ast, (node, _state, ancestors) => {
  // acorn-walk 的 base.Property 只在 computed 时才递归 key，
  // 所以 {"イチカ":"ichika"} 这种字面量键不会作为 Literal 节点被访问，必须在这里单独捞。
  // 漏掉它的后果是：只翻了 name:"イチカ" 而字典键还是日文，运行时查不到头像。
  if (node.type === 'Property' && !node.computed && node.key.type === 'Literal') {
    const k = node.key.value;
    if (typeof k === 'string' && NON_ASCII.test(k)) {
      record(k, 'speaker', `${astPath([...ancestors, node.key])}.<key>`, true);
    }
  }

  if (node.type === 'TemplateLiteral') {
    for (const q of node.quasis) {
      if (JAPANESE.test(q.value.cooked ?? '')) templateHits.push(q.value.cooked.trim());
    }
    return;
  }
  if (node.type !== 'Literal' || typeof node.value !== 'string') return;

  const parent = ancestors[ancestors.length - 2];
  const path = astPath(ancestors);

  // 对象的字面量键：这里只有角色名字典 {"イチカ":"ichika"} 会命中
  if (parent?.type === 'Property' && parent.key === node) {
    if (NON_ASCII.test(node.value)) {
      record(node.value, 'speaker', path ? `${path}.<key>` : '<key>', true);
    }
    return;
  }

  if (parent?.type === 'Property' && parent.value === node) {
    const key = keyName(parent.key);
    const owner = ancestors[ancestors.length - 3]; // 承载该属性的对象
    // 只对非 ASCII 的值放宽日文判断。bundle 里打包了 core-js 之类的库，
    // 它们也有 name:"isWellKnownSymbol" 这种属性，无条件收录会把它们混进来。
    const force = TEXT_KEYS.has(key) && NON_ASCII.test(node.value);
    if (key === 'text') {
      record(node.value, hasProp(owner, 'nextSceneId') ? 'choice' : 'dialogue', path, force);
      return;
    }
    if (key === 'name' || key === 'characterName') {
      record(node.value, 'speaker', path, force);
      return;
    }
    if (key === 'title') {
      // 结局一览的条目形如 {id, title, characterName}，再和 {hint, isTrueEnding} 合并
      const isEnding = hasProp(owner, 'id') || hasProp(owner, 'characterName');
      record(node.value, isEnding ? 'ending-title' : 'ui', path, force && isEnding);
      return;
    }
    if (key === 'hint') {
      record(node.value, 'ending-hint', path, force);
      return;
    }
  }
  record(node.value, 'ui', path);
});

// ---------------------------------------------------------------- index.html

const htmlSrc = await readFile(HTML, 'utf8');

/** 逐个跳过 script/style 内容后，取标签之间的文本节点 */
function htmlTextNodes(html) {
  const out = [];
  const stripped = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => ' '.repeat(m.length));
  const re = />([^<]+)</g;
  let m;
  while ((m = re.exec(stripped))) {
    const raw = m[1];
    const text = raw.trim();
    if (text && JAPANESE.test(text)) out.push({ text, index: m.index + 1, raw });
  }
  return out;
}

for (const node of htmlTextNodes(htmlSrc)) record(node.text, 'html-text', 'index.html');

const ATTR_RE = /\b(alt|title|placeholder|content|aria-label)\s*=\s*"([^"]*)"/gi;
for (let m; (m = ATTR_RE.exec(htmlSrc)); ) {
  if (JAPANESE.test(m[2])) record(m[2], 'html-attr', `index.html@${m[1]}`);
}
const titleTag = htmlSrc.match(/<title>([^<]*)<\/title>/i);
if (titleTag && JAPANESE.test(titleTag[1])) record(titleTag[1].trim(), 'html-text', 'index.html@title');

// ---------------------------------------------------------------- 组装输出

const primaryKind = (kinds) => KIND_ORDER.find((k) => kinds.has(k)) ?? 'ui';

const entries = [...found.entries()].map(([ja, meta]) => ({
  ja,
  kind: primaryKind(meta.kinds),
  alsoSeenAs: [...meta.kinds].filter((k) => k !== primaryKind(meta.kinds)),
  count: meta.count,
  paths: [...meta.paths],
}));

const byKind = Object.fromEntries(
  KIND_ORDER.map((k) => [k, entries.filter((e) => e.kind === k)]).filter(([, v]) => v.length),
);

await writeFile(
  SOURCE_OUT,
  `${JSON.stringify(
    {
      _generatedBy: 'scripts/extract-strings.mjs — 请勿手改，重新运行即可刷新',
      generatedAt: new Date().toISOString(),
      bundleSha256: createHash('sha256').update(bundleSrc).digest('hex'),
      totals: {
        unique: entries.length,
        occurrences: entries.reduce((n, e) => n + e.count, 0),
        byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])),
      },
      templateLiteralsWithJapanese: [...new Set(templateHits)],
      entries: Object.fromEntries(
        Object.entries(byKind).map(([k, v]) => [
          k,
          v.map(({ ja, count, paths, alsoSeenAs }) => ({ ja, count, paths, alsoSeenAs })),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);

// 合并已有译文
const previous = existsSync(TRANSLATION_OUT) ? JSON.parse(await readFile(TRANSLATION_OUT, 'utf8')) : {};
const priorFlat = new Map();
for (const [k, group] of Object.entries(previous)) {
  if (k.startsWith('_') || typeof group !== 'object') continue;
  for (const [ja, zh] of Object.entries(group)) if (zh) priorFlat.set(ja, zh);
}

const translation = {
  _meta: {
    doc: 'key = 日文原文，value = 简体中文译文；留空表示未翻译，构建时会原样保留日文。',
    warning:
      'speaker 组同时是头像字典的键（运行时用它查 icon_<slug>.webp），改了必须整组一致，否则头像会丢失。',
    note: '同一句原文全站共用一个译法。重新运行 npm run extract 会保留已填内容。',
    kinds: KIND_ORDER,
  },
};
let translated = 0;
for (const [kind, list] of Object.entries(byKind)) {
  translation[kind] = {};
  for (const e of list) {
    const zh = priorFlat.get(e.ja) ?? '';
    if (zh) translated++;
    translation[kind][e.ja] = zh;
  }
}
await writeFile(TRANSLATION_OUT, `${JSON.stringify(translation, null, 2)}\n`);

// ---------------------------------------------------------------- 报告

console.log('抽取完成');
console.log(`  唯一原文 ${entries.length} 条 / 出现 ${entries.reduce((n, e) => n + e.count, 0)} 次`);
for (const [k, v] of Object.entries(byKind)) {
  console.log(`  ${k.padEnd(14)} ${String(v.length).padStart(5)} 条`);
}
const multi = entries.filter((e) => e.alsoSeenAs.length);
if (multi.length) {
  console.log(`  跨分类复用 ${multi.length} 条（同一原文在多处出现，只能有一个译法）：`);
  for (const e of multi.slice(0, 10)) {
    console.log(`    ${JSON.stringify(e.ja).slice(0, 40)} -> ${e.kind} + ${e.alsoSeenAs.join(',')}`);
  }
}
if (templateHits.length) {
  console.log(`  ! 模板字符串里还有 ${new Set(templateHits).size} 处日文，需手工处理：`);
  for (const t of [...new Set(templateHits)].slice(0, 10)) console.log(`    ${t.slice(0, 60)}`);
}
console.log(`  已有译文 ${translated} 条`);
console.log(`\n-> ${SOURCE_OUT}\n-> ${TRANSLATION_OUT}`);
