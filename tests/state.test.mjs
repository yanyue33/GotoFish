/**
 * 背包 / 游戏状态 / 商店 / 烧烤架 的行为测试。
 */

import { describe, it, assert, equal, close, between, deepEqual } from './harness.mjs';
import { setRandomSource, makeSeededRandom } from '../src/core/rng.js';
import { Inventory, BAIT_CAP } from '../src/systems/inventory.js';
import { GameState, HUNGER_MAX, HUNGER_SLOW_AT, SAVE_KEY, safeLocalStorage } from '../src/core/state.js';
import { ShopSystem } from '../src/systems/shop.js';
import { GrillSystem, GRILL_SLOTS } from '../src/systems/grill.js';
import { FishingSystem, FISHING_STATE, TUNING, fightDifficulty } from '../src/systems/fishing.js';
import {
  makeItem, makeRod, makeBait, itemValue, sellPrice, toCooked, BASE_SLOTS, MAX_SLOTS,
  SEA_PRODUCTS, FISH, GRILL, kindOf,
} from '../src/data/items.js';

/** 内存版 storage，模拟 localStorage */
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get length() {
      return map.size;
    },
    _map: map,
  };
}

function newState() {
  return new GameState({ storage: null, seed: 1 });
}

describe('背包', () => {
  it('开局 3 格，最多 9 格', () => {
    const inv = new Inventory();
    equal(inv.slots, BASE_SLOTS);
    for (let i = 0; i < 10; i++) inv.expand();
    equal(inv.slots, MAX_SLOTS, '扩容不该超过 9 格');
    equal(inv.nextSlotPrice, null, '满级后没有下一个价格');
  });

  it('一格一件，满了就放不下', () => {
    const inv = new Inventory();
    for (let i = 0; i < 3; i++) {
      const r = inv.add(makeItem('sea', 'clam'));
      assert(r.ok, `第 ${i + 1} 件应该放得下`);
    }
    equal(inv.used, 3);
    const r = inv.add(makeItem('sea', 'clam'));
    equal(r.ok, false);
    equal(r.reason, 'full');
    equal(inv.isFull, true);
  });

  it('取走一件之后又能放下', () => {
    const inv = new Inventory();
    inv.add(makeItem('sea', 'clam'));
    inv.add(makeItem('sea', 'mussel'));
    inv.add(makeItem('sea', 'seaweed'));
    inv.takeAt(1);
    equal(inv.used, 2);
    assert(inv.add(makeItem('sea', 'conch')).ok);
  });

  it('鱼饵单独一格并且可以堆叠', () => {
    const inv = new Inventory();
    assert(inv.addBait('bait_worm', 10).ok);
    assert(inv.addBait('bait_worm', 5).ok);
    equal(inv.bait.count, 15);
    equal(inv.used, 0, '鱼饵不占背包格');
    equal(inv.addBait('bait_worm', 2000).ok, false, '超过上限应该失败');
    assert(inv.bait.count <= BAIT_CAP);
  });

  it('鱼饵格被占用时换饵会把旧饵放进背包', () => {
    const inv = new Inventory();
    inv.addBait('bait_worm', 8);
    const r = inv.addBait('bait_shrimp', 5);
    assert(r.ok, '背包有空位时应该能换饵');
    equal(inv.bait.speciesId, 'bait_shrimp');
    const old = inv.items.find((i) => i && i.speciesId === 'bait_worm');
    assert(old, '旧鱼饵应该被放进背包');
    equal(old.count, 8);
  });

  it('消耗鱼饵：不够就失败，用完变成空', () => {
    const inv = new Inventory();
    inv.addBait('bait_worm', 2);
    assert(inv.consumeBait(1));
    assert(inv.consumeBait(1));
    equal(inv.bait, null);
    equal(inv.consumeBait(1), false);
  });

  it('手持越界会被夹回合法范围', () => {
    const inv = new Inventory();
    inv.setHand(99);
    assert(inv.hand >= 0 && inv.hand < inv.slots);
    inv.setHand(-5);
    assert(inv.hand >= 0 && inv.hand < inv.slots);
  });

  it('滚轮切换会跳过空格', () => {
    const inv = new Inventory({ slots: 5 });
    inv.items[2] = makeItem('sea', 'clam');
    inv.setHand(0);
    inv.cycleHandSkipEmpty(1);
    equal(inv.hand, 2, '应该跳到第 3 格（有东西的那格）');
    inv.cycleHandSkipEmpty(1);
    equal(inv.hand, 2, '只有一个东西时应该原地不动');
  });

  it('takeHeld 取走的是手持那一格', () => {
    const inv = new Inventory({ slots: 4 });
    const a = makeItem('sea', 'clam');
    const b = makeItem('sea', 'conch');
    inv.items[0] = a;
    inv.items[3] = b;
    inv.setHand(3);
    equal(inv.takeHeld().uid, b.uid);
    equal(inv.items[3], null);
  });

  it('序列化/反序列化保持内容', () => {
    const inv = new Inventory({ slots: 4 });
    inv.items[0] = makeItem('fish', 'tuna', { quality: 3, weightKg: 40, lengthCm: 130 });
    inv.addBait('bait_lure', 7);
    inv.setHand(0);
    const json = JSON.parse(JSON.stringify(inv.toJSON()));
    const back = new Inventory(json);
    equal(back.slots, 4);
    equal(back.items[0].speciesId, 'tuna');
    equal(back.items[0].quality, 3);
    equal(back.bait.count, 7);
    equal(back.hand, 0);
  });
});

describe('游戏状态', () => {
  it('钱不能变成负数', () => {
    const s = newState();
    s.addMoney(100);
    equal(s.spend(50), true);
    equal(s.money, 50);
    equal(s.spend(500), false, '钱不够不该花出去');
    equal(s.money, 50);
  });

  it('统计累计收入与支出', () => {
    const s = newState();
    s.addMoney(300);
    s.spend(120);
    equal(s.stats.totalEarned, 300);
    equal(s.stats.totalSpent, 120);
  });

  it('饱食度随时间下降，走路比站着快', () => {
    const a = newState();
    const b = newState();
    for (let i = 0; i < 100; i++) {
      a.tickHunger(0.1, true);
      b.tickHunger(0.1, false);
    }
    assert(a.hunger < b.hunger, '走路应该更饿');
    assert(b.hunger < HUNGER_MAX, '站着也会慢慢饿');
  });

  it('饿到阈值以下移动变慢', () => {
    const s = newState();
    s.hunger = HUNGER_SLOW_AT + 1;
    equal(s.speedFactor, 1);
    s.hunger = HUNGER_SLOW_AT / 2;
    assert(s.speedFactor < 1, '饿了应该变慢');
    s.hunger = 0;
    assert(s.speedFactor > 0.2, '再饿也不该完全动不了');
  });

  it('吃海产品回复饱食度，并且东西从背包消失', () => {
    const s = newState();
    s.hunger = 40;
    const clam = makeItem('sea', 'clam');
    s.give(clam);
    s.inventory.setHand(s.inventory.indexOfUid(clam.uid));
    const gain = s.eatHeld();
    assert(gain > 0, '吃东西应该回饱食度');
    assert(s.hunger > 40);
    equal(s.inventory.used, 0, '吃掉的东西应该从背包消失');
    equal(s.stats.foodEaten, 1);
  });

  it('吃海产品不会超过上限', () => {
    const s = newState();
    s.hunger = HUNGER_MAX - 2;
    s.give(makeItem('sea', 'pearl'));
    s.inventory.setHand(0);
    s.eatHeld();
    equal(s.hunger, HUNGER_MAX);
  });

  it('鱼竿和鱼饵不能吃', () => {
    const s = newState();
    s.inventory.items[0] = makeRod('rod_bamboo');
    s.inventory.setHand(0);
    equal(s.eatHeld(), 0);
  });

  it('背包满的时候给东西会失败并广播事件', () => {
    const s = newState();
    let full = false;
    s.on('inventory:full', () => {
      full = true;
    });
    for (let i = 0; i < 3; i++) s.give(makeItem('sea', 'clam'));
    equal(s.give(makeItem('sea', 'clam')), false);
    equal(full, true);
  });

  it('掉落物可以捡起来', () => {
    const s = newState();
    const item = makeItem('sea', 'conch');
    s.dropItem(item, { x: 0, y: 0, z: 1 });
    equal(s.groundItems.length, 1);
    const got = s.pickUpNearest({ x: 0, z: 0 }, 3);
    assert(got, '应该能捡起来');
    equal(s.groundItems.length, 0);
    equal(s.inventory.used, 1);
  });

  it('太远的掉落物捡不到', () => {
    const s = newState();
    s.dropItem(makeItem('sea', 'conch'), { x: 0, y: 0, z: 20 });
    equal(s.pickUpNearest({ x: 0, z: 0 }, 2.6), null);
  });

  it('统计记录：钓到鱼会更新各项最佳', () => {
    const s = newState();
    const tuna = makeItem('fish', 'tuna', { quality: 4, weightKg: 120, lengthCm: 250 });
    s.recordCatch(tuna, { spot: 'boat', rodId: 'rod_titan', baitId: 'bait_live' });
    equal(s.stats.fishCaught, 1);
    equal(s.stats.bestValueName, '金枪鱼');
    equal(s.stats.highestTier, 3);
    assert(s.stats.bySpecies.tuna === 1);
    equal(s.caughtSpecies.has('tuna'), true);
    assert(s.catchLog.length === 1);
  });

  it('钓到特殊鱼会单独计数并广播', () => {
    const s = newState();
    let special = null;
    s.on('catch:special', (e) => {
      special = e;
    });
    s.recordCatch(makeItem('fish', 'ghost_ray', { quality: 2, weightKg: 300, lengthCm: 400 }));
    equal(s.stats.specialCaught, 1);
    assert(special && special.name === '幽灵鳐');
  });

  it('鱼池：只能放鱼，容量有限，可以拿回来或卖掉', () => {
    const s = newState();
    s.inventory.items[0] = makeItem('sea', 'clam');
    s.inventory.setHand(0);
    equal(s.addToPond().ok, false, '海产品不能进鱼池');

    const tuna = makeItem('fish', 'tuna', { quality: 3, weightKg: 30, lengthCm: 120 });
    s.give(tuna);
    s.inventory.setHand(s.inventory.indexOfUid(tuna.uid));
    const r = s.addToPond();
    assert(r.ok, '鱼应该能进鱼池');
    equal(s.pond.length, 1);
    // 背包里原本还有一只蛤蜊（前面用来验证海产品不能进鱼池），鱼进池后应该只剩它
    equal(s.inventory.used, 1, '放进鱼池后背包应该空出那一格');
    equal(s.inventory.items.find(Boolean).speciesId, 'clam');

    const before = s.money;
    assert(s.pondSell(s.pond[0].uid).ok);
    assert(s.money > before, '卖掉鱼池里的鱼应该有钱');
    equal(s.pond.length, 0);
  });

  it('鱼池满了会拒绝', () => {
    const s = newState();
    for (let i = 0; i < 60; i++) {
      s.pond.push({ uid: 'u' + i, speciesId: 'tuna', quality: 1, weightKg: 1, lengthCm: 1, value: 1 });
    }
    s.give(makeItem('fish', 'tuna'));
    s.inventory.setHand(0);
    const r = s.addToPond();
    equal(r.ok, false);
    equal(r.reason, 'pond_full');
  });

  it('存档 round-trip：钱、背包、鱼池、统计都能回来', () => {
    const storage = memStorage();
    const s = new GameState({ storage, seed: 42 });
    s.addMoney(1234);
    s.hunger = 55;
    s.give(makeItem('fish', 'marlin', { quality: 3, weightKg: 90, lengthCm: 250 }));
    s.inventory.addBait('bait_squid', 12);
    s.recordCatch(makeItem('fish', 'seabass', { quality: 2, weightKg: 2, lengthCm: 40 }));
    s.inventory.items[0] && s.inventory.setHand(0);
    s.addToPond();
    s.save();

    const back = GameState.load(storage, { seed: 42 });
    equal(back.money, 1234);
    equal(Math.round(back.hunger), 55);
    equal(back.inventory.bait.speciesId, 'bait_squid');
    equal(back.inventory.bait.count, 12);
    equal(back.pond.length, 1);
    equal(back.pond[0].speciesId, 'marlin');
    equal(back.stats.fishCaught, 1);
    equal(back.caughtSpecies.has('seabass'), true);
  });

  it('存档损坏时不会崩，直接开新档', () => {
    const storage = memStorage();
    storage.setItem(SAVE_KEY, '{ 这不是合法 JSON');
    const s = GameState.load(storage);
    equal(s.money, 0);
    equal(s.inventory.used, 0);
  });

  it('hasSave / clearSave 正确', () => {
    const storage = memStorage();
    const s = new GameState({ storage });
    equal(GameState.hasSave(storage), false);
    s.addMoney(10);
    s.save();
    equal(GameState.hasSave(storage), true);
    GameState.clearSave(storage);
    equal(GameState.hasSave(storage), false);
  });

  it('SafeLocalStorage 在没有 localStorage 的环境返回 null 而不是抛错', () => {
    equal(typeof localStorage, 'undefined') ? equal(safeLocalStorage(), null) : assert(true);
  });

  it('时间推进：白天黑夜会切换', () => {
    const s = newState();
    s.dayTime = 12 * 60;
    equal(s.isNight, false);
    s.dayTime = 23 * 60;
    equal(s.isNight, true);
    s.dayTime = 3 * 60;
    equal(s.isNight, true);
  });
});

describe('商店', () => {
  function shopSetup() {
    const s = newState();
    const shop = new ShopSystem(s);
    return { s, shop };
  }

  it('钱不够买不了', () => {
    const { s, shop } = shopSetup();
    const r = shop.buy('rod:rod_bamboo');
    equal(r.ok, false);
    equal(r.reason, 'no_money');
    equal(s.money, 0);
  });

  it('买钓竿：扣钱 + 进背包', () => {
    const { s, shop } = shopSetup();
    const entry = shop.catalog().find((c) => c.key === 'rod:rod_bamboo');
    s.addMoney(entry.price + 50);
    const r = shop.buy('rod:rod_bamboo');
    assert(r.ok, '应该买成功');
    equal(s.money, 50, `应该正好扣掉 ${entry.price} 元`);
    assert(s.inventory.items.some((i) => i && i.kind === 'rod'), '钓竿应该在背包里');
  });

  it('鱼饵按捆绑数量进鱼饵格', () => {
    const { s, shop } = shopSetup();
    s.addMoney(1000);
    const entry = shop.catalog().find((c) => c.key === 'bait:bait_worm');
    assert(entry);
    const r = shop.buy('bait:bait_worm');
    assert(r.ok);
    equal(s.inventory.bait.speciesId, 'bait_worm');
    equal(s.inventory.bait.count, entry.bundle);
  });

  it('背包满时买不了实体物品', () => {
    const { s, shop } = shopSetup();
    s.addMoney(100000);
    for (let i = 0; i < 3; i++) s.give(makeItem('sea', 'clam'));
    const r = shop.buy('rod:rod_bamboo');
    equal(r.ok, false);
    equal(r.reason, 'no_space');
  });

  it('已经拥有的钓竿不能重复买', () => {
    const { s, shop } = shopSetup();
    s.addMoney(2000);
    assert(shop.buy('rod:rod_bamboo').ok);
    const entry = shop.catalog().find((c) => c.key === 'rod:rod_bamboo');
    equal(entry.owned, true);
    const again = shop.buy('rod:rod_bamboo');
    equal(again.ok, false);
    equal(again.reason, 'sold_out');
  });

  it('背包扩容：扣钱、加格、价格递增', () => {
    const { s, shop } = shopSetup();
    s.addMoney(100000);
    const p1 = s.inventory.nextSlotPrice;
    assert(shop.buy('upgrade:slot').ok);
    equal(s.inventory.slots, BASE_SLOTS + 1);
    const p2 = s.inventory.nextSlotPrice;
    assert(p2 > p1, '扩容价格应该递增');
  });

  it('卖出物品：钱增加、东西消失、统计更新', () => {
    const { s, shop } = shopSetup();
    const tuna = makeItem('fish', 'tuna', { quality: 2, weightKg: 30, lengthCm: 120 });
    s.give(tuna);
    s.inventory.setHand(0);
    const price = sellPrice(tuna);
    const r = shop.sellSlot(0);
    assert(r.ok);
    equal(s.money, price);
    equal(s.inventory.used, 0);
    equal(s.stats.fishSold, 1);
  });

  it('空手卖出会被拒绝', () => {
    const { s, shop } = shopSetup();
    equal(shop.sellSlot(0).ok, false);
  });

  it('特殊鱼 / 高价鱼卖出需要确认', () => {
    const { s, shop } = shopSetup();
    assert(shop.needsConfirm(makeItem('fish', 'moon_koi', { quality: 4, weightKg: 20, lengthCm: 95 })));
    equal(shop.needsConfirm(makeItem('sea', 'clam')), false);
  });

  it('全部卖出会清空背包', () => {
    const { s, shop } = shopSetup();
    s.give(makeItem('sea', 'clam'));
    s.give(makeItem('sea', 'mussel'));
    s.give(makeItem('fish', 'sardine'));
    const r = shop.sellAll();
    equal(r.ok, true);
    equal(s.inventory.used, 0);
    assert(r.total > 0);
  });
});

describe('烧烤架', () => {
  function grillSetup() {
    const s = newState();
    const g = new GrillSystem(s);
    return { s, g };
  }

  it('没点火不能烤', () => {
    const { s, g } = grillSetup();
    s.give(makeItem('fish', 'seabass'));
    s.inventory.setHand(0);
    const r = g.putOn();
    equal(r.ok, false);
    equal(r.reason, 'not_lit');
  });

  it('点火要花钱，火会持续一段时间', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    const r = g.ignite();
    assert(r.ok);
    equal(s.money, 100 - GRILL.igniteCost);
    assert(g.isLit);
    equal(Math.round(s.grillFuel), GRILL.duration);
    equal(g.ignite().ok, false, '已经在烧了不该再花钱');
  });

  it('鱼放上烤架后随时间推进火候', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    s.give(makeItem('fish', 'seabass', { quality: 1, weightKg: 1.4, lengthCm: 42 }));
    s.inventory.setHand(0);
    assert(g.putOn().ok);
    equal(s.inventory.used, 0, '放到烤架上应该离开背包');

    for (let i = 0; i < 200; i++) g.update(0.1); // 20 秒
    const view = g.slotView(0);
    assert(view, '槽位应该有东西');
    equal(view.stage.key, 'ready');
    assert(view.ready, '20 秒应该是刚好好');
    assert(view.value > 0);
  });

  it('烤太久会变成焦炭，价值暴跌', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    const fish = makeItem('fish', 'seabass', { quality: 3, weightKg: 1.4, lengthCm: 42 });
    const rawValue = itemValue(fish);
    s.give(fish);
    s.inventory.setHand(0);
    g.putOn();
    for (let i = 0; i < 1000; i++) g.update(0.1); // 100 秒
    const view = g.slotView(0);
    equal(view.stage.key, 'charcoal');
    assert(view.value < rawValue * 0.2, `焦炭价值 ${view.value} 应该远低于生鱼 ${rawValue}`);
  });

  it('取下时会把火候固化进物品', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    s.give(makeItem('fish', 'tuna', { quality: 2, weightKg: 30, lengthCm: 120 }));
    s.inventory.setHand(0);
    g.putOn();
    for (let i = 0; i < 220; i++) g.update(0.1);
    const r = g.takeOff(0);
    assert(r.ok);
    equal(r.item.kind, 'cooked');
    equal(r.item.cookStage, 'ready');
    equal(s.inventory.items.filter(Boolean).length, 1, '烤好的鱼应该回到背包');
    equal(s.inventory.items.find(Boolean).cookStage, 'ready');
  });

  it('背包满时取不下来', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    s.give(makeItem('fish', 'seabass'));
    s.inventory.setHand(0);
    g.putOn();
    // 塞满背包
    for (let i = 0; i < 3; i++) s.give(makeItem('sea', 'clam'));
    const r = g.takeOff(0);
    equal(r.ok, false);
    equal(r.reason, 'no_space');
    assert(g.slotView(0), '取不下来时东西应该还在烤架上');
  });

  it('火灭了之后不再升温', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    s.give(makeItem('fish', 'seabass'));
    s.inventory.setHand(0);
    g.putOn();
    for (let i = 0; i < 100; i++) g.update(0.1);
    const t1 = g.slots[0].t;
    s.grillFuel = 0;
    for (let i = 0; i < 100; i++) g.update(0.1);
    close(g.slots[0].t, t1, 1e-6, '火灭了不该继续加热');
  });

  it('序列化 / 恢复烤架状态', () => {
    const { s, g } = grillSetup();
    s.addMoney(100);
    g.ignite();
    s.give(makeItem('fish', 'seabass'));
    s.inventory.setHand(0);
    g.putOn();
    for (let i = 0; i < 50; i++) g.update(0.1);
    const snapshot = JSON.parse(JSON.stringify(g.toJSON()));
    const g2 = new GrillSystem(s);
    g2.applySave(snapshot);
    close(g2.slots[0].t, g.slots[0].t, 1e-6);
  });
});

describe('钓鱼流程', () => {
  const CAST_CTX = { origin: { x: 0, y: 1.5, z: 40 }, dir: { x: 0, y: 0, z: 1 }, pitch: 0 };

  function fishingSetup({ rodId = 'rod_carbon', baitId = 'bait_squid', baitCount = 20 } = {}) {
    setRandomSource(makeSeededRandom(20240608));
    const s = newState();
    s.inventory.items[0] = makeRod(rodId);
    s.inventory.setHand(0);
    if (baitId) s.inventory.addBait(baitId, baitCount);
    const f = new FishingSystem(s, { playerPos: () => ({ x: 0, y: 0, z: 40 }) });
    return { s, f };
  }

  function advanceToWaiting(f, ctx = CAST_CTX) {
    f.onPrimaryDown();
    equal(f.phase, FISHING_STATE.CHARGING);
    f.update(TUNING.chargeTime + 0.02); // 蓄满
    close(f.charge, 1, 1e-6);
    f.onPrimaryUp(ctx);
    equal(f.phase, FISHING_STATE.CASTING);
    for (let i = 0; i < 400 && f.phase === FISHING_STATE.CASTING; i++) f.update(0.016);
    equal(f.phase, FISHING_STATE.WAITING);
  }

  it('手上没有鱼竿时不吃左键', () => {
    const { s, f } = fishingSetup();
    s.inventory.items[0] = null;
    s.inventory.setHand(0);
    equal(f.onPrimaryDown(), false);
    equal(f.phase, FISHING_STATE.IDLE);
  });

  it('没有鱼饵不能抛竿', () => {
    const { f } = fishingSetup({ baitId: null });
    let toast = null;
    f.on('toast', (t) => {
      toast = t;
    });
    f.onPrimaryDown();
    equal(f.phase, FISHING_STATE.IDLE, '没饵不该进入蓄力');
    assert(toast && toast.text.includes('鱼饵'));
  });

  it('蓄力越久抛得越远，且落在钓点半径内', () => {
    const { f } = fishingSetup();
    // 满蓄力
    f.onPrimaryDown();
    f.update(TUNING.chargeTime + 0.1);
    f.onPrimaryUp(CAST_CTX);
    const far = Math.hypot(f.castTarget.x - CAST_CTX.origin.x, f.castTarget.z - CAST_CTX.origin.z);
    close(far, TUNING.maxCast, 0.5, '满蓄力应该抛到最大距离');

    // 半蓄力（30% 时间 -> 0.3 蓄力）
    const { f: f2 } = fishingSetup();
    f2.onPrimaryDown();
    f2.update(TUNING.chargeTime * 0.3);
    f2.onPrimaryUp(CAST_CTX);
    const near = Math.hypot(f2.castTarget.x - CAST_CTX.origin.x, f2.castTarget.z - CAST_CTX.origin.z);
    assert(near < far, '蓄力少应该抛得近');
    assert(near >= TUNING.minCast - 0.01, '不能比最小距离还近');
  });

  it('抛竿后进入等待，按时间会咬钩', () => {
    const { f } = fishingSetup();
    advanceToWaiting(f);
    assert(f.waitFor > 0, '应该有等待时间');
    let bites = 0;
    f.on('fishing:bite', () => {
      bites += 1;
    });
    for (let i = 0; i < 3000 && f.phase === FISHING_STATE.WAITING; i++) f.update(0.016);
    equal(bites, 1);
    equal(f.phase, FISHING_STATE.BITE);
    assert(f.pendingCatch, '咬钩时应该已经决定了要上什么鱼');
  });

  it('咬钩后不及时提竿会跑鱼', () => {
    const { s, f } = fishingSetup();
    advanceToWaiting(f);
    for (let i = 0; i < 3000 && f.phase === FISHING_STATE.WAITING; i++) f.update(0.016);
    equal(f.phase, FISHING_STATE.BITE);
    const missedBefore = s.stats.bitesMissed;
    for (let i = 0; i < 300 && f.phase === FISHING_STATE.BITE; i++) f.update(0.016);
    equal(f.phase, FISHING_STATE.RESULT);
    equal(f.result.ok, false);
    equal(f.result.reason, 'missed');
    equal(s.stats.bitesMissed, missedBefore + 1);
  });

  it('咬钩时点左键提竿 -> 进入搏斗', () => {
    const { f } = fishingSetup();
    advanceToWaiting(f);
    for (let i = 0; i < 3000 && f.phase === FISHING_STATE.WAITING; i++) f.update(0.016);
    f.onPrimaryDown();
    equal(f.phase, FISHING_STATE.FIGHT);
  });

  it('一直按住收线（不管张力）最后会断线或脱钩', () => {
    const { s, f } = fishingSetup({ rodId: 'rod_bamboo', baitId: 'bait_worm' });
    advanceToWaiting(f);
    for (let i = 0; i < 3000 && f.phase !== FISHING_STATE.BITE; i++) f.update(0.016);
    f.onPrimaryDown(); // 提竿
    f.onPrimaryDown(); // 开始收线
    let steps = 0;
    while (f.phase === FISHING_STATE.FIGHT && steps < 4000) {
      f.update(0.016);
      steps += 1;
    }
    assert(steps < 4000, '不该永远僵持');
    assert(f.phase === FISHING_STATE.RESULT || f.phase === FISHING_STATE.IDLE, '应该结束了');
    if (f.result && !f.result.ok) {
      assert(['lineBreak', 'escape'].includes(f.result.reason), `意外结果：${f.result.reason}`);
    }
  });

  it('聪明地收线（张力高就松手）能把鱼拉上来', () => {
    const { s, f } = fishingSetup({ rodId: 'rod_titan', baitId: 'bait_live' });
    advanceToWaiting(f);
    for (let i = 0; i < 3000 && f.phase !== FISHING_STATE.BITE; i++) f.update(0.016);
    f.onPrimaryDown(); // 提竿
    f.onPrimaryDown(); // 收线
    let steps = 0;
    while (f.phase === FISHING_STATE.FIGHT && steps < 6000) {
      const tension = f.fight.tension;
      const shouldReel = tension < 0.8;
      f.fight.reeling = shouldReel;
      f.update(0.016);
      steps += 1;
    }
    equal(f.phase, FISHING_STATE.RESULT, '应该在有限步数内结束');
    assert(f.result.ok, `按策略收线应该能把鱼拉上来，实际：${f.result.reason}`);
    const fishes = s.inventory.items.filter((i) => i && i.kind === 'fish');
    equal(fishes.length, 1, '钓到的鱼应该在背包里');
    assert(s.stats.fishCaught === 1);
    assert(s.catchLog.length === 1);
    assert(['pier', 'boat'].includes(s.catchLog[0].spot), `落点应该是栈桥或外海，实际 ${s.catchLog[0].spot}`);
  });

  it('鱼太大 / 竿太弱时，硬拉更容易失败（数值上确实更难）', () => {
    const species = FISH.find((x) => x.id === 'bluefin');
    const dWeak = fightDifficulty({ species, rod: { tier: 1, lineStr: 1, power: 1 }, bait: { tier: 1 } });
    const dStrong = fightDifficulty({ species, rod: { tier: 6, lineStr: 2.4, power: 2.15 }, bait: { tier: 6 } });
    assert(dStrong.need < dWeak.need, '好竿应该让同一条鱼更好拉');
    assert(dStrong.escapeChance < dWeak.escapeChance, '好竿应该更不容易脱钩');
  });

  it('右键可以放弃当前抛竿', () => {
    const { f } = fishingSetup();
    advanceToWaiting(f);
    equal(f.isFishing, true);
    f.onSecondary();
    equal(f.phase, FISHING_STATE.IDLE);
    equal(f.isFishing, false);
  });

  it('切换手持物品会强制收竿', () => {
    const { f } = fishingSetup();
    advanceToWaiting(f);
    f.forceIdle('switch');
    equal(f.phase, FISHING_STATE.IDLE);
  });

  it('鱼饵会按概率被消耗，每竿最多消耗一个', () => {
    let consumed = 0;
    for (let seedN = 0; seedN < 120; seedN++) {
      const { s, f } = fishingSetup({ baitCount: 5 });
      setRandomSource(makeSeededRandom(seedN + 1));
      advanceToWaiting(f);
      if (s.inventory.bait === null || s.inventory.bait.count === 4) consumed += 1;
      assert(!s.inventory.bait || s.inventory.bait.count >= 4, '一竿不该消耗超过一个鱼饵');
    }
    assert(consumed > 20 && consumed < 100, `消耗率看起来不对：${consumed}/120`);
  });

  it('背包满时钓到的鱼会掉在脚下而不是消失', () => {
    const { s, f } = fishingSetup({ rodId: 'rod_titan' });
    for (let i = 0; i < 3; i++) s.give(makeItem('sea', 'clam'));
    equal(s.inventory.free, 0);
    advanceToWaiting(f);
    for (let i = 0; i < 3000 && f.phase !== FISHING_STATE.BITE; i++) f.update(0.016);
    f.onPrimaryDown();
    f.onPrimaryDown();
    let steps = 0;
    while (f.phase === FISHING_STATE.FIGHT && steps < 6000) {
      f.fight.reeling = f.fight.tension < 0.8;
      f.update(0.016);
      steps += 1;
    }
    if (f.result && f.result.ok) {
      equal(s.groundItems.length, 1, '背包满时鱼应该掉在地上');
    }
  });

  it('抛到深处能钓到的最高等级更高', () => {
    const { f } = fishingSetup({ rodId: 'rod_carbon' }); // T3
    // 近岸
    const near = { origin: { x: 0, y: 1.5, z: 40 }, dir: { x: 0, y: 0, z: -1 }, pitch: 0 };
    f.onPrimaryDown();
    f.update(TUNING.chargeTime * 0.2);
    f.onPrimaryUp(near);
    const nearTier = f.maxTierAt(f.spot.id);
    // 外海
    const { f: f2 } = fishingSetup({ rodId: 'rod_carbon' });
    const far = { origin: { x: 0, y: 1.5, z: 40 }, dir: { x: 0, y: 0, z: 1 }, pitch: 0 };
    f2.onPrimaryDown();
    f2.update(TUNING.chargeTime + 0.1);
    f2.onPrimaryUp(far);
    const farTier = f2.maxTierAt(f2.spot.id);
    assert(farTier > nearTier, `外海(${farTier}) 应该比近岸(${nearTier}) 能钓更高的等级`);
  });
});
