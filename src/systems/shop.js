/**
 * 商店系统（纯逻辑）。
 *
 * 策划设定：
 * - 商店老板 NPC 卖钓竿和鱼饵；商品是直接摆在外面架子上的，交互就能花钱买。
 * - 手持物品和老板交互可以把东西卖给他（鱼、海产、钓竿都能卖）。
 * - 背包扩容也在他这儿办。
 */

import { Emitter } from '../core/emitter.js';
import {
  RODS, ROD_BY_ID, BAITS, SLOT_UPGRADE_PRICES, BASE_SLOTS, MAX_SLOTS,
  sellPrice, itemValue, itemName, kindOf, speciesOf, makeBait, makeRod,
} from '../data/items.js';

export class ShopSystem extends Emitter {
  constructor(state) {
    super();
    this.state = state;
  }

  /* ------------------------------------------------------------------ *
   * 购买
   * ------------------------------------------------------------------ */

  /** 货架：钓竿 + 鱼饵 + 背包扩容 */
  catalog() {
    const list = [];
    for (const r of RODS) {
      const owned = this._ownsRod(r.id);
      list.push({
        key: `rod:${r.id}`,
        kind: 'rod',
        id: r.id,
        name: r.name,
        tier: r.tier,
        price: r.price,
        desc: r.desc,
        owned,
        affordable: this.state.canAfford(r.price),
        color: r.color,
        accent: r.accent,
        stats: { power: r.power, lineStr: r.lineStr, rare: r.rareBonus },
      });
    }
    for (const b of BAITS) {
      const bundle = b.tier <= 2 ? 10 : b.tier <= 4 ? 5 : 3;
      const price = b.price * bundle;
      list.push({
        key: `bait:${b.id}`,
        kind: 'bait',
        id: b.id,
        name: b.name,
        tier: b.tier,
        bundle,
        price,
        desc: b.desc,
        affordable: this.state.canAfford(price),
        color: b.color,
      });
    }
    const inv = this.state.inventory;
    if (inv.slots < MAX_SLOTS) {
      const price = inv.nextSlotPrice;
      list.push({
        key: 'upgrade:slot',
        kind: 'upgrade',
        id: 'slot',
        name: `背包扩容（${inv.slots} → ${inv.slots + 1} 格）`,
        price,
        desc: '多一格就能多带一条鱼，也能多捡几件海产。',
        affordable: this.state.canAfford(price),
        color: '#d9b45a',
      });
    } else {
      list.push({
        key: 'upgrade:slot',
        kind: 'upgrade',
        id: 'slot',
        name: '背包已满级（9 格）',
        price: null,
        desc: '已经是最大的背包了。',
        affordable: false,
        soldOut: true,
        color: '#8a8a8a',
      });
    }
    return list;
  }

  _ownsRod(rodId) {
    const inv = this.state.inventory;
    if (inv.items.some((it) => it && it.kind === 'rod' && it.speciesId === rodId)) return true;
    return this.state.groundItems.some((g) => g.item.kind === 'rod' && g.item.speciesId === rodId);
  }

  /**
   * 买一件商品。
   * @returns {{ok:boolean, reason?:string, item?:object, price?:number}}
   */
  buy(key) {
    const entry = this.catalog().find((e) => e.key === key);
    if (!entry) return { ok: false, reason: 'no_such_item' };
    if (entry.soldOut) return { ok: false, reason: 'sold_out' };
    if (entry.owned) {
      this.emit('toast', { text: '这根竿你已经有了', kind: 'warn' });
      return { ok: false, reason: 'sold_out' };
    }
    if (!this.state.canAfford(entry.price)) {
      this.emit('toast', { text: '钱不够', kind: 'warn' });
      return { ok: false, reason: 'no_money' };
    }

    // 背包空间检查
    if (entry.kind === 'rod' || entry.kind === 'bait') {
      const probe = entry.kind === 'rod' ? makeRod(entry.id) : makeBait(entry.id, entry.bundle);
      if (!this.state.inventory.hasRoomFor(probe)) {
        this.emit('toast', { text: '背包满了', kind: 'warn' });
        return { ok: false, reason: 'no_space' };
      }
    }

    if (!this.state.spend(entry.price, `buy:${key}`)) return { ok: false, reason: 'no_money' };

    if (entry.kind === 'rod') {
      const rod = makeRod(entry.id);
      this.state.give(rod);
      this.emit('toast', { text: `买下了 ${entry.name}`, kind: 'good' });
      this.emit('shop:bought', { entry, item: rod });
      return { ok: true, item: rod, price: entry.price };
    }
    if (entry.kind === 'bait') {
      const bait = makeBait(entry.id, entry.bundle);
      this.state.give(bait);
      this.emit('toast', { text: `买下 ${entry.name} ×${entry.bundle}`, kind: 'good' });
      this.emit('shop:bought', { entry, item: bait });
      return { ok: true, item: bait, price: entry.price };
    }
    if (entry.kind === 'upgrade') {
      const inv = this.state.inventory;
      inv.expand();
      this.emit('toast', { text: `背包扩容到 ${inv.slots} 格`, kind: 'good' });
      this.emit('shop:bought', { entry, item: null });
      this.emit('state:changed', null);
      return { ok: true, item: null, price: entry.price };
    }
    return { ok: false, reason: 'unknown' };
  }

  /* ------------------------------------------------------------------ *
   * 卖出
   * ------------------------------------------------------------------ */

  /** 卖出手持物品（或指定格） */
  sellSlot(slot = this.state.inventory.hand) {
    const inv = this.state.inventory;
    const item = inv.items[slot];
    if (!item) return { ok: false, reason: 'empty' };
    return this.sellItem(item, slot);
  }

  sellItem(item, slot = null) {
    const inv = this.state.inventory;
    const price = sellPrice(item);
    const name = itemName(item);
    if (slot === null) slot = inv.indexOfUid(item.uid);
    if (slot < 0) return { ok: false, reason: 'not_found' };
    inv.takeAt(slot);
    this.state.addMoney(price);
    if (kindOf(item) === 'fish' || kindOf(item) === 'cooked') this.state.stats.fishSold += 1;
    this.emit('trade:sold', { item, price });
    this.emit('toast', { text: `卖出 ${name} +§${price}`, kind: 'good' });
    this.emit('state:changed', null);
    return { ok: true, price, item };
  }

  /** 卖出背包里所有东西（一键清空，方便） */
  sellAll() {
    const inv = this.state.inventory;
    const results = [];
    for (let i = 0; i < inv.slots; i++) {
      const it = inv.items[i];
      if (it) results.push(this.sellItem(it, i));
    }
    const total = results.reduce((a, r) => a + (r.price || 0), 0);
    if (total > 0) this.emit('toast', { text: `共卖出 §${total}`, kind: 'good' });
    return { ok: results.length > 0, total, results };
  }

  /** 手持物品能卖多少钱（UI 提示用） */
  quoteHeld() {
    const item = this.state.heldItem;
    if (!item) return null;
    return { item, price: sellPrice(item), name: itemName(item), full: itemValue(item) };
  }

  /** 贵的鱼给玩家一个「要确认吗」的门槛，避免误卖传说鱼 */
  needsConfirm(item) {
    const sp = speciesOf(kindOf(item), item.speciesId);
    if (!sp) return false;
    if (sp.special) return true;
    return itemValue(item) >= 20000;
  }
}

export { SLOT_UPGRADE_PRICES, BASE_SLOTS, MAX_SLOTS };
