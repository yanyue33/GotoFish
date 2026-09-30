/**
 * 物品统一层：把「鱼 / 海产品 / 鱼饵 / 钓竿 / 烤鱼」统一成一种可放进背包、
 * 可卖出、可检视、可在地上存在的实例结构。
 *
 * 物品实例结构（Inventory 与存档都只认它）：
 * {
 *   uid: string,            // 唯一 id
 *   kind: 'sea' | 'fish' | 'cooked' | 'bait' | 'rod',
 *   speciesId: string,      // 鱼种 / 海产品 id，或竿 id
 *   quality: number,        // 品质索引，见 QUALITIES
 *   weightKg: number,
 *   lengthCm: number,
 *   count: number,          // 鱼饵/竿为 1，鱼饵堆叠时 >1（默认不堆叠，见 inventory）
 *   cookT: number,          // 已烤秒数；-1 表示没烤过
 *   cookStage: string|null, // 结算时的火候阶段
 *   pond: boolean,          // 是否已被放进鱼池（观赏鱼）
 * }
 */

import {
  FISH_BY_ID,
  SEA_BY_ID,
  BAIT_BY_ID,
  QUALITIES,
  qualityById,
  GRILL,
  cookStage,
  cookValueMultiplier,
  MAX_TIER,
  BAITS,
  baitOfTier,
  SEA_PRODUCTS,
  FISH,
} from './fish.js';

/* ------------------------------------------------------------------ *
 * 钓竿
 * ------------------------------------------------------------------ */

/**
 * tier      等级，决定能钓到的最高鱼等级
 * power     提竿力度（收线加速）
 * lineStr   鱼线强度（张力阈值，越高越不容易断线）
 * speed     收线速度
 * rareBonus 稀有度加成
 * price     购买价
 */
export const RODS = [
  {
    id: 'rod_bamboo', name: '竹制手竿', tier: 1, power: 1.0, lineStr: 1.0, speed: 1.0, rareBonus: 1.0,
    price: 180, color: '#c8a24a', accent: '#7a5a24',
    desc: '用岛上的竹子削的，能钓到螃蟹和龙虾就该谢天谢地。',
  },
  {
    id: 'rod_fiber', name: '玻璃钢竿', tier: 2, power: 1.18, lineStr: 1.22, speed: 1.12, rareBonus: 1.15,
    price: 1100, color: '#8d99a6', accent: '#3f4a55',
    desc: '轻便耐用的入门好竿，近岸的鲈鱼鲳鱼都跑不掉。',
  },
  {
    id: 'rod_carbon', name: '碳素矶竿', tier: 3, power: 1.36, lineStr: 1.45, speed: 1.24, rareBonus: 1.35,
    price: 6000, color: '#2f3b46', accent: '#c8d2dc',
    desc: '碳布卷制，腰力十足，金枪鱼也能周旋一下。',
  },
  {
    id: 'rod_boat', name: '船钓强力竿', tier: 4, power: 1.58, lineStr: 1.7, speed: 1.36, rareBonus: 1.6,
    price: 28000, color: '#1f5f74', accent: '#e0b040',
    desc: '粗壮的海钓竿，配粗线大钩，专治剑鱼马林。',
  },
  {
    id: 'rod_titan', name: '钛合金远投竿', tier: 5, power: 1.82, lineStr: 2.0, speed: 1.5, rareBonus: 1.95,
    price: 120000, color: '#b9c2cc', accent: '#4a5560',
    desc: '钛合金骨架，能远投两百米，深海巨物也拉得回来。',
  },
  {
    id: 'rod_legend', name: '深海传说·龙王竿', tier: 6, power: 2.15, lineStr: 2.4, speed: 1.66, rareBonus: 2.6,
    price: 560000, color: '#3a2f6b', accent: '#ffd24a',
    desc: '岛上老渔夫说，这竿是龙王借给凡人的，用完要还。',
  },
];

export const ROD_BY_ID = new Map(RODS.map((r) => [r.id, r]));

/* ------------------------------------------------------------------ *
 * 钓点
 * ------------------------------------------------------------------ */

/**
 * bonusTier 钓点对「能钓到多高级的鱼」的加成
 * depth     影响等待时间
 * spot      世界坐标（抛竿落点中心）
 * radius    抛竿散布半径
 */
export const FISHING_SPOTS = [
  { id: 'shore', name: '近岸浅滩', bonusTier: 0, depth: 1, pos: [0, 0, 46], radius: 26, desc: '脚下就是浅滩，小鱼小蟹最多。' },
  { id: 'pier', name: '木栈桥', bonusTier: 1, depth: 2, pos: [0, 0, 92], radius: 30, desc: '栈桥尽头水深一些，能碰到更大的鱼。' },
  { id: 'boat', name: '礁石外海', bonusTier: 2, depth: 3, pos: [0, 0, 128], radius: 34, desc: '离岸最远，深海巨物出没的地方。' },
];

export const SPOT_BY_ID = new Map(FISHING_SPOTS.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ *
 * 背包扩容
 * ------------------------------------------------------------------ */

/** 下标 i 表示「从 3 格扩到 i+4 格」的价格 */
export const SLOT_UPGRADE_PRICES = [800, 3000, 8000, 20000, 50000, 120000];
export const BASE_SLOTS = 3;
export const MAX_SLOTS = 9;

/* ------------------------------------------------------------------ *
 * 商品（商店卖的东西）
 * ------------------------------------------------------------------ */

/**
 * 商店目录：钓竿、鱼饵、背包扩容（扩容作为特殊商品由 Shop 处理）
 */
export function shopCatalog() {
  const list = [];
  for (const r of RODS) list.push({ type: 'rod', id: r.id, name: r.name, price: r.price, tier: r.tier, desc: r.desc });
  for (const b of BAITS) {
    list.push({
      type: 'bait', id: b.id, name: b.name, price: b.price, tier: b.tier, desc: b.desc,
      bundle: b.tier <= 2 ? 10 : b.tier <= 4 ? 5 : 3,
    });
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * 名称 / 描述 / 价值
 * ------------------------------------------------------------------ */

export function speciesOf(kind, speciesId) {
  if (kind === 'sea') return SEA_BY_ID.get(speciesId) || null;
  if (kind === 'fish' || kind === 'cooked' || kind === 'pond') return FISH_BY_ID.get(speciesId) || null;
  if (kind === 'bait') return BAIT_BY_ID.get(speciesId) || null;
  if (kind === 'rod') return ROD_BY_ID.get(speciesId) || null;
  return null;
}

/** 显示名：烤鱼会带火候字样（半生的 / 烤 / 烤糊的 / 焦炭） */
export function itemName(item) {
  const kind = item.kind === 'pond' ? 'fish' : item.kind;
  const sp = speciesOf(kind, item.speciesId);
  const base = sp ? sp.name : item.speciesId;
  if (item.kind === 'cooked') {
    const st = item.cookStage || 'raw';
    if (st === 'charcoal') return `${base}焦炭`;
    if (st === 'burnt') return `烤糊的${base}`;
    if (st === 'raw') return `半生的${base}`;
    return `烤${base}`;
  }
  return base;
}

/**
 * 物品的「物种类别」：烤鱼在数据上属于鱼（共用鱼的数据表）。
 * 需要区分是否烤过时请直接看 item.kind === 'cooked'（itemName / itemValue / itemHunger 都是这么做的）。
 */
export function kindOf(item) {
  return item.kind === 'pond' ? 'fish' : item.kind;
}

export function itemTier(item) {
  const sp = speciesOf(kindOf(item), item.speciesId);
  return sp ? (sp.tier || 1) : 1;
}

export function itemQuality(item) {
  return qualityById(item.quality ?? 1);
}

/**
 * 重量系数：以该物种平均重量为 1.0，越重越值钱（边际递减，上限 6 倍）。
 * 低于平均则按比例扣，下限 0.35。
 */
export function weightMultiplier(item) {
  const sp = speciesOf(kindOf(item), item.speciesId);
  if (!sp || !sp.avgKg) return 1;
  const ratio = (item.weightKg || sp.avgKg) / sp.avgKg;
  if (ratio >= 1) return Math.min(6, 1 + Math.pow(ratio - 1, 0.78) * 0.85);
  return Math.max(0.35, 0.55 + 0.45 * ratio);
}

/** 体型系数：以平均尺寸为 1.0，范围 0.45 ~ 4 倍 */
export function sizeMultiplier(item) {
  const sp = speciesOf(kindOf(item), item.speciesId);
  if (!sp || !sp.avgCm) return 1;
  const ratio = (item.lengthCm || sp.avgCm) / sp.avgCm;
  if (ratio >= 1) return Math.min(4, 1 + Math.pow(ratio - 1, 0.7) * 0.8);
  return Math.max(0.45, 0.6 + 0.4 * ratio);
}

/** 等级系数：越高级的鱼对属性滚动越敏感（也是「高级鱼更值钱」的一部分） */
function tierSensitivity(tier) {
  return 0.9 + 0.14 * (tier - 1);
}

/**
 * 单个物品的最终价值。
 * value = 基础价值 × 品质 × 重量^tier敏感 × 体型^tier敏感 × 等级系数 × 火候倍率
 */
export function itemValue(item) {
  const kind = kindOf(item);
  const sp = speciesOf(kind, item.speciesId);
  if (!sp) return 0;
  const tier = sp.tier || 1;
  const sens = tierSensitivity(tier);
  const quality = itemQuality(item);
  const wm = Math.pow(weightMultiplier(item), sens);
  const sm = Math.pow(sizeMultiplier(item), sens);
  const tm = 1 + 0.06 * (tier - 1) * (tier - 1) * 0.35;

  // 鱼饵 / 钓竿走价目表，不看品质、重量和火候
  if (item.kind === 'bait') return Math.max(1, Math.round(sp.price || 0));
  if (item.kind === 'rod') return Math.max(1, Math.round((sp.price || 0) * 0.55));

  let value = (sp.value || 0) * quality.multiplier * wm * sm * tm;
  // 火候只影响「烤过的东西」，判断用 item.kind 而不是 kindOf（后者把烤鱼归到 fish）
  if (item.kind === 'cooked') {
    value *= cookValueMultiplier(Math.max(0, item.cookT || 0));
  }
  return Math.max(1, Math.round(value));
}

/** 卖出价（商店收购价）：鱼饵按六折回收，钓竿按二手价，其余就是物品价值 */
export function sellPrice(item) {
  if (item.kind === 'bait') return Math.max(1, Math.round((speciesOf('bait', item.speciesId)?.price || 0) * 0.6));
  return itemValue(item);
}

/** 图鉴/展示用：把价值拆成明细，方便 F 键检视面板讲解定价 */
export function valueBreakdown(item) {
  const kind = kindOf(item);
  const sp = speciesOf(kind, item.speciesId);
  if (!sp) return null;
  const tier = sp.tier || 1;
  return {
    base: sp.value,
    quality: itemQuality(item),
    weight: weightMultiplier(item),
    size: sizeMultiplier(item),
    tierMult: 1 + 0.06 * (tier - 1) * (tier - 1) * 0.35,
    cook: item.kind === 'cooked' ? cookValueMultiplier(Math.max(0, item.cookT || 0)) : 1,
    total: itemValue(item),
    special: !!sp.special,
  };
}

/** 物品饱食度（吃下去回多少） */
export function itemHunger(item) {
  const kind = item.kind === 'pond' ? 'fish' : item.kind;
  const sp = speciesOf(kind === 'cooked' ? 'fish' : kind, item.speciesId);
  if (!sp) return 0;
  const tier = sp.tier || 1;
  let base;
  if (kind === 'sea') {
    base = [0, 12, 20, 30, 45, 62, 80][Math.min(6, tier)] || 12;
  } else {
    // 鱼：同等级鱼比海产品更顶饱
    base = 10 + tier * 9;
    if (sp.special) base *= 1.25;
  }
  if (item.kind === 'cooked') {
    base *= GRILL.hungerMult[item.cookStage || 'raw'] ?? 1;
  }
  return Math.round(base);
}

/** 是否可食用 */
export function isEdible(item) {
  const kind = item.kind === 'pond' ? 'fish' : item.kind;
  return kind === 'sea' || kind === 'fish' || kind === 'cooked';
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

let _uidCounter = 0;
export function newUid(prefix = 'it') {
  _uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_uidCounter.toString(36)}`;
}

export function makeItem(kind, speciesId, opts = {}) {
  const sp = speciesOf(kind, speciesId);
  return {
    uid: opts.uid || newUid(kind),
    kind,
    speciesId,
    quality: opts.quality ?? 1,
    weightKg: opts.weightKg ?? (sp && sp.avgKg) ?? 1,
    lengthCm: opts.lengthCm ?? (sp && sp.avgCm) ?? 10,
    count: opts.count ?? 1,
    cookT: opts.cookT ?? -1,
    cookStage: opts.cookStage ?? null,
  };
}

/** 由 rollFishInstance 的结果造一个鱼物品 */
export function itemFromRoll(roll) {
  return makeItem('fish', roll.speciesId, {
    quality: roll.quality,
    weightKg: roll.weightKg,
    lengthCm: roll.lengthCm,
  });
}

/**
 * 把生鱼变成烤鱼（保留重量/尺寸/品质，重新计算价值）。
 * 会返回新物品，uid 保持不变（
 * 以便 UI 面板追踪同一件东西）。
 */
export function toCooked(item, seconds) {
  const t = Math.max(0, seconds);
  const st = cookStage(t);
  return {
    ...item,
    kind: 'cooked',
    cookT: t,
    cookStage: st.key,
  };
}

/** 由钓竿定义生成手持钓竿物品 */
export function makeRod(rodId) {
  const r = ROD_BY_ID.get(rodId);
  return makeItem('rod', rodId, { quality: 1, weightKg: r ? r.weight ?? 0.6 : 0.6, lengthCm: 180 });
}

/** 由鱼饵定义生成鱼饵物品 */
export function makeBait(baitId, count = 1) {
  return makeItem('bait', baitId, { quality: 1, weightKg: 0.05, lengthCm: 5, count });
}

/** 安全解析存档里的物品（丢弃已不存在的 id） */
export function reviveItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  if (!['sea', 'fish', 'cooked', 'bait', 'rod'].includes(kind)) return null;
  if (!speciesOf(kind, raw.speciesId)) return null;
  const sp = speciesOf(kind, raw.speciesId);
  return {
    uid: typeof raw.uid === 'string' ? raw.uid : newUid(kind),
    kind,
    speciesId: raw.speciesId,
    quality: Math.max(0, Math.min(QUALITIES.length - 1, raw.quality | 0 || 0)),
    weightKg: Number.isFinite(raw.weightKg) ? raw.weightKg : sp.avgKg,
    lengthCm: Number.isFinite(raw.lengthCm) ? raw.lengthCm : sp.avgCm,
    count: Math.max(1, raw.count | 0 || 1),
    cookT: Number.isFinite(raw.cookT) ? raw.cookT : -1,
    cookStage: typeof raw.cookStage === 'string' ? raw.cookStage : null,
  };
}

export {
  GRILL, MAX_TIER, QUALITIES, qualityById, cookStage, cookValueMultiplier,
  // 便捷再导出：调用方只 import ./data/items.js 就能拿到物品和鱼的数据表
  BAITS, BAIT_BY_ID, baitOfTier, SEA_PRODUCTS, FISH, FISH_BY_ID, SEA_BY_ID,
};
