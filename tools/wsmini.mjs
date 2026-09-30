/**
 * 极简 WebSocket 客户端 + Chrome DevTools Protocol 客户端（零依赖）。
 *
 * 为什么自己写：这个项目坚持零依赖，连测试工具也不引第三方包。
 * CDP 本质就是 JSON over WebSocket，握手 + 掩码帧几十行就够了。
 * tools/e2e.mjs 和 tools/smoke-boot.mjs 都用它。
 */

import net from 'node:net';
import crypto from 'node:crypto';

/** 建立 WebSocket 连接（RFC 6455 的最小子集：文本帧 / 关闭 / ping） */
export function connect(wsUrl, timeoutMs = 8000) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname);
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n')
      );
    });
    let headerBuf = Buffer.alloc(0);
    const onData = (d) => {
      headerBuf = Buffer.concat([headerBuf, d]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = headerBuf.slice(0, idx).toString('latin1');
      if (!/HTTP\/1\.1 101/.test(head)) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('WebSocket 握手失败：' + head.split('\r\n')[0]));
        return;
      }
      socket.removeListener('data', onData);
      clearTimeout(timer);
      const rest = headerBuf.slice(idx + 4);
      const ws = new MiniWS(socket);
      if (rest.length) {
        ws._buffer = rest;
        ws._drain();
      }
      resolve(ws);
    };
    socket.on('data', onData);
  });
}

export class MiniWS {
  constructor(socket) {
    this.socket = socket;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this.onmessage = () => {};
    this.onclose = () => {};
    /** 非应答消息（CDP 事件）会走这里 */
    this.onEvent = null;
    socket.on('data', (d) => {
      this._buffer = Buffer.concat([this._buffer, d]);
      this._drain();
    });
    socket.on('close', () => this.onclose());
    socket.on('error', () => this.onclose());
  }

  _drain() {
    for (;;) {
      const buf = this._buffer;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const b1 = buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      let payload = buf.subarray(offset, offset + len);
      this._buffer = buf.subarray(offset + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      this._fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this._fragments).toString('utf8');
        this._fragments = [];
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        this.onmessage(msg);
      }
    }
  }

  _frame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const mask = crypto.randomBytes(4);
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(obj) {
    this._frame(0x1, JSON.stringify(obj));
  }

  close() {
    try {
      this._frame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.onclose();
  }
}

/** Chrome DevTools Protocol 客户端：send(method, params) / eval(expression) */
export class CDP {
  constructor(ws, opts = {}) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    /** 收集页面控制台与异常，便于诊断 */
    this.console = [];
    this.onEventCallback = opts.onEvent || null;
    ws.onmessage = (msg) => {
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        const desc = d?.exception?.description || d?.text || 'unknown';
        const where = d?.url ? ` @${d.url}` : '';
        const line = d?.lineNumber !== undefined ? ` (line ${d.lineNumber + 1})` : '';
        this.console.push(`EXCEPTION: ${desc}${line}${where}`);
        if (d?.stackTrace?.callFrames?.length) {
          this.console.push(
            '  stack: ' +
              d.stackTrace.callFrames
                .slice(0, 6)
                .map((f) => `${f.functionName || '<top>'}@${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`)
                .join(' <- ')
          );
        }
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params?.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.console.push(`${msg.params?.type}: ${text}`);
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params?.entry;
        this.console.push(`${e?.level}: ${e?.text}${e?.url ? ' @' + e.url : ''}`);
      }
      this.onEventCallback?.(msg);
    };
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send({ id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, timeoutMs);
    });
  }

  /** 在页面里求值，返回 JSON 化后的值 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (res.exceptionDetails) {
      throw new Error(
        '页面内求值抛错：' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails)
      );
    }
    return res.result?.value;
  }

  /** 求值一个返回 Promise 的表达式并等它完成（用 awaitPromise） */
  async evalAsync(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        '页面内异步求值抛错：' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails)
      );
    }
    return res.result?.value;
  }
}
