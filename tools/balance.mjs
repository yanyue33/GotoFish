#!/usr/bin/env node
/**
 * 数值平衡模拟器。
 *
 *   node tools/balance.mjs
 *
 * 它不是测试，而是把「策划说的那条曲线」真的跑一遍，打印成表让人一眼看出
 * 钱是不是赚得太快 / 太慢、高级鱼是不是遥不可及。改数值之后跑一下就知道手感对不对。
 *
 * 模拟的是「纯钓鱼收益」，不含捡海产品和烧烤，这样是最保守的下界。
 */

import { setRandomSource, makeSeededRandom } from '../src/core/rng.js';
import {
  FISH, BAITS, MAX_TIER, pickFish, biteWait, rollFishInstance, cookValueMultiplier, GRILL,
} from '../src/data/fish.js';
import {
  RODS, FISHING_SPOTS, makeItem, itemValue, sellPrice, SLOT_UPGRADE_PRICES, BASE_SLOTS,
} from '../src/data/items.js';

const ROD_TIER = Number(process.argv[2] || 0); // 0 = 全部等级都模拟

function avg(items) {
  return items.reduce((a, b) => a + b, 0) / (items.length || 1);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 模拟「站在某个钓点、用某级竿某级饵，钓 N 次」的收益。
 */
function simulate({ rodTier, baitTier, spot, n = 4000, seed = 20240608 }) {
  setRandomSource(makeSeededRandom(seed));
  const rod = RODS.find((r) => r.tier === rodTier);
  const maxTier = Math.min(MAX_TIER, rodTier + spot.bonusTier);
  const bait = BAITS.find((b) => b.tier === baitTier);
  const values = [];
  const tiers = [];
  const waits = [];
  let specials = 0;
  const speciesCount = new Map();
  let baitUsed = 0;

  for (let i = 0; i < n; i++) {
    const species = pickFish({ maxTier, baitTier, spotTier: spot.bonusTier + 1 });
    const roll = rollFishInstance(species, rodTier);
    const item = makeItem('fish', species.id, roll);
    values.push(sellPrice(item));
    tiers.push(species.tier);
    waits.push(biteWait({ rodTier, baitTier, targetTier: species.tier, depth: spot.depth }));
    if (species.special) specials += 1;
    speciesCount.set(species.name, (speciesCount.get(species.name) || 0) + 1);
    if (Math.random() < bait.useChance) baitUsed += 1;
  }

  const top = [...speciesCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const baitPerFish = baitUsed / n;
  /** 每钓一条鱼平均花掉的鱼饵钱（bait.price 是单个价） */
  const baitCost = baitPerFish * bait.price;
  return {
    rodTier,
    baitTier,
    spot,
    maxTier,
    n,
    avgValue: avg(values),
    medianValue: median(values),
    maxValue: Math.max(...values),
    avgTier: avg(tiers),
    specialRate: specials / n,
    avgWait: avg(waits),
    baitUsed,
    baitPerFish,
    baitCost,
    /** 扣掉鱼饵成本后的净收益（单位：元 / 每次抛竿） */
    netValue: avg(values) - baitCost,
    top,
  };
}

console.log('\n\x1b[36m=== 每次抛竿的收益（元）===\x1b[0m');
console.log('竿  饵  钓点        上限   等待    平均收益  净收益  中位    最高      稀有率  每竿耗饵');
console.log('─'.repeat(104));

const rows = [];
for (let rt = 1; rt <= MAX_TIER; rt++) {
  if (ROD_TIER && rt !== ROD_TIER) continue;
  // 合理的搭配：竿等级配同等级饵
  const baitTier = Math.min(rt, 6);
  for (const spot of FISHING_SPOTS) {
    const r = simulate({ rodTier: rt, baitTier, spot });
    rows.push(r);
    console.log(
      `${String(rt).padEnd(3)}${String(baitTier).padEnd(4)}${spot.name.padEnd(12)}` +
      `T${String(r.maxTier).padEnd(5)}${r.avgWait.toFixed(1).padStart(5)}s` +
      `${Math.round(r.avgValue).toLocaleString().padStart(11)}` +
      `${Math.round(r.netValue).toLocaleString().padStart(9)}` +
      `${Math.round(r.medianValue).toLocaleString().padStart(8)}` +
      `${Math.round(r.maxValue).toLocaleString().padStart(11)}` +
      `${(r.specialRate * 100).toFixed(2).padStart(7)}%` +
      `${(r.baitPerFish * 1).toFixed(2).padStart(8)} 个`
    );
  }
}

console.log('\n\x1b[36m=== 回本时间（净收益口径；按每分钟 4 次抛竿估）===\x1b[0m');
console.log('竿升级                        价格        净收益/次    需要多少竿   大约几分钟');
console.log('─'.repeat(96));
for (let t = 2; t <= MAX_TIER; t++) {
  const rodDef = RODS.find((r) => r.tier === t);
  const now = rows.find((r) => r.rodTier === t && r.spot.id === 'pier');
  if (!now) continue;
  // 竿价 / 这一级在栈桥的净收益 = 换竿后要抛多少竿才把竿钱赚回来
  const casts = now.netValue > 0 ? rodDef.price / now.netValue : Infinity;
  console.log(
    `${`T${t - 1} -> T${t}（${rodDef.name}）`.padEnd(31)}` +
    `${rodDef.price.toLocaleString().padStart(9)}` +
    `${Math.round(now.netValue).toLocaleString().padStart(12)}` +
    `${(Number.isFinite(casts) ? Math.ceil(casts) : '—').toString().padStart(13)}` +
    `${(Number.isFinite(casts) ? (casts / 4).toFixed(1) : '—').toString().padStart(13)}`
  );
}
console.log('  （不含走路、卖货、烤鱼、捡海产品的时间，所以真实节奏会更慢一些）');

console.log('\n\x1b[36m=== 开局（T1 竿 + T1 饵 + 近岸）能钓到什么 ===\x1b[0m');
const opening = simulate({ rodTier: 1, baitTier: 1, spot: FISHING_SPOTS[0], n: 6000 });
for (const [name, count] of opening.top) {
  console.log(`  ${name.padEnd(8)} ${(count / opening.n * 100).toFixed(1)}%`);
}
const perCast = 60 / (opening.avgWait + 4); // 4 秒的抛竿 / 收线开销
console.log(
  `  平均收益 ${opening.avgValue.toFixed(1)} 元/条，平均等待 ${opening.avgWait.toFixed(1)} 秒` +
  `  ->  约 ${perCast.toFixed(1)} 次抛竿/分钟`
);

// 第一根竹竿 180 元，沙蚕 8 元/10 个
const netPerCast = opening.netValue;
const castsToRod = 180 / netPerCast;
console.log(
  `\n  结论：T1 近岸净收益约 ${netPerCast.toFixed(1)} 元/次，` +
  `光靠钓鱼约 ${Math.ceil(castsToRod)} 次（约 ${(castsToRod / perCast).toFixed(0)} 分钟）能买下第一根竹竿；` +
  `边捡海产品会明显更快。`
);

console.log('\n\x1b[36m=== 烧烤收益（同一条鱼，火候对价值的影响）===\x1b[0m');
const sample = makeItem('fish', 'tuna', { quality: 2, weightKg: 32, lengthCm: 125 });
const raw = itemValue(sample);
for (const t of [0, 10, 22, 40, 60, 100]) {
  const mult = cookValueMultiplier(t);
  console.log(`  烤 ${String(t).padStart(3)} 秒：价值 x${mult.toFixed(2)}  ->  ${Math.round(raw * mult).toLocaleString()} 元`);
}
console.log(`  （生鱼 ${raw.toLocaleString()} 元；点火成本 ${GRILL.igniteCost} 元 / 3 分钟）`);

console.log('\n\x1b[36m=== 背包扩容 ===\x1b[0m');
let slots = BASE_SLOTS;
for (const p of SLOT_UPGRADE_PRICES) {
  slots += 1;
  console.log(`  ${slots - 1} -> ${slots} 格：${p.toLocaleString()} 元`);
}

console.log('\n\x1b[36m=== 图鉴 ===\x1b[0m');
for (let t = 1; t <= MAX_TIER; t++) {
  const list = FISH.filter((f) => f.tier === t);
  console.log(
    `  T${t}：${list.map((f) => `${f.name}${f.special ? '★' : ''}(${f.value.toLocaleString()})`).join('、')}`
  );
}
console.log('');
