#!/usr/bin/env node
/**
 * 把游戏打成一个可以直接发给别人的 zip（解压即玩，还是纯静态文件）。
 *
 *   node tools/build-zip.mjs
 *
 * 为什么还要有 zip 这个形态：
 *   - 单文件 HTML（tools/build-single.mjs）适合「发一个文件给朋友」；
 *   - zip 适合「放到任意静态托管 / 拷到 U 盘 / 丢进群文件」——结构清楚，
 *     别人也能看到源码，想改数值自己动手就行。
 *
 * 打进去的内容：只有运行必需的文件，不含测试、工具、截图、文档。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'build', 'gotofish');
const ZIP = path.join(ROOT, 'dist', '去钓鱼-web版.zip');

/** 运行时必需的文件（相对 ROOT） */
const FILES = [
  'index.html',
  'styles/main.css',
  'src/game.js',
  'src/core/emitter.js',
  'src/core/format.js',
  'src/core/rng.js',
  'src/core/settings.js',
  'src/core/state.js',
  'src/data/fish.js',
  'src/data/items.js',
  'src/player/controller.js',
  'src/systems/audio.js',
  'src/systems/fishing.js',
  'src/systems/grill.js',
  'src/systems/inventory.js',
  'src/systems/shop.js',
  'src/ui/icons.js',
  'src/ui/ui.js',
  'src/world/models.js',
  'src/world/world.js',
  'vendor/three.module.js',
  'vendor/LICENSE-three.txt',
  'LICENSE',
];

/** 额外放进去的「给人看」的文件 */
const EXTRAS = [
  ['README.md', '说明.md'],
  ['tools/serve.mjs', '启动本地服务器.mjs'],
];

function copyInto(relFrom, relTo) {
  const from = path.join(ROOT, relFrom);
  const to = path.join(STAGE, relTo);
  if (!fs.existsSync(from)) throw new Error(`缺少文件：${relFrom}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 清空舞台
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

console.log('准备打包内容……');
for (const rel of FILES) copyInto(rel, rel);
for (const [from, to] of EXTRAS) copyInto(from, to);

// 放一份「怎么玩」的说明，免得收件人不知道怎么打开
fs.writeFileSync(
  path.join(STAGE, '怎么打开.txt'),
  [
    '去钓鱼 · 打开方式',
    '==================',
    '',
    '注意：不能直接双击本文件夹里的 index.html。',
    '      浏览器出于安全策略，不允许用 file:// 加载 ES Module（游戏代码是模块化的），',
    '      所以需要一个「小服务器」或者用单文件版。下面挑一个：',
    '',
    '方法一（最省事，给不想折腾的人）',
    '  让分享者生成「去钓鱼.html」单文件版（node tools/build-single.mjs）。',
    '  那个文件是独立的，双击就能玩，不需要任何服务器。',
    '',
    '方法二（用本文件夹）',
    '  1. 安装 Node.js 18+（https://nodejs.org/）',
    '  2. 在本文件夹里打开终端，运行：',
    '         node 启动本地服务器.mjs',
    '  3. 浏览器打开提示的地址（默认 http://127.0.0.1:5178/）',
    '',
    '方法三（扔到静态托管上，别人点链接就能玩）',
    '  把本文件夹里的所有文件上传到 GitHub Pages / Netlify / Cloudflare Pages / Vercel，',
    '  这些平台都不需要构建命令，直接当静态站点发布即可。',
    '',
    '需要什么浏览器？',
    '  Chrome / Edge / Firefox / Safari 16+，需要支持 WebGL2。',
    '',
  ].join('\n'),
  'utf8'
);

// 用系统自带能力压缩：Windows 用 Compress-Archive，其它平台用 zip 命令
fs.mkdirSync(path.dirname(ZIP), { recursive: true });
fs.rmSync(ZIP, { force: true });

const isWin = process.platform === 'win32';
console.log(`压缩中（${isWin ? 'Compress-Archive' : 'zip'}）……`);
try {
  if (isWin) {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${path.join(STAGE, '*')}' -DestinationPath '${ZIP}' -Force`,
      ],
      { stdio: 'inherit' }
    );
  } else {
    execFileSync('zip', ['-r', '-q', ZIP, '.'], { cwd: STAGE, stdio: 'inherit' });
  }
} catch (err) {
  console.error('压缩失败：' + err.message);
  console.error(`不过文件已经准备好，可以直接用这个目录：${path.relative(ROOT, STAGE)}`);
  process.exit(1);
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
let total = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(STAGE);

console.log('\nzip 打包完成：');
console.log(`  输出      ${path.relative(ROOT, ZIP)}（${kb(fs.statSync(ZIP).size)}）`);
console.log(`  解压后    ${kb(total)}，${FILES.length + EXTRAS.length + 1} 个文件`);
console.log('\n注意：解压后**不能**直接双击 index.html（浏览器不允许 file:// 加载模块）。');
console.log('     要么用 tools/build-single.mjs 生成单文件版，');
console.log('     要么解压后运行「启动本地服务器.mjs」，要么把内容传到静态托管上。');
