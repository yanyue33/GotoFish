#!/usr/bin/env node
/**
 * 零依赖静态服务器。
 *
 * 为什么需要它：ES Module 在 file:// 下会被浏览器的 CORS 策略拦住，
 * 所以这个游戏必须用 HTTP 打开。用法：
 *
 *   node tools/serve.mjs                      # 默认 http://127.0.0.1:5178
 *   node tools/serve.mjs 8080                 # 指定端口
 *   node tools/serve.mjs 8080 0.0.0.0         # 允许局域网其它设备访问
 *
 * 想分享给同一个 Wi-Fi 下的朋友玩，就用第三个参数绑到 0.0.0.0，
 * 然后把你自己的局域网 IP 告诉他们，例如 http://192.168.1.23:8080/
 * （Windows 上用 ipconfig 看 IPv4 地址；macOS/Linux 上用 ifconfig / ip addr）。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const HOST = process.argv[3] || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  const target = path.normalize(path.join(ROOT, pathname));
  // 阻止目录穿越
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 找不到：' + pathname);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
      // WebGL / SharedArrayBuffer 之类暂时不需要特殊头
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('去钓鱼 · 本地服务器已启动');
  console.log(`  本机：   http://127.0.0.1:${PORT}/`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    if (ips.length) {
      console.log('  局域网： ' + ips.map((ip) => `http://${ip}:${PORT}/`).join('\n           '));
      console.log('  （同一个 Wi-Fi 下的手机 / 电脑直接用上面的地址就能玩）');
    }
  } else {
    console.log('  想让局域网里其它设备也能玩，用：node tools/serve.mjs 5178 0.0.0.0');
  }
  console.log(`根目录：${ROOT}`);
  console.log('按 Ctrl+C 停止。');
});
