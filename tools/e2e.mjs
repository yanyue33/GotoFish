#!/usr/bin/env node
/**
 * 无头端到端测试：用真实浏览器（本机 Chromium / Edge）把整个游戏跑一遍。
 *
 *   node tools/e2e.mjs
 *
 * 它做四件事：
 *  1. 起一个本地静态服务器（复用 tools/serve.mjs 的那套逻辑）；
 *  2. 用 --headless=new 启动浏览器，打开 tests/e2e.html，开启 CDP 调试端口；
 *  3. 通过 CDP（自己实现的极简 WebSocket 客户端，零依赖）轮询页面上的
 *     window.__E2E 结果对象；
 *  4. 打印逐条结果，失败则退出码 1。
 *
 * 为什么不用 playwright：这个项目坚持零运行时依赖，连测试依赖也不引。
 * CDP 就是 JSON over WebSocket，握手 + 掩码帧几十行就够。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { connect as connectWS, CDP } from './wsmini.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * 找浏览器
 * ------------------------------------------------------------------ */

function findBrowser() {
  const env = process.env.GOTOFISH_BROWSER;
  const candidates = [
    env,
    path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'),
    path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1148/chrome-win64/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 也扫一遍 playwright 缓存目录里的任意版本
  const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      if (!dir.startsWith('chromium-')) continue;
      const p = path.join(cache, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
      const p2 = path.join(cache, dir, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(p2)) return p2;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 静态服务器
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pathname === '/') pathname = '/index.html';
      const target = path.normalize(path.join(ROOT, pathname));
      if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('404');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(urlStr, timeoutMs = 4000) {
  const res = await fetch(urlStr, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('找不到 Chromium / Chrome / Edge。');
    console.error('可以用环境变量指定：GOTOFISH_BROWSER=<浏览器可执行文件路径>');
    process.exit(2);
  }
  console.log(`浏览器：${browserPath}`);

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`本地服务器：${origin}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gotofish-e2e-'));
  const debugPort = 9200 + Math.floor(Math.random() * 700);
  const args = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    '--window-size=960,600',
    // 无头环境下用 SwiftShader 软件渲染 WebGL
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--disable-gpu-sandbox',
    // 注：不加 --no-sandbox 就跑不起来（本机 ACL 会拦住浏览器自己的子进程沙箱）
    '--no-sandbox',
    'about:blank',
  ];

  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserStderr = '';
  child.stderr.on('data', (d) => {
    browserStderr += d.toString();
    if (browserStderr.length > 20000) browserStderr = browserStderr.slice(-20000);
  });

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server.close();
    setTimeout(() => {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 300);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  // 等调试端口起来
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!targets) {
    console.error('浏览器调试端口没有起来。浏览器输出：\n' + browserStderr);
    cleanup();
    process.exit(2);
  }

  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) {
    console.error('找不到页面调试目标。目标列表：' + JSON.stringify(targets.map((t) => t.type + ':' + t.url)));
    cleanup();
    process.exit(2);
  }

  let ws;
  let cdp;
  try {
    ws = await connectWS(page.webSocketDebuggerUrl);
    cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable').catch(() => {});
    // 显式导航，确保页面确定在我们的服务器上
    const pagePath = process.env.GOTOFISH_PAGE || '/tests/e2e.html';
    await cdp.send('Page.navigate', { url: `${origin}${pagePath}` });
  } catch (err) {
    console.error('连接调试通道失败：' + err.message);
    cleanup();
    process.exit(2);
  }

  // 轮询结果
  const deadline = Date.now() + 240000;
  let result = null;
  let lastText = '';
  let diag = null;
  let diagAt = 0;
  const shotOnly = process.env.GOTOFISH_PAGE && process.env.GOTOFISH_SCREENSHOT;
  while (Date.now() < deadline) {
    if (shotOnly) {
      // 截图模式：不等测试结果，等游戏起来就行
      const ready = await cdp.eval('!!(window.__shot && window.__shot.ready)').catch(() => false);
      if (ready) {
        result = { done: true, pass: 0, fail: 0, text: '（截图模式，不跑测试）', errors: [] };
        break;
      }
      await sleep(300);
      continue;
    }
    try {
      const r = await cdp.eval('window.__E2E ? JSON.parse(JSON.stringify(window.__E2E)) : null');
      if (r && r.done) {
        result = r;
        break;
      }
      const partial = await cdp.eval('(document.getElementById("results")||{}).textContent || ""');
      if (typeof partial === 'string' && partial !== lastText) {
        lastText = partial;
        const tail = partial.trim().split('\n').slice(-1)[0];
        if (tail) process.stdout.write(`\r… ${tail.slice(0, 90)}\x1b[K`);
      }
      // 每 5 秒做一次诊断，方便定位「脚本根本没跑」之类的启动问题
      if (Date.now() - diagAt > 5000) {
        diagAt = Date.now();
        diag = await cdp.eval(`JSON.stringify({
          href: location.href,
          ready: document.readyState,
          started: !!window.__E2E_STARTED,
          hasGame: !!window.game,
          resultLen: (document.getElementById('results')||{textContent:''}).textContent.length
        })`);
      }
    } catch (err) {
      // 页面可能还在导航
    }
    await sleep(400);
  }

  process.stdout.write('\r\x1b[K');
  console.log('\n────────────────────────────────────────────────────');
  if (!result) {
    console.error('测试超时（页面没有给出结果）。');
    console.log('页面状态：' + (diag || '(读不到)'));
    if (cdp.console.length) {
      console.log('\n页面控制台（尾部 30 条）：');
      for (const line of cdp.console.slice(-30)) console.log('  · ' + line);
    }
    const snapshot = await cdp
      .eval('(document.getElementById("results")||{}).textContent || "(没有输出)"')
      .catch(() => '(读不到页面内容)');
    console.log('\n页面输出：\n' + snapshot);
    if (browserStderr.trim()) console.log('\n浏览器输出（尾部）：\n' + browserStderr.split('\n').slice(-25).join('\n'));
    cleanup();
    process.exit(1);
  }

  console.log(result.text);
  console.log('────────────────────────────────────────────────────');
  if (result.errors && result.errors.length) {
    console.log('页面内的未捕获错误：');
    for (const e of result.errors) console.log('  · ' + e);
  }

  // 可选：截一张游戏画面，方便人工看一眼渲染结果
  if (process.env.GOTOFISH_SCREENSHOT) {
    const outPath = path.resolve(process.env.GOTOFISH_SCREENSHOT);
    // 机位预设：GOTOFISH_SHOT_VIEW=pier|island|shop|pond
    const view = process.env.GOTOFISH_SHOT_VIEW || 'pier';
    const views = {
      pier: 'p.set(0, g.player.groundAt(0, 52), 52); g.player.yaw = 0; g.player.pitch = -0.12;',
      island: 'p.set(0, g.player.groundAt(0, 62), 62); g.player.yaw = Math.PI; g.player.pitch = 0.06;',
      shop: 'p.set(-8, g.player.groundAt(-8, 18), 18); g.player.yaw = -2.4; g.player.pitch = -0.04;',
      pond: 'p.set(0, g.player.groundAt(0, 17), 17); g.player.yaw = Math.PI; g.player.pitch = 0.10;',
      // 俯瞰：把相机从玩家身上挪开，直接看整座岛（只用于截图/巡检）
      orbit: 'p.set(0, g.player.groundAt(0, 40), 40); window.__freezeCamPose = { x: 0, y: 74, z: 108, tx: 0, ty: 2, tz: 0 };',
    };
    try {
      await cdp.eval(`(() => {
        const g = window.game || (window.__shot && window.__shot.game);
        if (!g) return 'no game';
        // 截图时把测试输出遮罩藏起来
        const res = document.getElementById('results');
        if (res) res.style.display = 'none';
        const p = g.player.position;
        ${views[view] || views.pier}
        const rod = g.state.inventory.items.find((i) => i && i.kind === 'rod');
        if (rod) {
          g.state.inventory.setHand(g.state.inventory.items.indexOf(rod));
          g.onHandChanged();
        }
        // 顺手让 HUD 有点内容，截图更好看
        g.state.money = 2480;
        g.state.hunger = 78;
        g.state.dayTime = 9 * 60 + 20;
        return 'ok';
      })()`);
      await sleep(1800);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
      console.log(`已保存截图（${view}）：${outPath}`);
    } catch (err) {
      console.log('截图失败：' + err.message);
    }
  }

  console.log(result.fail === 0 ? `\x1b[32m端到端测试通过\x1b[0m：${result.pass} 项` : `\x1b[31m端到端测试失败\x1b[0m：${result.fail} 项失败 / ${result.pass} 项通过`);

  cleanup();
  process.exit(result.fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('运行器异常：', err);
  process.exit(2);
});
