#!/usr/bin/env node
/**
 * 打包成「单文件 HTML」——可以直接发给别人，双击就能玩，不需要服务器。
 *
 *   node tools/build-single.mjs                 # 输出 dist/去钓鱼.html
 *   node tools/build-single.mjs 我的版本.html    # 自定义输出文件名
 *
 * ---------------------------------------------------------------------------
 * 原理：为什么这样做，而不是引一个打包器
 * ---------------------------------------------------------------------------
 * 这个项目的源码是 ES Module。浏览器在 file:// 下会把它当成「不透明源」，
 * 模块请求会被 CORS 拦掉 —— 这就是「必须用 HTTP 打开」的原因。
 *
 * 解决办法：把每个模块的源码变成一个 **Blob URL**（与文档同源，可以互相 import），
 * 并把模块之间的 import 说明符换成对应的 Blob URL。
 *
 * 难点在于「静态 import 的说明符必须是字符串字面量，而 Blob URL 要等到运行时
 * 调用 createObjectURL 才知道」。这里的处理办法是**占位符 + 依赖序回填**：
 *
 *   1. 打包时给每个模块分配一个唯一占位符，例如 src/game.js -> "__GOF_M1__"，
 *      并把源码里 `from './core/state.js'` 换成 `from "__GOF_M5__"`（仍是字面量，合法）。
 *   2. 运行时按「依赖在前」的顺序逐个模块：先把源码里的占位符替换成**已经创建好的**
 *      依赖的 Blob URL，再对自己 createObjectURL。
 *
 * 因为顺序保证了「用到的 URL 一定已经存在」，所以整个过程不需要 import map、
 * 不需要打包器、也不会像 data URL 那样把 three.js 重复内联几十遍
 * （1.27 MB 的 three.js 在最终文件里只出现一次）。
 *
 * 生成的 HTML 末尾：
 *   1. #__gof_src__   各模块源码（JSON，含占位符）
 *   2. #__gof_boot__  上面那套「依赖序回填 + createObjectURL」
 *   3. 入口 <script type="module">，import 入口模块的 Blob URL
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/game.js';
const VENDOR = 'vendor/three.module.js';

/* ------------------------------------------------------------------ *
 * 1. 收集模块图（依赖在前）
 * ------------------------------------------------------------------ */

const IMPORT_RE = /(from\s*|import\s*)(['"])([^'"]+)\2/g;

/** 去掉行注释，避免注释里的引号干扰（和 tools/smoke.mjs 同一套思路） */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * 一个模块直接依赖了哪些模块。
 * @returns {Array<{spec:string, target:string}>} spec = 源码里写的说明符原样
 */
function depsOf(relPath, src) {
  const clean = stripLineComments(src);
  const seen = new Map();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(clean))) {
    const spec = m[3];
    let target = null;
    if (spec === 'three') target = VENDOR;
    else if (spec.startsWith('.')) {
      target = path
        .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, relPath)), spec))
        .replace(/\\/g, '/');
    }
    if (target) seen.set(spec, { spec, target });
  }
  return [...seen.values()];
}

const sources = new Map();
const order = []; // 依赖在前

function collect(relPath, stack = []) {
  if (sources.has(relPath)) return;
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`找不到模块：${relPath}`);
  const src = fs.readFileSync(abs, 'utf8');
  sources.set(relPath, src);
  if (stack.includes(relPath)) {
    throw new Error(`检测到循环依赖，无法用「依赖序回填」打包：${stack.concat(relPath).join(' -> ')}`);
  }
  for (const d of depsOf(relPath, src)) collect(d.target, stack.concat(relPath));
  order.push(relPath);
}

console.log('收集模块……');
collect(ENTRY);
console.log(`  共 ${sources.size} 个模块（含 three.js），依赖序已排好`);

/* ------------------------------------------------------------------ *
 * 2. 分配占位符并改写 import
 * ------------------------------------------------------------------ */

const slotOf = new Map(order.map((p, i) => [p, `__GOF_M${i}__`]));

function withPlaceholders(relPath, src, deps) {
  let out = src;
  for (const { spec, target } of deps) {
    const token = slotOf.get(target);
    if (!token) throw new Error(`${relPath} 依赖的 ${spec} 不在模块表里`);
    // 引号一起替换，避免误伤内容相同的普通字符串
    out = out.split(`'${spec}'`).join(`"${token}"`);
    out = out.split(`"${spec}"`).join(`"${token}"`);
  }
  return out;
}

const bundled = {}; // relPath -> 带占位符的源码
const slotTable = {}; // 占位符 -> relPath
for (const relPath of order) {
  const deps = depsOf(relPath, sources.get(relPath));
  bundled[relPath] = withPlaceholders(relPath, sources.get(relPath), deps);
  slotTable[slotOf.get(relPath)] = relPath;
}

/* ------------------------------------------------------------------ *
 * 3. 组装 index.html
 * ------------------------------------------------------------------ */

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 3a. 去掉 importmap：单文件版不再需要裸模块名映射
const beforeMap = html;
html = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '');
if (html === beforeMap) console.warn('  ! 没找到 importmap，可能 index.html 改版了');

// 3b. 外链 CSS 内联进来（单文件不能依赖旁边还有 styles/ 目录）
const cssLink = html.match(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/);
if (!cssLink) throw new Error('index.html 里找不到样式表链接');
const css = fs.readFileSync(path.join(ROOT, cssLink[1].replace(/^\.\//, '')), 'utf8');
html = html.replace(cssLink[0], `<style>\n${css}\n</style>`);

// 3c. 入口脚本：静态 import 没法用运行时算出来的 URL，所以改写成动态 import()
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('index.html 里找不到入口 module script');

const entrySlots = [];
const bodyLines = scriptMatch[1]
  .split('\n')
  .filter((line) => {
    if (!/^\s*import\s/.test(line)) return true;
    const m = line.match(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/);
    if (!m) {
      console.warn(`  ! 入口脚本里有无法改写的 import，已原样保留：${line.trim()}`);
      return true;
    }
    const names = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) {
      console.warn(`  ! 入口脚本导入了裸模块名（${spec}），单文件版不支持，已跳过`);
      return false;
    }
    const rel = path.posix.normalize(spec.replace(/^\.\//, ''));
    const slot = slotOf.get(rel);
    if (!slot) throw new Error(`入口脚本导入了未打包的模块：${rel}`);
    entrySlots.push(slot);
    return false;
  })
  .join('\n');

// 入口里的具名导入统一走动态 import（动态 import 的说明符可以是任意表达式）
const importSpecs = [...scriptMatch[1].matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm)]
  .filter((m) => m[2].startsWith('.'))
  .map((m) => {
    const rel = path.posix.normalize(m[2].replace(/^\.\//, ''));
    return `const { ${m[1].trim()} } = await import(window.__GOF_URLS__[${JSON.stringify(slotOf.get(rel))}]);`;
  });

const rewrittenEntry = `${importSpecs.join('\n')}\n${bodyLines}`;

// 3d. 注入打包数据与运行时装机器
//
// 每个模块的源码单独做 base64，而不是直接塞进 JSON 字符串：
// 源码里可能出现控制字符、U+2028、"</script" 之类会让 JSON 或 HTML 解析炸掉的内容
// （three.js 里就有）。base64 之后 payload 里只会有 ASCII 字母数字，绝对安全，
// 而且体积只比原文大 1/3，比整体 base64 更省。
const payload = JSON.stringify({
  slots: slotTable,
  modules: Object.fromEntries(
    Object.entries(bundled).map(([rel, src]) => [rel, Buffer.from(src, 'utf8').toString('base64')])
  ),
});

const injected = `
<script id="__gof_src__" type="application/octet-stream">${payload}</script>

<script id="__gof_boot__">
/* 单文件离线版运行时。
   做的事只有一件：按「依赖在前」的顺序，把每个模块的源码变成一个 Blob URL。
   因为顺序有保证，替换占位符时依赖的 URL 一定已经存在。 */
(function () {
  var DATA = JSON.parse(document.getElementById('__gof_src__').textContent);
  var TOKEN = /__GOF_M[0-9]+__/g; // 注意：这里不能用 \\d，模板字符串里会被吃掉反斜杠
  function decode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  var urls = {};
  var pending = 0;
  // 顺序 = 模块表里的插入顺序 = 打包时的依赖序（依赖一定排在使用者前面）
  Object.keys(DATA.slots).forEach(function (slot) {
    var rel = DATA.slots[slot];
    var src = decode(DATA.modules[rel]);
    src = src.replace(TOKEN, function (token) {
      var u = urls[token];
      if (!u) {
        pending += 1;
        console.error('模块顺序错误，尚未创建的模块：' + token + '（' + rel + ' 用到它）');
        return token;
      }
      return u;
    });
    urls[slot] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  });
  window.__GOF_URLS__ = urls;
  window.__GOF_PENDING__ = pending;
})();
</script>

<script>
/* file:// 下浏览器常常禁用 localStorage，先说清楚，免得玩家以为「保存了」其实没有。 */
(function () {
  if (location.protocol !== 'file:') return;
  var ok = false;
  try { localStorage.setItem('__probe__', '1'); localStorage.removeItem('__probe__'); ok = true; } catch (e) { ok = false; }
  var note = document.createElement('div');
  note.className = 'offline-note';
  note.textContent = ok
    ? '单文件离线版 · 进度保存在这个浏览器里'
    : '单文件离线版 · 此浏览器不允许本地文件存档，进度只在本次游戏内有效';
  function add() { document.body.appendChild(note); }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
</script>

<script type="module">
${rewrittenEntry.trim()}
</script>
`;

html = html.replace(scriptMatch[0], '<!-- 入口脚本在文件末尾，加载内联的 Blob URL 模块 -->');
html = html.replace('</body>', `${injected}</body>`);

/* ------------------------------------------------------------------ *
 * 4. 写出 + 报告
 * ------------------------------------------------------------------ */

const outName = process.argv[2] || '去钓鱼.html';
const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, outName);
fs.writeFileSync(outPath, html, 'utf8');

const gz = zlib.gzipSync(fs.readFileSync(outPath), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const size = fs.statSync(outPath).size;
const perModule = [...sources.entries()]
  .map(([p, s]) => [p, Buffer.byteLength(s, 'utf8')])
  .sort((a, b) => b[1] - a[1]);

console.log('\n单文件打包完成：');
console.log(`  输出      ${path.relative(ROOT, outPath)}`);
console.log(`  体积      ${kb(size)}（gzip 后 ${kb(gz)}）`);
console.log(`  模块数    ${sources.size}；入口槽位 ${entrySlots.join(', ')}`);
console.log(`  最大模块  ${perModule[0][0]}（${kb(perModule[0][1])}，在文件里只出现一次）`);
console.log('\n直接把这个文件发给别人，双击用浏览器打开即可（不需要服务器）。');
console.log('提示：收件人需要 Chrome / Edge / Firefox / Safari 16+（要支持 WebGL2）。');
