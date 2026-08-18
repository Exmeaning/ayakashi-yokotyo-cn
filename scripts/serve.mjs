#!/usr/bin/env node
/**
 * 本地静态服务器，专门照顾这个站点的两个需求：
 *   1. 音频可拖动 —— BGM/SE 是 mp3，<audio> 需要服务端支持 Range 请求
 *   2. 可被 iframe 嵌入 —— 不发 X-Frame-Options，用 CSP frame-ancestors 控制允许的父页面
 *
 * 用法：
 *   node scripts/serve.mjs
 *   node scripts/serve.mjs --dir mirror --port 8080          # 看日文原版
 *   node scripts/serve.mjs --frame-ancestors "https://example.com"   # 只允许指定站点嵌入
 *
 * 挂载点：
 *   /                    汉化站点
 *   /ayakashi-yokotyo/   同一份内容挂在子路径下（验证站点在任意子目录都能跑）
 *   /embed-demo          iframe 嵌入示例
 */
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SITE_DIR = join(ROOT, arg('dir', 'dist'));
const PORT = Number(arg('port', 5173));
const HOST = arg('host', '127.0.0.1');
/** 允许哪些页面把本站嵌进 iframe。'*' = 不限制 */
const FRAME_ANCESTORS = arg('frame-ancestors', '*');
/** 子路径挂载点，用来验证站点不依赖固定根路径 */
const SUBPATH = '/ayakashi-yokotyo/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/vnd.microsoft.icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

/** 把 URL 路径解析成 SITE_DIR 内的真实文件，越界一律拒绝 */
function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.startsWith(SUBPATH)) rel = `/${rel.slice(SUBPATH.length)}`;
  else if (`${rel}/` === SUBPATH) rel = '/';
  if (rel.endsWith('/')) rel += 'index.html';

  const safe = normalize(rel).replace(/^([/\\])+/, '');
  if (safe === '..' || safe.startsWith(`..${sep}`)) return null;
  return join(SITE_DIR, safe);
}

function setCommonHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  // 关键：不设置 X-Frame-Options（它没有「按来源放行」的表达能力，且会被浏览器优先当成拒绝）。
  // 改用 CSP frame-ancestors，既能允许嵌入，也能收紧到指定来源。
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  // 跨源嵌入时，iframe 内文档取 assets 属于同源请求；但父页面若要 fetch 这些资源需要 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
}

const EMBED_DEMO = (origin) => `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>嵌入示例 · 妖怪小巷的暑假</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background: #14121c; color: #eee; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #b9b3c8; font-size: 13px; line-height: 1.7; margin: 4px 0 16px; }
  code { background: #241f31; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  /* 游戏是竖屏为主的移动端布局，给一个手机比例的容器最贴近真机 */
  .frame { width: 100%; max-width: 430px; aspect-ratio: 9 / 16; margin: 0 auto;
           border: 1px solid #3a3350; border-radius: 12px; overflow: hidden;
           background: #000; box-shadow: 0 12px 40px rgb(0 0 0 / .5); }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>iframe 嵌入示例</h1>
    <p>
      下面的 iframe 指向 <code>${origin}${SUBPATH}</code>，用来同时验证两件事：
      站点挂在子路径下依然能加载全部资源，以及它能被外部页面嵌入。
      <code>allow="autoplay"</code> 是必须的，否则 BGM 会被 iframe 的权限策略挡掉。
    </p>
    <div class="frame">
      <iframe
        src="${SUBPATH}"
        title="妖怪小巷的暑假"
        allow="autoplay; fullscreen"
        referrerpolicy="no-referrer"></iframe>
    </div>
  </div>
</body>
</html>
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/embed-demo' || url.pathname === '/embed-demo/') {
    const body = EMBED_DEMO(`${url.protocol}//${url.host}`);
    setCommonHeaders(res, MIME['.html']);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
    return;
  }

  const filePath = resolveFile(url.pathname);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${url.pathname.replace(/\/?$/, '/')}` }).end();
      return;
    }
  } catch {
    setCommonHeaders(res, MIME['.html']);
    res.writeHead(404).end('<h1>404</h1>');
    return;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  setCommonHeaders(res, type);
  res.setHeader('Accept-Ranges', 'bytes');

  // Range 请求：<audio> 拖进度条和 Safari 的音频加载都依赖它
  const range = req.headers.range;
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', info.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
});

// dist 还没构建时给个明确提示，别让用户对着 404 猜
try {
  await readFile(join(SITE_DIR, 'index.html'));
} catch {
  console.error(`找不到 ${join(SITE_DIR, 'index.html')}`);
  console.error('先跑 npm run build（或 --dir mirror 直接看日文原版）');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const origin = `http://${HOST}:${PORT}`;
  console.log(`站点目录  ${SITE_DIR}`);
  console.log(`根路径    ${origin}/`);
  console.log(`子路径    ${origin}${SUBPATH}`);
  console.log(`嵌入示例  ${origin}/embed-demo`);
  console.log(`frame-ancestors: ${FRAME_ANCESTORS}`);
});
