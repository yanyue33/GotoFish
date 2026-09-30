/**
 * 极简事件总线。用于系统间解耦（钓鱼 -> 背包 -> UI/统计/音效）。
 * 刻意不引入框架：整个项目零依赖，逻辑层可在 Node 下测试。
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._map = new Map();
  }

  on(type, fn) {
    let set = this._map.get(type);
    if (!set) {
      set = new Set();
      this._map.set(type, set);
    }
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  off(type, fn) {
    const set = this._map.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this._map.get(type);
    if (!set || set.size === 0) return;
    // 复制一份，允许回调内部增删监听
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[emitter] 事件 ${type} 的处理器抛错：`, err);
      }
    }
  }

  clear() {
    this._map.clear();
  }
}
