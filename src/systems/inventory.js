/**
 * 背包系统。
 *
 * 规则（对应策划文档）：
 * - 开局只有 3 格，最大 9 格，用钱扩容。
 * - 一格一件：鱼、海产品、钓竿各占一格（不做堆叠），这样「格子限制」才有压力。
 * - 鱼饵单独一格，且可以堆叠（上限 999）。
 * - 手上的东西可以从背包里拿出来放到地上（X 键）。
 */

import { BASE_SLOTS, MAX_SLOTS, SLOT_UPGRADE_PRICES, makeBait } from '../data/items.js';

export const BAIT_CAP = 999;

export class Inventory {
  /**
   * @param {object} [init]
   * @param {number} [init.slots]      已解锁格数
   * @param {Array}  [init.items]      物品数组（可含 null 空洞）
   * @param {object|null} [init.bait]  鱼饵格
   * @param {number} [init.hand]       当前手持下标
   */
  constructor(init = {}) {
    this.slots = clampSlots(init.slots ?? BASE_SLOTS);
    /** @type {Array<object|null>} */
    this.items = new Array(this.slots).fill(null);
    if (Array.isArray(init.items)) {
      for (let i = 0; i < Math.min(init.items.length, this.slots); i++) {
        this.items[i] = init.items[i] || null;
      }
    }
    /** 鱼饵单独一格 @type {{speciesId:string,count:number}|null} */
    this.bait = init.bait ?? null;
    this.hand = Number.isInteger(init.hand) ? init.hand : 0;
    this._normalizeHand();
  }

  /* ---------------- 查询 ---------------- */

  /** 已用格数 */
  get used() {
    return this.items.filter(Boolean).length;
  }

  get free() {
    return this.slots - this.used;
  }

  get isFull() {
    return this.free <= 0;
  }

  /** 当前手持物品（越界或空格返回 null） */
  get held() {
    return this.items[this.hand] || null;
  }

  /** 手持下标（把光标所在的空格也当作手持，便于放下物品） */
  setHand(i) {
    if (!Number.isInteger(i)) return;
    this.hand = ((i % this.slots) + this.slots) % this.slots;
  }

  cycleHand(dir = 1) {
    this.hand = (((this.hand + dir) % this.slots) + this.slots) % this.slots;
  }

  /** 滚轮切换时跳过空格（可选）：找不到非空格就保持不动 */
  cycleHandSkipEmpty(dir = 1) {
    for (let step = 1; step <= this.slots; step++) {
      const i = (((this.hand + dir * step) % this.slots) + this.slots) % this.slots;
      if (this.items[i]) {
        this.hand = i;
        return;
      }
    }
  }

  _normalizeHand() {
    if (!Number.isInteger(this.hand) || this.hand < 0) this.hand = 0;
    if (this.hand >= this.slots) this.hand = this.slots - 1;
  }

  indexOfUid(uid) {
    return this.items.findIndex((it) => it && it.uid === uid);
  }

  hasRoomFor(item) {
    if (item.kind === 'bait') {
      return this.bait !== null || !this.isFull;
    }
    return !this.isFull;
  }

  /* ---------------- 增删 ---------------- */

  /**
   * 放入物品。放不下返回 false（调用方负责提示「背包满了」）。
   * @returns {{ok:boolean, reason?:string, slot?:number|'bait'}}
   */
  add(item) {
    if (!item) return { ok: false, reason: 'empty' };
    if (item.kind === 'bait') return this.addBait(item.speciesId, item.count || 1);

    // 优先填空格；如果没有空格，尝试放进当前手持格（等价于「手上拿着」）
    let slot = this.items.indexOf(null);
    if (slot < 0) {
      if (!this.items[this.hand]) slot = this.hand;
    }
    if (slot < 0) return { ok: false, reason: 'full' };
    this.items[slot] = item;
    return { ok: true, slot };
  }

  /** 鱼饵堆叠进专用格 */
  addBait(baitId, count = 1) {
    if (this.bait && this.bait.speciesId === baitId) {
      const space = BAIT_CAP - this.bait.count;
      const put = Math.min(space, count);
      this.bait.count += put;
      return put === count ? { ok: true, slot: 'bait' } : { ok: false, reason: 'bait_cap', put };
    }
    if (this.bait === null) {
      this.bait = { speciesId: baitId, count: Math.min(BAIT_CAP, count) };
      return { ok: true, slot: 'bait' };
    }
    // 鱼饵格装着别的饵：如果背包有空位，先把旧饵挪进背包
    if (!this.isFull) {
      const slot = this.items.indexOf(null);
      const old = makeBait(this.bait.speciesId, this.bait.count);
      this.items[slot] = old;
      this.bait = { speciesId: baitId, count: Math.min(BAIT_CAP, count) };
      return { ok: true, slot: 'bait', swappedOut: slot };
    }
    return { ok: false, reason: 'bait_occupied' };
  }

  /** 消耗 n 个鱼饵；不够返回 false */
  consumeBait(n = 1) {
    if (!this.bait || this.bait.count < n) return false;
    this.bait.count -= n;
    if (this.bait.count <= 0) this.bait = null;
    return true;
  }

  /** 从指定格取走物品 */
  takeAt(slot) {
    if (slot < 0 || slot >= this.slots) return null;
    const it = this.items[slot];
    if (!it) return null;
    this.items[slot] = null;
    return it;
  }

  takeUid(uid) {
    const i = this.indexOfUid(uid);
    return i < 0 ? null : this.takeAt(i);
  }

  /** 取走手持物品（X 键放下） */
  takeHeld() {
    const it = this.held;
    if (!it) return null;
    this.items[this.hand] = null;
    return it;
  }

  /* ---------------- 扩容 ---------------- */

  get nextSlotPrice() {
    if (this.slots >= MAX_SLOTS) return null;
    return SLOT_UPGRADE_PRICES[this.slots - BASE_SLOTS] ?? null;
  }

  /** 扩容（调用方负责扣钱） */
  expand() {
    if (this.slots >= MAX_SLOTS) return false;
    this.slots += 1;
    this.items.push(null);
    return true;
  }

  /** 清空所有物品，返回被清掉的东西 */
  clearAll() {
    const dropped = this.items.filter(Boolean);
    this.items = new Array(this.slots).fill(null);
    if (this.bait) {
      dropped.push(makeBait(this.bait.speciesId, this.bait.count));
      this.bait = null;
    }
    return dropped;
  }

  /* ---------------- 序列化 ---------------- */

  toJSON() {
    return {
      slots: this.slots,
      items: this.items.map((it) => (it ? it : null)),
      bait: this.bait ? { ...this.bait } : null,
      hand: this.hand,
    };
  }
}

function clampSlots(n) {
  const v = Number.isFinite(n) ? Math.round(n) : BASE_SLOTS;
  return Math.max(BASE_SLOTS, Math.min(MAX_SLOTS, v));
}
