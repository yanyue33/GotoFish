/**
 * 物品 / 数值 / 经济曲线的测试。
 * 这些是最容易在改数值时悄悄写坏的地方，所以断言写得比较细。
 */

import { describe, it, assert, equal, close, between, deepEqual } from './harness.mjs';
import {
  FISH, SEA_PRODUCTS, BAITS, QUALITIES, MAX_TIER, GRILL,
  rollQuality, rollFishInstance, rollSeaInstance, pickFish, biteWait,
  hookHoldChance, cookStage, cookValueMultiplier, qualityById, specialChance,
} from '../src/data/fish.js';
import {
  RODS, ROD_BY_ID, makeItem, makeRod, makeBait, itemValue, sellPrice, itemHunger,
  valueBreakdown, itemName, kindOf, itemTier, weightMultiplier, sizeMultiplier,
  toCooked, reviveItem, shopCatalog, SLOT_UPGRADE_PRICES, BASE_SLOTS, MAX_SLOTS,
} from '../src/data/items.js';
import { setRandomSource, makeSeededRandom } from '../src/core/rng.js';

function seed(n = 12345) {
  setRandomSource(makeSeededRandom(n));
}

describe('数据表完整性', () => {
  it('鱼 id 唯一', () => {
    const ids = FISH.map((f) => f.id);
    equal(new Set(ids).size, ids.length, '存在重复的鱼 id');
  });

  it('海产品 id 唯一', () => {
    const ids = SEA_PRODUCTS.map((s) => s.id);
    equal(new Set(ids).size, ids.length, '存在重复的海产品 id');
  });

  it('每个等级都有鱼，且都有正好一条特殊鱼', () => {
    for (let t = 1; t <= MAX_TIER; t++) {
      const list = FISH.filter((f) => f.tier === t);
      assert(list.length >= 4, `T${t} 的鱼太少了：${list.length}`);
      const specials = list.filter((f) => f.special);
      equal(specials.length, 1, `T${t} 的特殊鱼应该正好 1 种，实际 ${specials.length}`);
    }
  });

  it('特殊鱼比同等级普通鱼贵很多（至少 8 倍）', () => {
    for (let t = 1; t <= MAX_TIER; t++) {
      const list = FISH.filter((f) => f.tier === t);
      const special = list.find((f) => f.special);
      const normalMax = Math.max(...list.filter((f) => !f.special).map((f) => f.value));
      assert(
        special.value >= normalMax * 8,
        `T${t} 的特殊鱼 ${special.name}(${special.value}) 相对普通鱼上限 ${normalMax} 不够突出`
      );
    }
  });

  it('等级越高基础价值越高（同级中位数单调递增）', () => {
    const medians = [];
    for (let t = 1; t <= MAX_TIER; t++) {
      const vals = FISH.filter((f) => f.tier === t && !f.special).map((f) => f.value).sort((a, b) => a - b);
      medians.push(vals[Math.floor(vals.length / 2)]);
    }
    for (let i = 1; i < medians.length; i++) {
      assert(medians[i] > medians[i - 1], `T${i + 1} 的中位价值(${medians[i]}) 没有高于 T${i}(${medians[i - 1]})`);
    }
  });

  it('价值跨度符合策划：从几块钱到几万~十几万', () => {
    const cheapest = Math.min(...SEA_PRODUCTS.map((s) => s.value));
    between(cheapest, 1, 10, '最便宜的海产品应该在几块钱以内');
    const mostExpensive = Math.max(...FISH.map((f) => f.value));
    assert(mostExpensive >= 100000, `最贵的鱼只有 ${mostExpensive}，达不到「几万到十几万」`);
    assert(mostExpensive <= 800000, `最贵的鱼 ${mostExpensive} 数值太夸张了`);
  });

  it('鱼饵每个等级都有对应的鱼', () => {
    for (const b of BAITS) {
      assert(FISH.some((f) => f.tier === b.tier), `T${b.tier} 的鱼饵没有对应等级的鱼`);
    }
  });

  it('钓竿等级覆盖 1..6', () => {
    for (let t = 1; t <= MAX_TIER; t++) {
      equal(RODS.filter((r) => r.tier === t).length, 1, `T${t} 的钓竿不是一根`);
    }
  });

  it('商店目录里钓竿和鱼饵都能买到', () => {
    const cat = shopCatalog();
    equal(cat.filter((c) => c.type === 'rod').length, RODS.length);
    equal(cat.filter((c) => c.type === 'bait').length, BAITS.length);
  });

  it('钥匙不再使用的字段没有漏（avgKg/avgCm/color 都在）', () => {
    for (const f of FISH) {
      assert(f.avgKg > 0, `${f.name} 缺 avgKg`);
      assert(f.avgCm > 0, `${f.name} 缺 avgCm`);
      assert(typeof f.color === 'string' && f.color.startsWith('#'), `${f.name} 缺颜色`);
      assert(typeof f.desc === 'string' && f.desc.length > 3, `${f.name} 缺描述`);
    }
    for (const s of SEA_PRODUCTS) {
      assert(s.avgKg > 0 && s.avgCm > 0, `${s.name} 缺尺寸数据`);
      assert(typeof s.shape === 'string', `${s.name} 缺 shape`);
    }
  });
});

describe('品质系统', () => {
  it('低级竿钓不出传说品质', () => {
    seed(999);
    for (let i = 0; i < 3000; i++) {
      const q = rollQuality(1);
      assert(q.id <= 2, `1 级竿不该出 ${q.name}`);
    }
  });

  it('满级竿能出传说，且概率不高', () => {
    seed(4242);
    let legendary = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      if (rollQuality(6).id === 4) legendary += 1;
    }
    const rate = legendary / N;
    between(rate, 0.02, 0.12, '传说品质概率应该是个小概率');
  });

  it('品质权重合理解：等级越高平均品质越好', () => {
    seed(7);
    const avg = (rodTier) => {
      seed(7);
      let sum = 0;
      for (let i = 0; i < 4000; i++) sum += rollQuality(rodTier).id;
      return sum / 4000;
    };
    const a1 = avg(1);
    const a3 = avg(3);
    const a6 = avg(6);
    assert(a1 < a3 && a3 < a6, `平均品质没有随竿升级：${a1}, ${a3}, ${a6}`);
  });

  it('品质倍率单调递增', () => {
    for (let i = 1; i < QUALITIES.length; i++) {
      assert(QUALITIES[i].multiplier > QUALITIES[i - 1].multiplier, '品质倍率必须递增');
    }
  });
});

describe('定价公式', () => {
  const bass = FISH.find((f) => f.id === 'seabass');

  it('同一条鱼：品质越高越贵', () => {
    const vals = QUALITIES.map((q) =>
      itemValue(makeItem('fish', bass.id, { quality: q.id, weightKg: bass.avgKg, lengthCm: bass.avgCm }))
    );
    for (let i = 1; i < vals.length; i++) assert(vals[i] > vals[i - 1], '品质没有提升价值');
  });

  it('同一条鱼：越重越贵，但边际递减', () => {
    const at = (w) => itemValue(makeItem('fish', bass.id, { weightKg: w, lengthCm: bass.avgCm }));
    const base = at(bass.avgKg);
    const twice = at(bass.avgKg * 2);
    const quad = at(bass.avgKg * 4);
    assert(twice > base && quad > twice, '重量应该线性以上地提升价值');
    assert(quad - twice < (twice - base) * 3.2, '重量收益应该递减，不该越往上越夸张');
  });

  it('同一条鱼：越大越贵', () => {
    const at = (l) => itemValue(makeItem('fish', bass.id, { weightKg: bass.avgKg, lengthCm: l }));
    assert(at(bass.avgCm * 1.6) > at(bass.avgCm), '尺寸没有提升价值');
    assert(at(bass.avgCm * 0.5) < at(bass.avgCm), '小尺寸应该更便宜');
  });

  it('平均属性的价值接近基础价值 × 等级系数', () => {
    const item = makeItem('fish', bass.id, { quality: 1, weightKg: bass.avgKg, lengthCm: bass.avgCm });
    const v = itemValue(item);
    const expected = bass.value * 1.0 * (1 + 0.06 * (bass.tier - 1) * (bass.tier - 1) * 0.35);
    close(v / expected, 1, 0.06, '基础价值换算偏差过大');
  });

  it('卖出价：烤到「刚好好」比生鱼值钱', () => {
    const raw = makeItem('fish', bass.id, { quality: 2, weightKg: bass.avgKg, lengthCm: bass.avgCm });
    const ready = toCooked(raw, GRILL.stages[2].from + 2);
    assert(sellPrice(ready) > sellPrice(raw) * 2, '烤好的鱼应该明显更值钱');
  });

  it('钓竿二手回收价低于购买价', () => {
    for (const r of RODS) {
      const item = makeRod(r.id);
      assert(sellPrice(item) < r.price, `${r.name} 卖回给商店不该比买入价高`);
      assert(sellPrice(item) > r.price * 0.3, `${r.name} 回收价太低，玩家会觉得亏得离谱`);
    }
  });

  it('鱼饵回收价低于购买价', () => {
    for (const b of BAITS) {
      const item = makeBait(b.id, 1);
      assert(sellPrice(item) < b.price, `${b.name} 卖回给商店不该赚钱`);
    }
  });

  it('valueBreakdown 的乘算结果等于 itemValue', () => {
    seed(31);
    for (let i = 0; i < 200; i++) {
      const sp = FISH[Math.floor(Math.random() * FISH.length)];
      const roll = rollFishInstance(sp, 3);
      const item = makeItem('fish', roll.speciesId, roll);
      const bd = valueBreakdown(item);
      const manual = bd.base * bd.quality.multiplier * Math.pow(bd.weight, 0.9 + 0.14 * (sp.tier - 1))
        * Math.pow(bd.size, 0.9 + 0.14 * (sp.tier - 1)) * bd.tierMult * bd.cook;
      close(itemValue(item), Math.max(1, Math.round(manual)), 1.001, '明细面板和实际价值对不上');
    }
  });

  it('高级鱼对属性滚动更敏感（等级系数）', () => {
    const low = FISH.find((f) => f.tier === 1 && !f.special);
    const high = FISH.find((f) => f.tier === 6 && !f.special);
    const ratio = (sp) => {
      const big = itemValue(makeItem('fish', sp.id, { quality: 1, weightKg: sp.avgKg * 2, lengthCm: sp.avgCm * 1.5 }));
      const avg = itemValue(makeItem('fish', sp.id, { quality: 1, weightKg: sp.avgKg, lengthCm: sp.avgCm }));
      return big / avg;
    };
    assert(ratio(high) > ratio(low), '高级鱼的属性收益应该更大');
  });
});

describe('实例生成', () => {
  it('重量和尺寸在合理范围内', () => {
    seed(2024);
    for (let i = 0; i < 2000; i++) {
      const sp = FISH[i % FISH.length];
      const roll = rollFishInstance(sp, 4);
      between(roll.weightKg, sp.avgKg * 0.2, sp.avgKg * 2.7, `${sp.name} 重量越界`);
      between(roll.lengthCm, sp.avgCm * 0.3, sp.avgCm * 3, `${sp.name} 尺寸越界`);
      assert(roll.quality >= 0 && roll.quality <= 4);
    }
  });

  it('海产品也能生成合法实例', () => {
    seed(5);
    for (const p of SEA_PRODUCTS) {
      const roll = rollSeaInstance(p, 1);
      assert(roll.weightKg > 0 && roll.lengthCm > 0, `${p.name} 生成异常`);
      assert(roll.speciesId === p.id);
    }
  });
});

describe('火候系统（烧烤）', () => {
  it('阶段划分符合策划描述', () => {
    equal(cookStage(0).key, 'raw');
    equal(cookStage(10).key, 'rare');
    equal(cookStage(20).key, 'ready');
    equal(cookStage(40).key, 'well');
    equal(cookStage(60).key, 'burnt');
    equal(cookStage(90).key, 'charcoal');
  });

  it('价值曲线在最佳火候处达到峰值', () => {
    let best = 0;
    let bestT = -1;
    for (let t = 0; t <= GRILL.maxCookTime; t += 0.5) {
      const v = cookValueMultiplier(t);
      if (v > best) {
        best = v;
        bestT = t;
      }
    }
    between(bestT, GRILL.stages[2].from, GRILL.stages[3].from, '峰值应该落在「刚好好」区间');
    close(best, GRILL.valueMult.ready, 0.01, '峰值倍率应该等于 ready 阶段倍率');
  });

  it('继续烤下去价值单调下降直到焦炭', () => {
    let prev = cookValueMultiplier(GRILL.stages[3].from);
    for (let t = GRILL.stages[3].from; t <= GRILL.maxCookTime; t += 1) {
      const v = cookValueMultiplier(t);
      assert(v <= prev + 1e-9, `t=${t} 时价值反而上升了（${prev} -> ${v}）`);
      prev = v;
    }
    assert(cookValueMultiplier(GRILL.maxCookTime) < 0.1, '烤成焦炭后应该几乎不值钱');
  });

  it('焦炭的价值极低但不为 0', () => {
    const fish = makeItem('fish', 'seabass', { quality: 1, weightKg: 1.4, lengthCm: 42 });
    const charcoal = toCooked(fish, 100);
    const v = itemValue(charcoal);
    assert(v >= 1, '焦炭至少还能卖 1 块');
    assert(v < itemValue(fish) * 0.15, '焦炭不该还值钱');
    assert(itemName(charcoal).includes('焦炭'), '焦炭的命名要能看出来');
  });

  it('饱食度：烤过的比生的更顶饱', () => {
    const fish = makeItem('fish', 'seabass', { quality: 1 });
    const ready = toCooked(fish, 22);
    const charcoal = toCooked(fish, 95);
    assert(itemHunger(ready) > itemHunger(fish), '烤好应该更顶饱');
    assert(itemHunger(charcoal) < itemHunger(ready), '焦炭不该顶饱');
  });

  it('海产品的饱食度随等级提升（对应策划）', () => {
    const h = (id) => itemHunger(makeItem('sea', id));
    assert(h('seaweed') < h('conch'), '2 级海产品要比 1 级顶饱');
    assert(h('conch') < h('abalone'), '3 级要比 2 级顶饱');
    assert(h('abalone') < h('pearl'), '5 级珍珠最顶饱');
  });
});

describe('咬钩与上鱼概率模型', () => {
  it('饵等级不够时，高等级鱼权重被压低（但不是完全没有）', () => {
    seed(11);
    // 用满级竿 + 1 级饵去抽，应该绝大多数是低等级鱼
    let highTier = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const f = pickFish({ maxTier: 6, baitTier: 1, spotTier: 1 });
      if (f.tier >= 5) highTier += 1;
    }
    const rate = highTier / N;
    assert(rate < 0.05, `1 级饵不该轻易钓到 5 级以上（实际 ${(rate * 100).toFixed(2)}%）`);
  });

  it('饵等级越高，能钓到的鱼平均等级越高', () => {
    const avgTier = (baitTier) => {
      seed(88);
      let sum = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) sum += pickFish({ maxTier: 6, baitTier, spotTier: 1 }).tier;
      return sum / N;
    };
    const a = avgTier(1);
    const b = avgTier(4);
    const c = avgTier(6);
    assert(a < b && b < c, `饵等级没有拉开平均鱼等级：${a}, ${b}, ${c}`);
  });

  it('maxTier 限制生效：低级竿钓不到高级鱼', () => {
    seed(3);
    for (let i = 0; i < 2000; i++) {
      const f = pickFish({ maxTier: 1, baitTier: 6, spotTier: 1 });
      assert(f.tier === 1, `maxTier=1 时抽到了 T${f.tier} 的 ${f.name}`);
    }
  });

  it('特殊鱼确实稀有（满级配置下也低于 2%）', () => {
    seed(1717);
    let special = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) {
      if (pickFish({ maxTier: 6, baitTier: 6, spotTier: 3 }).special) special += 1;
    }
    const rate = special / N;
    assert(rate < 0.02, `特殊鱼出现率 ${(rate * 100).toFixed(2)}% 太高了`);
    assert(rate > 0.0002, `特殊鱼出现率 ${(rate * 100).toFixed(3)}% 太低了，玩家一辈子钓不到`);
  });

  it('低级配置几乎钓不到特殊鱼', () => {
    seed(3131);
    let special = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      if (pickFish({ maxTier: 1, baitTier: 1, spotTier: 1 }).special) special += 1;
    }
    assert(special / N < 0.004, `1 级配置下特殊鱼不该常见（实际 ${special}/${N}）`);
  });

  it('等待时间：饵越高级越快，等级差越大越慢', () => {
    seed(55);
    const avg = (opts) => {
      seed(55);
      let s = 0;
      for (let i = 0; i < 3000; i++) s += biteWait(opts);
      return s / 3000;
    };
    const slow = avg({ rodTier: 1, baitTier: 1, targetTier: 1, depth: 1 });
    const fast = avg({ rodTier: 6, baitTier: 6, targetTier: 1, depth: 1 });
    assert(fast < slow, '好竿好饵应该更快咬钩');
    const gap = avg({ rodTier: 6, baitTier: 1, targetTier: 6, depth: 3 });
    assert(gap > fast, '等级差 + 深水应该更慢');
  });

  it('收线保钩率随竿等级提升', () => {
    assert(hookHoldChance({ rodTier: 6, quality: 1, fishSpeed: 1 }) > hookHoldChance({ rodTier: 1, quality: 1, fishSpeed: 1 }));
    assert(hookHoldChance({ rodTier: 3, quality: 1, fishSpeed: 2 }) < hookHoldChance({ rodTier: 3, quality: 1, fishSpeed: 0.6 }));
  });

  it('specialChance 单调随配置提升', () => {
    const a = specialChance({ rodTier: 1, baitTier: 1 });
    const b = specialChance({ rodTier: 6, baitTier: 6 });
    assert(b > a * 3, '满配的稀有概率应该明显更高');
    assert(b > 0.005 && b < 0.25, `满配稀有概率 ${b} 落在不合理的区间`);
  });
});

describe('物品结构', () => {
  it('kindOf 负责把「鱼池里的鱼」归一到鱼，烤鱼保持自己的 kind', () => {
    const cooked = toCooked(makeItem('fish', 'tuna'), 20);
    equal(cooked.kind, 'cooked', '烤鱼保留 cooked 语义（火候倍率靠它）');
    equal(kindOf(cooked), 'cooked');
    equal(kindOf({ kind: 'pond', speciesId: 'tuna' }), 'fish', '鱼池里的鱼要按鱼处理');
    equal(itemTier(cooked), 3);
  });

  it('reviveItem 能丢掉坏数据而不是崩掉', () => {
    equal(reviveItem(null), null);
    equal(reviveItem({ kind: 'fish', speciesId: '不存在的鱼' }), null);
    equal(reviveItem({ kind: '乱来', speciesId: 'tuna' }), null);
    const ok = reviveItem({ kind: 'fish', speciesId: 'tuna', quality: 99, weightKg: 10, lengthCm: 100 });
    assert(ok, '合法数据应该能复活');
    equal(ok.quality, QUALITIES.length - 1, '品质要裁剪到合法范围');
  });

  it('makeRod / makeBait 生成的物品可以定价', () => {
    for (const r of RODS) {
      const item = makeRod(r.id);
      equal(kindOf(item), 'rod');
      assert(itemValue(item) > 0);
    }
    for (const b of BAITS) {
      const item = makeBait(b.id, 3);
      assert(itemValue(item) > 0);
    }
  });

  it('背包扩容价格递增，且最多到 9 格', () => {
    for (let i = 1; i < SLOT_UPGRADE_PRICES.length; i++) {
      assert(SLOT_UPGRADE_PRICES[i] > SLOT_UPGRADE_PRICES[i - 1], '扩容价格应该递增');
    }
    equal(BASE_SLOTS + SLOT_UPGRADE_PRICES.length, MAX_SLOTS, '扩容次数要正好能到 9 格');
  });
});
