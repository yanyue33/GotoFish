/**
 * 烧烤系统（纯逻辑）。
 *
 * 策划设定：
 * - 需要先花钱找烧烤架 NPC 点火，点火后火会持续一段时间。
 * - 钓上来的鱼放上去烤，烤到「刚好好」价值翻倍多，继续烤会慢慢变糊，
 *   最后变成焦炭，一文不值。
 * - 核心乐趣在于「把握火候」：面板只给一个火苗粗细和颜色，不给准确秒数提示。
 */

import { Emitter } from '../core/emitter.js';
import { GRILL, cookStage, cookValueMultiplier } from '../data/fish.js';
import { kindOf, itemName, itemValue, toCooked, qualityById, speciesOf } from '../data/items.js';

export const GRILL_SLOTS = 4;

export class GrillSystem extends Emitter {
  constructor(state) {
    super();
    this.state = state;
    /** @type {Array<{item:object, t:number, done:boolean}|null>} */
    this.slots = new Array(GRILL_SLOTS).fill(null);
    /** 火是否点着（由 state.grillFuel 驱动） */
    this.lit = false;
  }

  get fuel() {
    return this.state.grillFuel;
  }

  get isLit() {
    return this.state.grillFuel > 0;
  }

  /** 点火：花钱，点燃 grillFuel 秒 */
  ignite() {
    if (this.isLit) {
      this.emit('toast', { text: '火还烧着呢', kind: 'info' });
      return { ok: false, reason: 'already_lit' };
    }
    if (!this.state.canAfford(GRILL.igniteCost)) {
      this.emit('toast', { text: `点火要 §${GRILL.igniteCost}，钱不够`, kind: 'warn' });
      return { ok: false, reason: 'no_money' };
    }
    this.state.spend(GRILL.igniteCost, 'grill:ignite');
    this.state.grillFuel = GRILL.duration;
    this.state.unlocked.grill = true;
    this.lit = true;
    this.emit('grill:ignited', { duration: GRILL.duration });
    this.emit('toast', { text: `火点着了，能烧 ${Math.round(GRILL.duration / 60)} 分钟`, kind: 'good' });
    this.emit('sound', { id: 'fire' });
    return { ok: true, duration: GRILL.duration };
  }

  /**
   * 把手持物品放上烤架。
   * 鱼、海产品、以及已经烤过的鱼都能放（烤过的再放上去就是继续烤，会越来越糊）。
   */
  putOn(slot = this.state.inventory.hand) {
    if (!this.isLit) {
      this.emit('toast', { text: '火还没点着呢，先找烧烤架点火', kind: 'warn' });
      return { ok: false, reason: 'not_lit' };
    }
    const inv = this.state.inventory;
    const item = inv.items[slot];
    if (!item) return { ok: false, reason: 'empty' };
    const kind = kindOf(item);
    if (kind !== 'fish' && kind !== 'sea' && item.kind !== 'cooked') {
      this.emit('toast', { text: '这个可烤不了', kind: 'warn' });
      return { ok: false, reason: 'not_cookable' };
    }
    const free = this.slots.indexOf(null);
    if (free < 0) {
      this.emit('toast', { text: '烤架满了', kind: 'warn' });
      return { ok: false, reason: 'grill_full' };
    }
    inv.takeAt(slot);
    // 已经烤过的继续从它的火候往下烤
    const startT = item.kind === 'cooked' ? Math.max(0, item.cookT || 0) : 0;
    const entry = {
      item: toCooked({ ...item, kind: 'fish' }, startT),
      t: startT,
      done: false,
      slot: free,
      startValue: itemValue(item),
    };
    this.slots[free] = entry;
    this.emit('grill:placed', entry);
    this.emit('state:changed', null);
    return { ok: true, entry, slot: free };
  }

  /** 把一个槽里的东西拿下来（放到背包） */
  takeOff(slotIndex) {
    const entry = this.slots[slotIndex];
    if (!entry) return { ok: false, reason: 'empty' };
    const settled = this.settle(entry);
    if (!this.state.inventory.hasRoomFor(settled)) {
      this.emit('toast', { text: '背包满了', kind: 'warn' });
      return { ok: false, reason: 'no_space' };
    }
    this.slots[slotIndex] = null;
    this.state.give(settled);
    this.emit('grill:taken', { entry, item: settled });
    this.emit('state:changed', null);
    return { ok: true, item: settled };
  }

  /** 全部取下 */
  takeAll() {
    const out = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]) out.push(this.takeOff(i));
    }
    return out;
  }

  /** 结算：把当前火候写进物品 */
  settle(entry) {
    const cooked = toCooked(entry.item, entry.t);
    return cooked;
  }

  update(dt) {
    if (!this.isLit) {
      // 火灭了：不再加热（已经烤到一半的保持现状，等下次点火继续）
      return;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const entry = this.slots[i];
      if (!entry) continue;
      entry.t += dt;
      const stage = cookStage(entry.t);
      if (entry.stageKey !== stage.key) {
        entry.stageKey = stage.key;
        this.emit('grill:stage', { entry, stage });
      }
      // 到焦炭之后不再升温（避免数值无限增长）
      if (entry.t > GRILL.maxCookTime) entry.t = GRILL.maxCookTime;
    }
  }

  /** 烤架的火力视觉强度 0..1（用于火苗大小） */
  get flamePower() {
    if (!this.isLit) return 0;
    const fuel = this.state.grillFuel / GRILL.duration;
    return 0.55 + 0.45 * Math.min(1, fuel * 3);
  }

  /**
   * 给 UI 用的槽位视图：包含火候阶段、当前价值倍率、距离焦炭还剩多久。
   */
  slotView(i) {
    const entry = this.slots[i];
    if (!entry) return null;
    const stage = cookStage(entry.t);
    const mult = cookValueMultiplier(entry.t);
    const sp = speciesOf('fish', entry.item.speciesId) || speciesOf('sea', entry.item.speciesId);
    const base = sp ? sp.value : 0;
    return {
      index: i,
      item: entry.item,
      name: itemName(toCooked(entry.item, entry.t)),
      rawName: sp ? sp.name : entry.item.speciesId,
      t: entry.t,
      stage,
      mult,
      value: Math.max(1, Math.round(itemValue(toCooked(entry.item, entry.t)))),
      quality: qualityById(entry.item.quality),
      // 距离「烤焦」还有多久，让玩家有紧迫感
      timeToBurnt: Math.max(0, GRILL.stages[4].from - entry.t),
      timeToCharcoal: Math.max(0, GRILL.stages[5].from - entry.t),
      ready: stage.key === 'ready',
      burning: entry.t >= GRILL.stages[4].from,
    };
  }

  /** 所有槽位视图 */
  views() {
    return this.slots.map((_, i) => this.slotView(i));
  }

  /** 存档序列化 */
  toJSON() {
    return this.slots.map((e) => (e ? { item: e.item, t: e.t } : null));
  }

  applySave(data) {
    if (!Array.isArray(data)) return;
    for (let i = 0; i < GRILL_SLOTS; i++) {
      const raw = data[i];
      this.slots[i] = raw && raw.item ? { item: raw.item, t: Number(raw.t) || 0, done: false } : null;
    }
  }

  clearAll() {
    const out = [];
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]) {
        out.push(this.slots[i].item);
        this.slots[i] = null;
      }
    }
    return out;
  }
}

export { GRILL, cookStage, cookValueMultiplier };
