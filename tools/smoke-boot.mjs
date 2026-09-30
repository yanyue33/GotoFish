#!/usr/bin/env node
/**
 * 冒烟启动检查：用真实浏览器打开 index.html，确认「玩家看到的那一页」能起来。
 *
 *   node tools/smoke-boot.mjs
 *
 * 与 test:e2e 的区别：e2e 跑的是 tests/e2e.html（自带 DOM 与测试脚本），
 * 这个检查跑的是真正的 index.html，验证的是**发布路径**本身：
 *   - 开始遮罩出现、按钮可点；
 *   - 点了之后游戏真的开始渲染（有 draw call、有三角形）；
 *   - 页面上没有未捕获错误、没有触发启动失败兜底；
 *   - HUD/物品栏都建出来了。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { connect as connectWS, CDP } from './wsmini.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 服务根目录：默认是项目根；设了 GOTOFISH_ROOT 就换成别的目录
 * （用于验收「打包出来的那份能不能独立跑」）。
 */
const SERVE_ROOT = path.resolve(ROOT, process.env.GOTOFISH_ROOT || '.');

function locateBrowser() {
  const candidates = [
    process.env.GOTOFISH_BROWSER,
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
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const cache = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const p = path.join(cache, dir, sub, 'chrome.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function startStaticServer() {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const target = path.normalize(path.join(SERVE_ROOT, p));
      if (!target.startsWith(SERVE_ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404).end('404');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const browser = locateBrowser();
  if (!browser) {
    console.log('找不到浏览器，跳过冒烟启动检查。');
    process.exit(0);
  }

  // GOTOFISH_URL：直接验收一个已经部署好的线上地址（例如 GitHub Pages），
  // 这时不需要本地服务器。
  const remoteUrl = process.env.GOTOFISH_URL || null;
  let origin;
  let server = null;
  if (remoteUrl) {
    origin = remoteUrl.replace(/\/$/, '');
    console.log(`验收线上地址：${origin}`);
  } else {
    const started = await startStaticServer();
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gotofish-boot-'));
  const debugPort = 9900 + Math.floor(Math.random() * 90);

  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--mute-audio', '--window-size=960,600',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--no-sandbox',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const cleanup = () => {
    try { child.kill(); } catch { /* ignore */ }
    server?.close();
  };

  let ws;
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) });
        targets = await res.json();
        if (targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    const page = targets && targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('拿不到页面调试目标');
    ws = await connectWS(page.webSocketDebuggerUrl);
  } catch (err) {
    console.error('无法连接浏览器：' + err.message);
    cleanup();
    process.exit(2);
  }

  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable').catch(() => {});
  await cdp.send('Page.navigate', { url: `${origin}/index.html` });
  await sleep(3000);

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  const state = await cdp.eval(`JSON.stringify({
    title: document.title,
    overlayVisible: !document.getElementById('start-overlay').classList.contains('hidden'),
    hasBtn: !!document.getElementById('start-btn'),
    hasGame: !!window.game,
    slots: document.querySelectorAll('#hotbar .slot').length,
    money: (document.getElementById('hud-money')||{}).textContent,
    hasRuntimeError: !!document.getElementById('runtime-error'),
    bootFailed: /启动失败/.test(document.getElementById('start-overlay').innerHTML)
  })`).then(JSON.parse);

  check('index.html 加载完成', state.title.includes('去钓鱼'), state.title);
  check('开始遮罩出现（可以点击进入）', state.overlayVisible && state.hasBtn);
  check('没有走「启动失败」兜底', !state.bootFailed);
  check('游戏对象已创建', state.hasGame);
  check('物品栏 9 个格子都建出来了', state.slots === 9, `slots=${state.slots}`);
  check('HUD 显示金钱', String(state.money).startsWith('§'), state.money);

  // 点开始按钮，模拟玩家真正进入游戏
  await cdp.eval(`document.getElementById('start-btn').click(); 'clicked'`);
  await sleep(2500);

  const after = await cdp.eval(`JSON.stringify({
    overlayVisible: !document.getElementById('start-overlay').classList.contains('hidden'),
    calls: window.game ? window.game.renderer.info.render.calls : -1,
    tris: window.game ? window.game.renderer.info.render.triangles : -1,
    frames: window.game ? window.game.renderer.info.render.frame : -1,
    hasRuntimeError: !!document.getElementById('runtime-error'),
    fps: window.game ? window.game.fps : -1,
    baitShown: (document.getElementById('hud-bait')||{}).textContent || ''
  })`).then(JSON.parse);

  check('点击开始后遮罩消失', !after.overlayVisible);
  check('渲染器在出图（有 draw call）', after.calls > 0, `calls=${after.calls}`);
  check('场景三角面数量正常', after.tris > 500 && after.tris < 400000, `tris=${after.tris}`);
  check('帧在持续推进', after.frames > 5, `frames=${after.frames}`);
  check('没有弹出运行期错误', !after.hasRuntimeError);
  const exceptions = cdp.console.filter((l) => l.startsWith('EXCEPTION:'));
  check('没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

  console.log(`  画面：calls=${after.calls} tris=${after.tris} fps≈${after.fps}（软件渲染）`);

  if (process.env.GOTOFISH_SCREENSHOT) {
    const out = path.resolve(process.env.GOTOFISH_SCREENSHOT);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`  已保存截图：${out}`);
  }

  const failed = checks.filter((c) => !c.ok).length;
  cleanup();
  await sleep(200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed === 0 ? `\x1b[32m启动冒烟检查通过\x1b[0m：${checks.length} 项` : `\x1b[31m启动冒烟检查失败\x1b[0m：${failed}/${checks.length} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
