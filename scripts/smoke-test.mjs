#!/usr/bin/env node
/**
 * 汉化产物的冒烟测试：用 Chrome DevTools Protocol 真跑一遍游戏。
 *
 * 只靠肉眼看首页是查不出汉化事故的 —— 最典型的一类是「人名翻了、
 * 但头像字典的键没翻」，结果所有头像静默退化成 icon_secret.webp。
 * 所以这里必须真的点进剧情，检查头像 src 是否解析到了具体角色。
 *
 * 检查项：
 *   - 页面无 JS 异常、无 4xx/5xx 资源请求
 *   - 首页标题与说明文字已是中文
 *   - 能点开始、能推进对话
 *   - 说话人名是中文，且头像 src 不是 icon_secret（说明字典键与人名一致）
 *   - 立绘、背景图实际加载成功（naturalWidth > 0）
 *
 * 依赖：本机 Chrome。Node 22 自带 WebSocket，无需第三方库。
 *
 * 用法：
 *   node scripts/serve.mjs &
 *   node scripts/smoke-test.mjs                      # 默认 http://127.0.0.1:5173/
 *   node scripts/smoke-test.mjs --url <URL> --shot out.png
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const URL_UNDER_TEST = arg('url', 'http://127.0.0.1:5173/');
const SHOT = arg('shot', '');
const ADVANCE_CLICKS = Number(arg('clicks', 24));
const PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome，可用 CHROME_PATH 指定');
  process.exit(1);
}

const profile = await mkdtemp(join(tmpdir(), 'ayakashi-smoke-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=430,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 的 HTTP 端点起来，拿到浏览器级 WebSocket 地址 */
async function debuggerUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

/** 极简 CDP 客户端：send 返回结果，on 注册事件 */
function cdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.params ?? {})})`)) : resolve(msg.result);
      return;
    }
    for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(fn);
    },
  };
}

const failures = [];
const notes = [];

try {
  const wsUrl = await debuggerUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  const cdp = cdpClient(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params = {}) => cdp.send(method, params, sessionId);

  const badRequests = [];
  const jsErrors = [];
  const consoleErrors = [];

  cdp.on('Network.responseReceived', (p) => {
    if (p.response.status >= 400) badRequests.push(`${p.response.status} ${p.response.url}`);
  });
  cdp.on('Network.loadingFailed', (p) => {
    // 静音策略下浏览器可能主动取消音频请求，不算故障
    if (p.errorText !== 'net::ERR_ABORTED') badRequests.push(`失败 ${p.errorText} (${p.type})`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    jsErrors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      consoleErrors.push(p.args.map((a) => a.description ?? a.value).join(' '));
    }
  });

  await call('Network.enable');
  await call('Runtime.enable');
  await call('Page.enable');

  await call('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(3500);

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };

  // --- 首页
  const home = await evaluate(`(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    description: document.querySelector('.p-home__description-text')?.textContent?.trim() ?? '',
  }))()`);

  if (home.lang !== 'zh-Hans') failures.push(`html lang 应为 zh-Hans，实际 ${home.lang}`);
  if (/[぀-ゟ゠-ヿ]/.test(home.title)) failures.push(`标题仍含假名: ${home.title}`);
  notes.push(`标题: ${home.title}`);
  notes.push(`首页说明: ${home.description.replace(/\s+/g, ' ')}`);

  // --- 免责声明检查
  const disclaimerCheck = await evaluate(`(() => {
    const el = document.getElementById('site-disclaimer');
    if (!el) return { found: false, hasContent: false };
    const text = el.textContent || '';
    const hasContent = text.includes('SEGA') && text.includes('Colorful Palette') && text.includes('AI') && text.includes('pjsk.moe');
    el.classList.add('is-dismissed');
    el.remove();
    return { found: true, hasContent };
  })()`);

  if (!disclaimerCheck.found) {
    failures.push('未找到进入前免责声明弹窗（#site-disclaimer）');
  } else if (!disclaimerCheck.hasContent) {
    failures.push('免责声明弹窗缺少必要内容（SEGA/Colorful Palette 版权、AI 汉化或 pjsk.moe 鸣谢）');
  } else {
    notes.push('免责声明: 已包含 SEGA / Colorful Palette 版权归属、AI 汉化说明与 pjsk.moe 致谢');
  }

  // --- 点开始，然后反复推进对话
  const started = await evaluate(`(() => {
    const btn = document.querySelector('.js-scene-button[data-scene="scene1"]')
      ?? document.querySelector('.p-home__content-start-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!started) failures.push('找不到开始按钮');
  await sleep(1500);

  if (!(await evaluate(`document.body.classList.contains('is-game-screen-open')`))) {
    failures.push('点了开始按钮但没进入游戏画面（body 缺 is-game-screen-open）');
  }

  // 推进对话靠点 .c-content 本身。注意别用 querySelector('a, b, main') 这类多选择器：
  // 它返回文档顺序最靠前的匹配，会先命中 main 这种点了没反应的容器。
  const advanced = await evaluate(`(async () => {
    const target = document.querySelector('.c-content');
    if (!target) return 0;
    const seen = new Set();
    const readText = () => document.querySelector('.c-content__content-dialogue-text')?.textContent?.trim() ?? '';
    for (let i = 0; i < ${ADVANCE_CLICKS}; i++) {
      seen.add(readText());
      target.click();
      await new Promise(r => setTimeout(r, 280));
    }
    return seen.size;
  })()`);
  if (advanced < 3) failures.push(`对话没有推进（只出现 ${advanced} 种台词），点击目标可能失效`);
  else notes.push(`推进了 ${advanced} 句不同台词`);
  await sleep(1200);

  // --- 对话状态：人名、头像、立绘、背景
  const state = await evaluate(`(() => {
    const imgInfo = (i) => i ? {
      src: (i.currentSrc || i.src).split('/').slice(-2).join('/'),
      loaded: i.complete && i.naturalWidth > 0,
      w: i.naturalWidth,
      alt: i.alt,
    } : null;
    // 头像必须从对话框里取。全局找 /icon_/ 会命中页脚的 App Store 图标，测不到东西。
    const icon = document.querySelector('.c-content__content-dialogue-icon img');
    const chara = document.querySelector('.c-content__content-character img');
    const bgEl = [...document.querySelectorAll('*')]
      .find(e => /content\\/bg\\//.test(getComputedStyle(e).backgroundImage || ''));
    return {
      name: document.querySelector('.c-content__content-dialogue-name')?.textContent?.trim() ?? null,
      text: document.querySelector('.c-content__content-dialogue-text')?.textContent?.trim()?.slice(0, 40) ?? null,
      icon: imgInfo(icon),
      chara: imgInfo(chara),
      charaHidden: document.querySelector('.c-content__content-character')?.classList.contains('is-no-character') ?? null,
      bg: bgEl ? /url\\("?([^")]+)/.exec(getComputedStyle(bgEl).backgroundImage)?.[1]?.split('/').slice(-1)[0] : null,
      // 只看真的带 src 属性的 img：模板里有若干占位 <img> 天生没有 src，不算破图
      brokenImages: [...document.querySelectorAll('img')]
        .filter(i => i.getAttribute('src') && i.complete && i.naturalWidth === 0)
        .map(i => (i.currentSrc || i.src).split('/').slice(-1)[0]),
      storageKeys: Object.keys(localStorage),
    };
  })()`);

  notes.push(`说话人: ${state.name ?? '(空)'}`);
  notes.push(`台词: ${state.text ?? '(空)'}`);
  notes.push(`点击提示符: ${state.icon ? '有' : '无'}`);
  notes.push(
    `立绘: ${state.chara ? `${state.chara.src} loaded=${state.chara.loaded}` : '(无)'}` +
      (state.charaHidden ? ' [当前是无立绘场景]' : ''),
  );
  notes.push(`背景: ${state.bg ?? '(未找到)'}`);
  notes.push(`localStorage: ${JSON.stringify(state.storageKeys)}`);

  if (!state.name) failures.push('对话框里没有说话人名，可能没进到剧情');
  else if (/[぀-ゟ゠-ヿ]/.test(state.name)) failures.push(`说话人名仍是日文: ${state.name}`);

  if (state.chara && !state.chara.loaded) failures.push(`立绘未加载: ${state.chara.src}`);
  if (!state.chara) failures.push('推进这么多句后仍没有出现任何立绘');
  if (state.brokenImages.length) failures.push(`破图: ${state.brokenImages.join(', ')}`);

  // --- 结局一览：角色头像在这里，也是「人名 / 头像字典键」一致性的唯一检验点。
  // 代码是 icon = Ye[characterName] ? icon_<slug>[_silhouette].webp : icon_secret.webp
  // 所以只翻了人名、漏翻字典键的话，这一页会整屏变成问号图。
  await evaluate(`location.reload()`);
  await sleep(3000);
  await evaluate(`(() => {
    const el = document.getElementById('site-disclaimer');
    if (el) { el.classList.add('is-dismissed'); el.remove(); }
  })()`);
  const openedList = await evaluate(`(() => {
    const btn = document.querySelector('.p-home__content-endinglist-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!openedList) failures.push('找不到结局一览按钮');
  await sleep(1500);

  const endings = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.js-ending-list-item')];
    const icons = items.map(el => el.querySelector('.c-in-character img')).filter(Boolean);
    return {
      count: items.length,
      icons: icons.length,
      secret: icons.filter(i => /icon_secret/.test(i.getAttribute('src') || '')).length,
      silhouette: icons.filter(i => /_silhouette/.test(i.getAttribute('src') || '')).length,
      unloaded: icons.filter(i => i.complete && i.naturalWidth === 0).map(i => (i.src || '').split('/').pop()),
      sampleSrc: icons.slice(0, 3).map(i => (i.getAttribute('src') || '').split('/').pop()),
      hint: document.querySelector('.js-ending-list-item .c-in-hint')?.textContent?.trim().slice(0, 24) ?? null,
    };
  })()`);

  notes.push(`结局一览: ${endings.count} 条, 头像 ${endings.icons} 个, 剪影 ${endings.silhouette}, icon_secret ${endings.secret}`);
  notes.push(`头像样例: ${endings.sampleSrc.join(', ')}`);
  notes.push(`结局提示样例: ${endings.hint ?? '(空)'}`);

  if (endings.count !== 27) failures.push(`结局条目应为 27 条，实际 ${endings.count}`);
  if (endings.secret > 0) {
    failures.push(
      `${endings.secret}/${endings.icons} 个结局头像退化成 icon_secret —— 说明人名译文与头像字典键不一致`,
    );
  }
  if (endings.unloaded.length) failures.push(`结局头像加载失败: ${[...new Set(endings.unloaded)].join(', ')}`);

  if (badRequests.length) failures.push(`资源请求异常:\n    ${[...new Set(badRequests)].join('\n    ')}`);
  if (jsErrors.length) failures.push(`JS 异常:\n    ${[...new Set(jsErrors)].slice(0, 5).join('\n    ')}`);
  if (consoleErrors.length) notes.push(`console.error: ${[...new Set(consoleErrors)].slice(0, 3).join(' | ')}`);

  if (SHOT) {
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(SHOT, Buffer.from(data, 'base64'));
    notes.push(`截图: ${SHOT}`);
  }

  ws.close();
} finally {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log('冒烟测试结果');
for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n全部通过');
