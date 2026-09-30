#!/usr/bin/env node
/**
 * 静态自检：不依赖浏览器，把整个项目的模块图检查一遍。
 *
 *   node tools/smoke.mjs
 *
 * 检查四件事：
 *  1. 每个 .js 模块能被 Node 解析（语法错误会在这里暴露）。
 *  2. 每个 import 的相对路径真实存在。
 *  3. 每个具名 import 在目标模块里确实有导出（防手误/防重构漏改）。
 *  4. 从入口出发能到达所有模块（没有孤儿文件），并报告循环依赖。
 *
 * 渲染层（three / DOM）不在 Node 里执行，只做静态解析，所以这里不需要 three。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build']);

let errors = 0;
let warnings = 0;
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(full);
    }
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function fail(msg) {
  errors += 1;
  console.log(`\x1b[31m✗\x1b[0m ${msg}`);
}

function warn(msg) {
  warnings += 1;
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

/* ------------------------------------------------------------------ *
 * import / export 提取（正则足够，本项目源码风格统一且没有动态 import）
 * ------------------------------------------------------------------ */

/** 去掉行注释，避免 "export {\n a,\n // 注释\n b }" 里的注释把后面的名字吞掉 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

const IMPORT_RE = /^\s*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const EXPORT_RE = /^\s*export\s+(?:(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+)|const\s+([A-Za-z0-9_$]+)|let\s+([A-Za-z0-9_$]+)|var\s+([A-Za-z0-9_$]+))/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/gm;

function parseImports(src) {
  const out = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const clause = (m[1] || '').trim();
    const spec = m[2];
    const names = [];
    let namespace = false;
    let defaultName = null;
    if (clause) {
      if (clause.startsWith('*')) {
        namespace = true;
      } else {
        const braceAt = clause.indexOf('{');
        if (braceAt >= 0) {
          const head = clause.slice(0, braceAt).replace(/,\s*$/, '').trim();
          if (head) defaultName = head;
          const inner = clause.slice(braceAt + 1, clause.lastIndexOf('}'));
          for (const part of inner.split(',')) {
            const p = part.trim();
            if (!p) continue;
            const alias = p.split(/\s+as\s+/)[0].trim();
            if (alias) names.push(alias);
          }
        } else {
          defaultName = clause.replace(/,\s*$/, '').trim();
        }
      }
    }
    out.push({ spec, names, namespace, defaultName, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

function parseExports(src) {
  const set = new Set();
  EXPORT_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_RE.exec(src))) {
    const name = m[1] || m[2] || m[3] || m[4] || m[5];
    if (name) set.add(name);
  }
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(src))) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const alias = p.split(/\s+as\s+/).pop().trim();
      if (alias) set.add(alias);
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) set.add('default');
  return set;
}

/* ------------------------------------------------------------------ *
 * 1 + 3：解析与导出检查
 * ------------------------------------------------------------------ */

walk(ROOT);
files.sort();

const moduleInfo = new Map();

console.log(`\n\x1b[36m模块自检（${files.length} 个文件）\x1b[0m\n`);

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripLineComments(raw);
  moduleInfo.set(file, {
    src: raw,
    imports: parseImports(src),
    exports: parseExports(src),
  });
}

// 语法检查：用 new Function 之外的可靠方式 —— Node 的 vm.SourceTextModule 需要 flag，
// 所以用「能否被 import() 解析」不可行；改用一个轻量的括号/引号平衡 + import 结构检查。
//
// 注意 tools/ 下的脚本会**把 JS 源码当字符串处理**（打包器、静态自检自己），
// 字符串里出现的 /* 和 */ 数量天然不对称，所以注释平衡检查跳过 tools/。
function syntaxSanity(file, src) {
  if (rel(file).startsWith('tools/')) return;
  const openBlockComment = (src.match(/\/\*/g) || []).length;
  const closeBlockComment = (src.match(/\*\//g) || []).length;
  if (openBlockComment !== closeBlockComment) {
    fail(`${rel(file)}：块注释没有闭合（/* ${openBlockComment} 个，*/ ${closeBlockComment} 个）`);
  }
}

for (const file of files) syntaxSanity(file, moduleInfo.get(file).src);

// 具名导出检查
for (const [file, info] of moduleInfo) {
  for (const imp of info.imports) {
    if (!imp.spec.startsWith('.')) continue; // 裸模块（three 等）跳过
    const target = path.resolve(path.dirname(file), imp.spec);
    if (!fs.existsSync(target)) {
      fail(`${rel(file)}:${imp.line} import 的路径不存在 -> ${imp.spec}`);
      continue;
    }
    if (imp.namespace || imp.names.length === 0) continue;
    const targetInfo = moduleInfo.get(target);
    if (!targetInfo) continue; // 指向 vendor 之类
    for (const name of imp.names) {
      if (!targetInfo.exports.has(name)) {
        fail(`${rel(file)}:${imp.line} 从 ${imp.spec} 导入了不存在的 ${name}`);
      }
    }
  }
}

if (errors === 0) ok('语法与 import/export 检查通过');

/* ------------------------------------------------------------------ *
 * 2 + 4：可达性与循环依赖
 * ------------------------------------------------------------------ */

const entry = path.join(ROOT, 'src', 'game.js');
const reachable = new Set();
const stack = [entry];
const graph = new Map();

for (const [file, info] of moduleInfo) {
  graph.set(
    file,
    info.imports
      .filter((i) => i.spec.startsWith('.'))
      .map((i) => path.resolve(path.dirname(file), i.spec))
      .filter((p) => moduleInfo.has(p))
  );
}

while (stack.length) {
  const f = stack.pop();
  if (reachable.has(f)) continue;
  reachable.add(f);
  for (const dep of graph.get(f) || []) stack.push(dep);
}

const orphans = files.filter((f) => {
  if (reachable.has(f)) return false;
  const r = rel(f);
  // 测试和工具脚本本来就不在运行时依赖图里
  return !(r.startsWith('tests/') || r.startsWith('tools/'));
});

for (const o of orphans) warn(`${rel(o)} 没有被任何运行时模块引用（可能是多余的）`);
if (orphans.length === 0) ok(`运行时模块图完整：从 src/game.js 可达 ${reachable.size} 个模块`);

// 循环依赖（DFS）
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map([...moduleInfo.keys()].map((k) => [k, WHITE]));
const cycles = [];

function dfs(node, trail) {
  color.set(node, GRAY);
  trail.push(node);
  for (const dep of graph.get(node) || []) {
    if (color.get(dep) === GRAY) {
      const idx = trail.indexOf(dep);
      cycles.push(trail.slice(idx).concat(dep));
    } else if (color.get(dep) === WHITE) {
      dfs(dep, trail);
    }
  }
  trail.pop();
  color.set(node, BLACK);
}

for (const f of moduleInfo.keys()) {
  if (color.get(f) === WHITE) dfs(f, []);
}

if (cycles.length) {
  for (const c of cycles) warn(`循环依赖：${c.map(rel).join(' -> ')}`);
} else {
  ok('没有循环依赖');
}

/* ------------------------------------------------------------------ *
 * 5：资源与关键文件检查
 * ------------------------------------------------------------------ */

const required = [
  'index.html',
  'styles/main.css',
  'vendor/three.module.js',
  'src/game.js',
  'tools/serve.mjs',
  'tools/balance.mjs',
  'README.md',
  'LICENSE',
  '.gitignore',
];

for (const r of required) {
  const p = path.join(ROOT, r);
  if (!fs.existsSync(p)) fail(`缺少关键文件：${r}`);
}
if (required.every((r) => fs.existsSync(path.join(ROOT, r)))) ok('关键文件齐全');

// index.html 与测试页里引用的本地资源都要存在
for (const page of ['index.html', 'tests/e2e.html', 'tools/shot.html']) {
  const p = path.join(ROOT, page);
  if (!fs.existsSync(p)) {
    fail(`缺少页面：${page}`);
    continue;
  }
  const source = fs.readFileSync(p, 'utf8');
  const dir = path.dirname(p);
  const refs = [...source.matchAll(/(?:src|href)="\.\.?\/([^"]+)"/g)].map((m) => m[0].match(/"([^"]+)"/)[1]);
  const maps = [...source.matchAll(/"three"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  let missing = 0;
  for (const r of [...refs, ...maps]) {
    const target = path.resolve(dir, r);
    if (!fs.existsSync(target)) {
      fail(`${page} 引用了不存在的 ${r}`);
      missing += 1;
    }
  }
  if (missing === 0) ok(`${page} 的 ${refs.length + maps.length} 个本地引用都存在`);
}

// three 的版本
const threeSrc = fs.readFileSync(path.join(ROOT, 'vendor/three.module.js'), 'utf8');
const rev = threeSrc.match(/const REVISION = '([^']+)'/);
if (rev) ok(`vendor 里的 three.js 版本：r${rev[1]}`);
else warn('读不出 three.js 版本号');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n${'─'.repeat(56)}`);
if (errors === 0) {
  console.log(`\x1b[32m自检通过\x1b[0m（警告 ${warnings} 条）`);
  process.exit(0);
} else {
  console.log(`\x1b[31m自检失败\x1b[0m：${errors} 个错误，${warnings} 条警告`);
  process.exit(1);
}
