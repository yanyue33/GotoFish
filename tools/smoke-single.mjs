#!/usr/bin/env node
/**
 * 单文件离线版验收：用真实浏览器以 file:// 打开 dist 里的单文件，确认它真的能玩。
 *
 *   node tools/smoke-single.mjs                    # 检查 dist/去钓鱼.html
 *   node tools/smoke-single.mjs other.html         # 或者指定别的文件
 *
 * 为什么必须单独验一次：file:// 下的模块加载规则和 http:// 完全不同
 * （不透明源 + CORS），只有真的用浏览器打开才知道有没有踩坑。
 * 这里同时确认：
 *   - 页面从 file:// 加载，且没有任何网络请求（真的离线）；
 *   - 模块图通过 Blob URL 正常加载、游戏对象建立；
 *   - 点开始后真的在出图；
 *   - 已经放到地上的掉落物 3D 模型、面板、存档都还能用。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { connect as connectWS, CDP } from './wsmini.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = path.resolve(ROOT, process.argv[2] || path.join('dist', '去钓鱼.html'));
if (!fs.existsSync(target)) {
  console.error(`找不到文件：${target}`);
  console.error('请先运行：node tools/build-single.mjs');
  process.exit(2);
}
const sizeMB = (fs.statSync(target).size / 1024 / 1024).toFixed(2);

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

const fileUrl = 'file:///' + target.replace(/\\/g, '/');
console.log(`单文件：${path.relative(ROOT, target)}（${sizeMB} MB）`);
console.log(`地址：  ${fileUrl}`);

const browser = locateBrowser();
if (!browser) {
  console.log('找不到浏览器，跳过。可用 GOTOFISH_BROWSER=<路径> 指定。');
  process.exit(0);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gotofish-single-'));
const debugPort = 9700 + Math.floor(Math.random() * 200);
const child = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--disable-component-update',
  '--mute-audio', '--window-size=960,600',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
  '--no-sandbox',
  '--allow-file-access-from-files',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const cleanup = () => {
  try { child.kill(); } catch { /* ignore */ }
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 300);
};

let ws;
let cdp;
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
  cdp = new CDP(ws);
} catch (err) {
  console.error('无法连接浏览器：' + err.message);
  cleanup();
  process.exit(2);
}

// 记录所有网络请求，用来证明「真的离线」
const requests = [];
const origEval = cdp.eval.bind(cdp);
ws.onmessage = ((orig) => (msg) => {
  if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  orig(msg);
})(ws.onmessage);

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Log.enable').catch(() => {});
await cdp.send('Page.navigate', { url: fileUrl });
await sleep(4000);

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
};

const state = await cdp.eval(`JSON.stringify({
  href: location.href,
  title: document.title,
  overlayVisible: !document.getElementById('start-overlay').classList.contains('hidden'),
  hasGame: !!window.game,
  slots: document.querySelectorAll('#hotbar .slot').length,
  bootFailed: /启动失败/.test(document.getElementById('start-overlay').innerHTML),
  hasBlobUrls: window.__GOF_URLS__ ? Object.keys(window.__GOF_URLS__).length : -1,
  unresolved: typeof window.__GOF_PENDING__ === 'number' ? window.__GOF_PENDING__ : -1,
  srcKeys: (function () {
    try { return Object.keys(JSON.parse(document.getElementById('__gof_src__').textContent).modules).length; }
    catch (e) { return 'parse-error: ' + e.message; }
  })(),
  hasRuntimeError: !!document.getElementById('runtime-error'),
  offlineNote: (document.querySelector('.offline-note') || {}).textContent || ''
})`).then(JSON.parse);

// 诊断：直接取一个 Blob 的内容，确认占位符真的被替换成了 blob URL
const blobProbe = await cdp.evalAsync(`(async () => {
  try {
    const urls = window.__GOF_URLS__ || {};
    const keys = Object.keys(urls);
    const out = { count: keys.length, samples: [] };
    for (const k of keys.slice(0, 3)) {
      const text = await (await fetch(urls[k])).text();
      out.samples.push({
        slot: k,
        len: text.length,
        leftPlaceholders: (text.match(/__GOF_M\\d+__/g) || []).slice(0, 3),
        firstImport: (text.match(/^\\s*import[^\\n]*/m) || [''])[0].slice(0, 110)
      });
    }
    const entry = urls['__GOF_M18__'];
    if (entry) {
      const text = await (await fetch(entry)).text();
      out.entry = { leftPlaceholders: (text.match(/__GOF_M\\d+__/g) || []).length,
                    firstImport: (text.match(/^\\s*import[^\\n]*/m) || [''])[0].slice(0, 110) };
    }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`).then(JSON.parse);
if (process.env.GOTOFISH_DEBUG) {
  console.log('Blob 内容探针：' + JSON.stringify(blobProbe, null, 2));
}

check('从 file:// 打开', state.href.startsWith('file:///'), state.href.slice(0, 64));
check('页面标题正确', state.title.includes('去钓鱼'), state.title);
check('没有走「启动失败」兜底', !state.bootFailed);
check('模块图通过 Blob URL 全部加载', state.hasBlobUrls >= 19, `已创建 ${state.hasBlobUrls} 个 Blob URL`);
check('所有 import 都解析成了 Blob URL（没有留占位符）', state.unresolved === 0, `未解析 ${state.unresolved} 处`);
check('游戏对象已创建', state.hasGame);
check('物品栏 9 格', state.slots === 9, `slots=${state.slots}`);
check('没有弹出运行期错误', !state.hasRuntimeError);
check('显示了离线版提示', state.offlineNote.length > 0, state.offlineNote);

// 真的点进游戏
await cdp.eval(`document.getElementById('start-btn').click(); 'ok'`);
await sleep(2500);

const after = await cdp.eval(`JSON.stringify((function(){
  var g = window.game;
  if (!g) return { noGame: true };
  // 顺手做几件真实操作：放下物品、开两个面板
  g.state.addMoney(500);
  g.state.inventory.addBait('bait_worm', 10);
  g.shop.buy('rod:rod_bamboo');
  var rod = g.state.inventory.items.find(function(i){ return i && i.kind === 'rod'; });
  if (rod) { g.state.inventory.setHand(g.state.inventory.items.indexOf(rod)); g.onHandChanged(); }
  g.ui.setPanel('stats');
  var statsCards = document.querySelectorAll('#modal-body .stat-card').length;
  g.ui.closeModal();
  g.ui.setPanel('settings');
  var hasSlider = !!document.querySelector('#modal-body input[data-set="sensitivity"]');
  g.ui.closeModal();
  var saved = g.save();
  var stored = false;
  try { stored = !!localStorage.getItem('gotofish.save.v1'); } catch (e) { stored = 'denied'; }
  return {
    calls: g.renderer.info.render.calls,
    tris: g.renderer.info.render.triangles,
    frames: g.renderer.info.render.frame,
    handModel: !!g.player.handModel,
    statsCards: statsCards,
    hasSlider: hasSlider,
    saved: saved,
    stored: stored,
    fps: g.fps,
    hasRuntimeError: !!document.getElementById('runtime-error')
  };
})())`).then(JSON.parse);

check('点开始后真的在渲染', after.calls > 0 && after.tris > 500, `calls=${after.calls} tris=${after.tris}`);
check('帧持续推进', after.frames > 10, `frames=${after.frames}`);
check('能买竿并拿在手上', after.handModel === true);
check('统计面板可用', after.statsCards >= 8, `${after.statsCards} 张统计卡`);
check('设置面板可用', after.hasSlider === true);
check('存档写盘（file:// 下也可能被浏览器禁用）',
  after.stored === true || after.stored === 'denied',
  after.stored === true ? '已写入本地存储' : '浏览器禁止本地文件存档，游戏已优雅降级');
check('没有运行期错误', !after.hasRuntimeError);

// 离线证明：除了 file:// 自身，不应该有任何 http(s) 请求
const remote = requests.filter((u) => /^https?:/.test(u));
check('没有任何网络请求（真离线）', remote.length === 0, remote.slice(0, 3).join(' | ') || '0 个外部请求');

const exceptions = cdp.console.filter((l) => l.startsWith('EXCEPTION:'));
check('没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
if (exceptions.length) {
  console.log('\n完整异常信息（含堆栈）：');
  for (const line of cdp.console) console.log('  · ' + line);
}

if (process.env.GOTOFISH_SCREENSHOT) {
  const out = path.resolve(process.env.GOTOFISH_SCREENSHOT);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`  已保存截图：${out}`);
}

const failed = checks.filter((c) => !c.ok).length;
cleanup();
await sleep(200);
console.log(
  failed === 0
    ? `\x1b[32m单文件离线版验收通过\x1b[0m：${checks.length} 项`
    : `\x1b[31m单文件离线版验收失败\x1b[0m：${failed}/${checks.length} 项`
);
process.exit(failed === 0 ? 0 : 1);
