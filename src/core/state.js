/**
 * 全局游戏状态：钱、饱食度、背包、鱼池、统计数据、解锁项。
 *
 * 这一层刻意不碰 DOM / three.js，便于在 Node 里做单元测试，
 * 也便于将来换渲染层。所有对外变更通过 Emitter 广播事件。
 */

import { Emitter } from '../core/emitter.js';
import { clamp, rand } from '../core/rng.js';
import { Inventory } from '../systems/inventory.js';
import {
  makeBait, makeRod, makeItem, itemValue, sellPrice, itemHunger, isEdible,
  itemName, kindOf, itemTier, ROD_BY_ID, speciesOf, MAX_SLOTS, BASE_SLOTS, reviveItem,
} from '../data/items.js';

export const SAVE_KEY = 'gotofish.save.v1';
export const SAVE_VERSION = 1;

export const HUNGER_MAX = 100;
/** 每秒钟饱食度消耗（走路） */
export const HUNGER_DRAIN_WALK = 0.30;
/** 每秒钟饱食度消耗（站着不动） */
export const HUNGER_DRAIN_IDLE = 0.12;
/** 低于该值移动变慢 */
export const HUNGER_SLOW_AT = 25;
/** 饥饿时的最低移动速度倍率 */
export const HUNGER_MIN_SPEED = 0.45;

export const POND_CAPACITY = 60;

export class GameState extends Emitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.storage = opts.storage !== undefined ? opts.storage : safeLocalStorage();
    this.seed = opts.seed || 1;

    this.reset(true);
  }

  /** 新游戏 / 重置 */
  reset(silent = false) {
    this.money = 0;
    this.hunger = HUNGER_MAX;
    this.playTime = 0;
    this.dayTime = 8 * 60; // 一天从早上 8 点开始（分钟）
    this.inventory = new Inventory({ slots: BASE_SLOTS, hand: 0 });
    /** 地上的物品 @type {Array<{uid:string,item:object,x:number,y:number,z:number}>} */
    this.groundItems = [];
    /** 鱼池里的鱼 @type {object[]} */
    this.pond = [];
    this.unlocked = { grill: false, boat: false };
    this.grillFuel = 0; // 剩余点火秒数
    /** 烤架上的东西（由 GrillSystem 维护，这里只负责存档） */
    this.grillSlots = [];
    /** 钓鱼史：每一条上钩记录 */
    this.catchLog = [];
    this.caughtSpecies = new Set();
    this.stats = freshStats();
    this.tutorialStep = 0;
    if (!silent) this.emit('state:reset', null);
    this.emit('state:changed', null);
  }

  /* ------------------------------------------------------------------ *
   * 金钱
   * ------------------------------------------------------------------ */

  addMoney(n) {
    const before = this.money;
    this.money = Math.max(0, this.money + n);
    const delta = this.money - before;
    if (delta !== 0) {
      this.stats.totalEarned += Math.max(0, delta);
      this.stats.totalSpent += Math.max(0, -delta);
      this.emit('money:changed', { delta, money: this.money });
      this.emit('state:changed', null);
    }
    return this.money;
  }

  canAfford(n) {
    return this.money >= n;
  }

  /** 花钱，成功返回 true */
  spend(n, reason = '') {
    if (!this.canAfford(n)) return false;
    this.addMoney(-n);
    this.emit('money:spent', { amount: n, reason });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 背包便捷方法
   * ------------------------------------------------------------------ */

  get inv() {
    return this.inventory;
  }

  get heldItem() {
    return this.inventory.held;
  }

  /** 拾取 / 获得物品（自动处理鱼饵） */
  give(item, opts = {}) {
    const res = this.inventory.add(item);
    if (res.ok) {
      this.emit('inventory:add', { item, slot: res.slot });
      this.emit('state:changed', null);
      if (opts.message) this.emit('toast', { text: opts.message, kind: opts.kind || 'info' });
      return true;
    }
    this.emit('toast', { text: '背包满了', kind: 'warn' });
    this.emit('inventory:full', { item });
    return false;
  }

  giveMoneyBait(baitId, count) {
    this.give(makeBait(baitId, count));
  }

  /* ------------------------------------------------------------------ *
   * 饱食度
   * ------------------------------------------------------------------ */

  /** 移动速度倍率（饿肚子会变慢） */
  get speedFactor() {
    if (this.hunger >= HUNGER_SLOW_AT) return 1;
    const t = this.hunger / HUNGER_SLOW_AT; // 0..1
    return HUNGER_MIN_SPEED + (1 - HUNGER_MIN_SPEED) * t;
  }

  get isStarving() {
    return this.hunger < HUNGER_SLOW_AT;
  }

  tickHunger(dt, moving) {
    const rate = moving ? HUNGER_DRAIN_WALK : HUNGER_DRAIN_IDLE;
    const before = this.hunger;
    this.hunger = clamp(this.hunger - rate * dt, 0, HUNGER_MAX);
    if (before >= HUNGER_SLOW_AT && this.hunger < HUNGER_SLOW_AT) {
      this.emit('hunger:starving', { hunger: this.hunger });
    }
    if (Math.abs(before - this.hunger) > 0.5) this.emit('hunger:changed', { hunger: this.hunger });
  }

  /**
   * 吃掉手持物品。返回实际回复的饱食度（0 表示没吃成）。
   */
  eatHeld() {
    const item = this.heldItem;
    if (!item || !isEdible(item)) return 0;
    const gain = itemHunger(item);
    this.inventory.takeAt(this.inventory.hand);
    const before = this.hunger;
    this.hunger = clamp(this.hunger + gain, 0, HUNGER_MAX);
    const real = Math.round(this.hunger - before);
    this.stats.foodEaten += 1;
    this.emit('player:ate', { item, gain: real });
    this.emit('toast', { text: `吃掉了${itemName(item)}，饱食度 +${real}`, kind: 'good' });
    this.emit('state:changed', null);
    return real;
  }

  /* ------------------------------------------------------------------ *
   * 世界掉落物
   * ------------------------------------------------------------------ */

  dropItem(item, pos) {
    const entry = { uid: item.uid, item, x: pos.x, y: pos.y ?? 0, z: pos.z, born: this.playTime };
    this.groundItems.push(entry);
    this.emit('ground:add', entry);
    return entry;
  }

  /** 捡起最近的地上物品 */
  pickUpNearest(pos, maxDist = 2.6) {
    let best = null;
    let bestD = maxDist;
    for (const g of this.groundItems) {
      const d = Math.hypot(g.x - pos.x, g.z - pos.z);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (!best) return null;
    if (!this.inventory.hasRoomFor(best.item)) {
      this.emit('toast', { text: '背包满了，先把东西卖掉或放下', kind: 'warn' });
      return null;
    }
    this.removeGroundItem(best.uid);
    this.give(best.item);
    this.emit('ground:pickup', best);
    return best.item;
  }

  removeGroundItem(uid) {
    const i = this.groundItems.findIndex((g) => g.uid === uid);
    if (i >= 0) {
      const [g] = this.groundItems.splice(i, 1);
      this.emit('ground:remove', g);
      return g;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 鱼池
   * ------------------------------------------------------------------ */

  /**
   * 把手持（或指定格）的鱼放进鱼池观赏。
   * 只有「鱼 / 烤鱼」可以放，海产品和鱼饵不行。
   */
  addToPond(slot = this.inventory.hand) {
    const item = this.inventory.items[slot];
    if (!item) return { ok: false, reason: 'empty' };
    const kind = kindOf(item);
    if (kind !== 'fish' && kind !== 'cooked') return { ok: false, reason: 'not_fish' };
    if (this.pond.length >= POND_CAPACITY) return { ok: false, reason: 'pond_full' };
    this.inventory.takeAt(slot);
    const sp = speciesOf(kind, item.speciesId);
    const entry = {
      uid: item.uid,
      speciesId: item.speciesId,
      name: sp ? sp.name : item.speciesId,
      tier: sp ? sp.tier : 1,
      quality: item.quality,
      weightKg: item.weightKg,
      lengthCm: item.lengthCm,
      value: itemValue(item),
      color: sp ? sp.color : '#9fb6c9',
      rod: sp ? sp.rod : 'rod',
      special: !!(sp && sp.special),
      swim: {
        angle: rand() * Math.PI * 2,
        radius: 2 + rand() * 6,
        depth: 0.5 + rand() * 1.6,
        speed: 0.25 + rand() * 0.5,
        phase: rand() * Math.PI * 2,
      },
    };
    this.pond.push(entry);
    this.stats.pondCount = this.pond.length;
    this.emit('pond:add', entry);
    this.emit('toast', { text: `${entry.name} 游进了鱼池`, kind: 'good' });
    this.emit('state:changed', null);
    return { ok: true, entry };
  }

  /** 从鱼池里把鱼拿回背包 */
  pondTake(uid) {
    const i = this.pond.findIndex((p) => p.uid === uid);
    if (i < 0) return { ok: false, reason: 'not_found' };
    const entry = this.pond[i];
    const item = makeItem('fish', entry.speciesId, {
      quality: entry.quality, weightKg: entry.weightKg, lengthCm: entry.lengthCm, uid: entry.uid,
    });
    if (!this.inventory.hasRoomFor(item)) return { ok: false, reason: 'full' };
    this.pond.splice(i, 1);
    this.give(item);
    this.emit('pond:remove', entry);
    return { ok: true, item };
  }

  /**
   * 卖出鱼池里的鱼（走商店收购价）。
   */
  pondSell(uid) {
    const i = this.pond.findIndex((p) => p.uid === uid);
    if (i < 0) return { ok: false, reason: 'not_found' };
    const entry = this.pond[i];
    const item = makeItem('fish', entry.speciesId, {
      quality: entry.quality, weightKg: entry.weightKg, lengthCm: entry.lengthCm, uid: entry.uid,
    });
    const price = sellPrice(item);
    this.pond.splice(i, 1);
    this.addMoney(price);
    this.stats.fishSold += 1;
    this.emit('pond:remove', entry);
    this.emit('trade:sold', { item, price, fromPond: true });
    this.emit('toast', { text: `卖出 ${entry.name} +§${price}`, kind: 'good' });
    return { ok: true, price };
  }

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */

  /**
   * 记录一次成功钓获（或捡到的海产品）。
   * @param {object} item
   * @param {object} meta { spot, rodId, baitId, castPower, duration }
   */
  recordCatch(item, meta = {}) {
    const kind = kindOf(item);
    const sp = speciesOf(kind, item.speciesId);
    const value = itemValue(item);
    const entry = {
      t: this.playTime,
      uid: item.uid,
      kind,
      speciesId: item.speciesId,
      name: sp ? sp.name : item.speciesId,
      tier: sp ? sp.tier : 1,
      special: !!(sp && sp.special),
      quality: item.quality,
      qualityName: ['破损', '普通', '优良', '完美', '传说'][item.quality] || '普通',
      weightKg: item.weightKg,
      lengthCm: item.lengthCm,
      value,
      spot: meta.spot || 'shore',
      rodId: meta.rodId || null,
      baitId: meta.baitId || null,
      castPower: meta.castPower ?? null,
    };
    this.catchLog.push(entry);
    if (this.catchLog.length > 500) this.catchLog.shift();

    const s = this.stats;
    if (kind === 'fish' || kind === 'cooked') {
      s.fishCaught += 1;
      if (entry.tier > s.highestTier) s.highestTier = entry.tier;
      if (entry.weightKg > s.bestWeightKg) {
        s.bestWeightKg = entry.weightKg;
        s.bestWeightName = entry.name;
      }
      if (value > s.bestValue) {
        s.bestValue = value;
        s.bestValueName = entry.name;
      }
      if (entry.special) {
        s.specialCaught += 1;
        this.emit('catch:special', entry);
      }
    } else if (kind === 'sea') {
      s.seaPicked += 1;
    }
    this.caughtSpecies.add(item.speciesId);
    s.bySpecies[item.speciesId] = (s.bySpecies[item.speciesId] || 0) + 1;
    s.byTier[entry.tier] = (s.byTier[entry.tier] || 0) + 1;
    s.totalValueCaught += value;

    this.emit('catch:recorded', entry);
    this.emit('state:changed', null);
    return entry;
  }

  /** 统计面板用的汇总 */
  summary() {
    const s = this.stats;
    const sold = this.stats.fishSold;
    const avgValue = this.catchLog.length
      ? this.catchLog.reduce((a, e) => a + e.value, 0) / this.catchLog.length
      : 0;
    return {
      ...s,
      playTime: this.playTime,
      money: this.money,
      pondCount: this.pond.length,
      avgValue,
      sold,
      byTier: { ...s.byTier },
      bySpecies: { ...s.bySpecies },
      recent: this.catchLog.slice(-20).reverse(),
    };
  }

  /* ------------------------------------------------------------------ *
   * 时间
   * ------------------------------------------------------------------ */

  tickTime(dt) {
    this.playTime += dt;
    this.dayTime = (this.dayTime + dt * 1.2) % 1440;
    if (this.grillFuel > 0) this.grillFuel = Math.max(0, this.grillFuel - dt);
  }

  /** 0..1 的当天进度 */
  get dayProgress() {
    return this.dayTime / 1440;
  }

  /** 是否夜晚（用于气氛和夜间鱼） */
  get isNight() {
    return this.dayTime < 5 * 60 || this.dayTime > 19 * 60;
  }

  /* ------------------------------------------------------------------ *
   * 存档
   * ------------------------------------------------------------------ */

  toJSON() {
    return {
      version: SAVE_VERSION,
      seed: this.seed,
      money: this.money,
      hunger: this.hunger,
      playTime: this.playTime,
      dayTime: this.dayTime,
      inventory: this.inventory.toJSON(),
      groundItems: this.groundItems.map((g) => ({ uid: g.uid, item: g.item, x: g.x, y: g.y, z: g.z })),
      pond: this.pond,
      unlocked: { ...this.unlocked },
      grillFuel: this.grillFuel,
      grillSlots: this.grillSlots || [],
      caughtSpecies: [...this.caughtSpecies],
      stats: { ...this.stats, bySpecies: { ...this.stats.bySpecies }, byTier: { ...this.stats.byTier } },
      catchLog: this.catchLog.slice(-200),
      tutorialStep: this.tutorialStep,
    };
  }

  save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(this.toJSON()));
      this.emit('toast', { text: '已保存', kind: 'info' });
      return true;
    } catch (err) {
      console.warn('[state] 保存失败', err);
      this.emit('toast', { text: '保存失败（浏览器拒绝写入本地存储）', kind: 'warn' });
      return false;
    }
  }

  /** 从存档恢复；storage 为 null 时返回全新状态 */
  static load(storage, opts = {}) {
    const st = new GameState({ ...opts, storage });
    if (!storage) return st;
    let raw;
    try {
      raw = storage.getItem(SAVE_KEY);
    } catch {
      return st;
    }
    if (!raw) return st;
    try {
      const data = JSON.parse(raw);
      st.applySave(data);
      st.emit('toast', { text: '读取存档成功', kind: 'good' });
    } catch (err) {
      console.warn('[state] 存档损坏，已开新档', err);
      st.reset(true);
    }
    return st;
  }

  applySave(data) {
    if (!data || typeof data !== 'object') return false;
    this.money = Number.isFinite(data.money) ? Math.max(0, data.money) : 0;
    this.hunger = clamp(Number.isFinite(data.hunger) ? data.hunger : HUNGER_MAX, 0, HUNGER_MAX);
    this.playTime = Number.isFinite(data.playTime) ? data.playTime : 0;
    this.dayTime = Number.isFinite(data.dayTime) ? data.dayTime : 8 * 60;
    this.seed = Number.isFinite(data.seed) ? data.seed : this.seed;

    const invData = data.inventory || {};
    this.inventory = new Inventory({
      slots: invData.slots,
      items: (invData.items || []).map((it) => (it ? reviver(it) : null)),
      bait: invData.bait ? { speciesId: invData.bait.speciesId, count: invData.bait.count | 0 } : null,
      hand: invData.hand,
    });

    this.groundItems = Array.isArray(data.groundItems)
      ? data.groundItems
          .map((g) => {
            const item = reviver(g.item);
            return item ? { uid: item.uid, item, x: +g.x || 0, y: +g.y || 0, z: +g.z || 0 } : null;
          })
          .filter(Boolean)
      : [];

    this.pond = Array.isArray(data.pond) ? data.pond.filter((p) => p && p.speciesId && speciesOf('fish', p.speciesId)) : [];
    this.unlocked = { grill: false, boat: false, ...(data.unlocked || {}) };
    this.grillFuel = Number.isFinite(data.grillFuel) ? data.grillFuel : 0;
    this.grillSlots = Array.isArray(data.grillSlots) ? data.grillSlots.map((e) => (e && e.item ? { item: reviveItem(e.item) || e.item, t: Number(e.t) || 0 } : null)) : [];

    this.caughtSpecies = new Set(Array.isArray(data.caughtSpecies) ? data.caughtSpecies : []);
    this.stats = { ...freshStats(), ...(data.stats || {}) };
    this.stats.bySpecies = { ...(data.stats?.bySpecies || {}) };
    this.stats.byTier = { ...(data.stats?.byTier || {}) };
    this.catchLog = Array.isArray(data.catchLog) ? data.catchLog.slice(-500) : [];
    this.tutorialStep = data.tutorialStep | 0;

    this.emit('state:changed', null);
    return true;
  }

  /** 有存档吗 */
  static hasSave(storage) {
    if (!storage) return false;
    try {
      return !!storage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  static clearSave(storage) {
    if (!storage) return false;
    try {
      storage.removeItem(SAVE_KEY);
      return true;
    } catch {
      return false;
    }
  }
}

function freshStats() {
  return {
    fishCaught: 0,
    seaPicked: 0,
    fishSold: 0,
    foodEaten: 0,
    specialCaught: 0,
    lineBroken: 0,
    casts: 0,
    bitesMissed: 0,
    totalEarned: 0,
    totalSpent: 0,
    totalValueCaught: 0,
    highestTier: 0,
    bestWeightKg: 0,
    bestWeightName: '',
    bestValue: 0,
    bestValueName: '',
    pondCount: 0,
    bySpecies: {},
    byTier: {},
  };
}

/** 存档物品复活：逐件校验，坏数据直接丢弃而不是让整个存档崩掉 */
function reviver(raw) {
  return reviveItem(raw);
}

export function safeLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__gotofish_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export { ROD_BY_ID, MAX_SLOTS, BASE_SLOTS };
