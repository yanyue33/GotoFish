/**
 * 游戏数据表：海产品、鱼类、鱼饵、烤架相关常量。
 *
 * 数值设计目标（对应策划文档）：
 *   开局捡的海产只有几块钱  ->  顶级稀有鱼能卖到几万 ~ 十几万。
 *   整条曲线靠「基础价值 × 重量系数 × 体型系数 × 品质系数 × 稀有度加成」堆起来，
 *   而不是靠某一项爆掉。
 *
 * 本文件不 import 任何 three.js，可在 Node 下直接测试。
 */

import { gaussianRange, randRange, weightedIndex, chance, rand } from '../core/rng.js';

/** 最高等级 */
export const MAX_TIER = 6;

/* ------------------------------------------------------------------ *
 * 品质
 * ------------------------------------------------------------------ */

export const QUALITIES = [
  { id: 0, key: 'broken', name: '破损', color: '#8b8b8b', multiplier: 0.45 },
  { id: 1, key: 'normal', name: '普通', color: '#e8e8e8', multiplier: 1.0 },
  { id: 2, key: 'fine', name: '优良', color: '#5ddc6a', multiplier: 1.65 },
  { id: 3, key: 'perfect', name: '完美', color: '#4aa8ff', multiplier: 2.9 },
  { id: 4, key: 'legendary', name: '传说', color: '#ffb340', multiplier: 6.0 },
];

/**
 * 品质权重表：索引 = 钓竿等级(1..6)，行 = 各品质权重。
 * 低级竿几乎只有普通货；满级竿才容易出完美/传说。
 */
export const QUALITY_WEIGHTS = {
  1: [16, 78, 6, 0, 0],
  2: [10, 74, 15, 1, 0],
  3: [6, 66, 24, 4, 0],
  4: [4, 56, 30, 9.5, 0.5],
  5: [2, 46, 34, 15, 3],
  6: [1, 36, 36, 21, 6],
};

/** 品质对重量的隐性加成（好品质的鱼通常更壮实一点） */
const QUALITY_WEIGHT_NUDGE = [0.82, 1.0, 1.08, 1.18, 1.34];

/** 抛品质 */
export function rollQuality(rodTier = 1) {
  const t = Math.max(1, Math.min(MAX_TIER, Math.round(rodTier)));
  const weights = QUALITY_WEIGHTS[t] || QUALITY_WEIGHTS[1];
  const idx = weightedIndex(weights);
  return QUALITIES[idx < 0 ? 1 : idx];
}

export function qualityById(id) {
  return QUALITIES[Math.max(0, Math.min(QUALITIES.length - 1, id | 0))];
}

/* ------------------------------------------------------------------ *
 * 海产品（捡拾物）
 * ------------------------------------------------------------------ */

/**
 * value: 基础价值（元）
 * tier : 等级，决定饱食度与刷新权重
 * spawn: 刷新权重（越大越常见）
 * avgKg/avgCm: 典型重量/尺寸，用于随机与图鉴
 */
export const SEA_PRODUCTS = [
  { id: 'seaweed', name: '海带', tier: 1, value: 3, spawn: 16, avgKg: 0.35, avgCm: 42, color: '#3f6b34', shape: 'strand', desc: '沙滩边随处可见的海带，晒干了也能卖点钱。' },
  { id: 'mussel', name: '海虹', tier: 1, value: 4, spawn: 15, avgKg: 0.12, avgCm: 7, color: '#2f3b4a', shape: 'shell', desc: '一簇簇长在礁石上的黑壳贝。' },
  { id: 'clam', name: '蛤蜊', tier: 1, value: 6, spawn: 14, avgKg: 0.09, avgCm: 5, color: '#d9cdb4', shape: 'shell', desc: '退潮后沙里一挖一个。' },
  { id: 'crab_shell', name: '蟹壳', tier: 1, value: 5, spawn: 10, avgKg: 0.18, avgCm: 12, color: '#c96b3a', shape: 'crab', desc: '不知道被谁吃干净的蟹壳。' },
  { id: 'conch', name: '海螺', tier: 2, value: 18, spawn: 11, avgKg: 0.3, avgCm: 15, color: '#e8c9a8', shape: 'conch', desc: '贴在耳边能听到海浪声。' },
  { id: 'scallop', name: '扇贝', tier: 2, value: 24, spawn: 9, avgKg: 0.16, avgCm: 9, color: '#e7b7a1', shape: 'shell', desc: '壳面像扇子一样有纹路。' },
  { id: 'abalone', name: '鲍鱼', tier: 3, value: 90, spawn: 6, avgKg: 0.22, avgCm: 11, color: '#9a8b6e', shape: 'shell', desc: '礁石缝里的好东西，能卖不少钱。' },
  { id: 'coral', name: '珊瑚', tier: 3, value: 130, spawn: 4.5, avgKg: 0.6, avgCm: 26, color: '#e2607a', shape: 'coral', desc: '海里的红树枝，游客很喜欢。' },
  { id: 'seahorse', name: '海马', tier: 4, value: 420, spawn: 2.6, avgKg: 0.09, avgCm: 17, color: '#dcb463', shape: 'seahorse', desc: '被浪冲上岸的小家伙，据说很补。' },
  { id: 'pearl', name: '珍珠', tier: 5, value: 1500, spawn: 1.1, avgKg: 0.03, avgCm: 2, color: '#f4f0ff', shape: 'pearl', desc: '贝壳里藏着的圆润珠子，价值不菲。' },
];

/** 海产品等级 -> 饱食度基础回复量 */
export const SEA_FOOD_HUNGER = [0, 12, 20, 30, 45, 62, 80];

/* ------------------------------------------------------------------ *
 * 鱼类
 * ------------------------------------------------------------------ */

/**
 * 字段说明：
 *   tier   : 等级 1..6，需要同等级或以上的钓竿（+ 钓点加成）才可能上钩
 *   value  : 基础价值
 *   bite   : 上钩权重（同一等级内相对概率）
 *   special: 特殊鱼，价值远高于同级，极稀有
 *   spd    : 挣扎强度，影响收线难度（0.6 温顺 ~ 1.8 狂暴）
 *   rod    : 模型风格 rod=长条鱼 body=圆胖鱼 flat=扁平鱼 eel=长蛇形
 */
export const FISH = [
  /* ---------------- 1 级 ---------------- */
  { id: 'crab', name: '海蟹', tier: 1, value: 14, bite: 34, spd: 0.75, rod: 'crab', avgKg: 0.45, avgCm: 14, color: '#d1583a', desc: '横着走的小家伙，两只钳子挺凶。' },
  { id: 'lobster', name: '龙虾', tier: 1, value: 22, bite: 30, spd: 0.8, rod: 'crab', avgKg: 0.6, avgCm: 22, color: '#c0452f', desc: '龙虾，钳子很有力，抓住要小心。' },
  { id: 'shrimp', name: '青虾', tier: 1, value: 9, bite: 28, spd: 0.6, rod: 'shrimp', avgKg: 0.07, avgCm: 9, color: '#7fb3a8', desc: '一弹一弹的，个头不大但很常见。' },
  { id: 'goby', name: '沙光鱼', tier: 1, value: 11, bite: 22, spd: 0.65, rod: 'rod', avgKg: 0.2, avgCm: 16, color: '#b7a77c', desc: '趴在海床上的小鱼，滑溜溜的。' },
  { id: 'sardine', name: '沙丁鱼', tier: 1, value: 13, bite: 20, spd: 0.7, rod: 'rod', avgKg: 0.15, avgCm: 15, color: '#8fa8c0', desc: '成群结队，银闪闪的一片。' },
  { id: 'grouper', name: '石斑鱼', tier: 1, value: 320, bite: 3, spd: 1.15, rod: 'body', special: true, avgKg: 3.2, avgCm: 52, color: '#6d5a45', desc: '礁石缝里的隐士，肉质极好，属于大海的馈赠。' },

  /* ---------------- 2 级 ---------------- */
  { id: 'seabass', name: '鲈鱼', tier: 2, value: 62, bite: 30, spd: 0.95, rod: 'rod', avgKg: 1.4, avgCm: 42, color: '#93a6ad', desc: '近岸最常见的掠食者，冲劲不错。' },
  { id: 'flatfish', name: '比目鱼', tier: 2, value: 76, bite: 26, spd: 0.85, rod: 'flat', avgKg: 1.1, avgCm: 38, color: '#a89372', desc: '两只眼睛长在同一边，贴在沙上很难发现。' },
  { id: 'squid', name: '鱿鱼', tier: 2, value: 55, bite: 24, spd: 1.05, rod: 'squid', avgKg: 0.8, avgCm: 34, color: '#e2b7c6', desc: '喷墨逃跑，收线的时候会突然拉扯。' },
  { id: 'pompano', name: '鲳鱼', tier: 2, value: 88, bite: 20, spd: 1.0, rod: 'flat', avgKg: 1.0, avgCm: 33, color: '#c8d6de', desc: '扁扁的银鲳，游起来很优雅。' },
  { id: 'sea_bream', name: '真鲷', tier: 2, value: 3500, bite: 2, spd: 1.35, rod: 'body', special: true, avgKg: 7.5, avgCm: 82, color: '#d4697b', desc: '通体粉红的海中贵客，宴席上的头牌。' },

  /* ---------------- 3 级 ---------------- */
  { id: 'tuna', name: '金枪鱼', tier: 3, value: 260, bite: 26, spd: 1.5, rod: 'body', avgKg: 32, avgCm: 125, color: '#3d6b8f', desc: '远洋的火车头，一旦上钩就是硬仗。' },
  { id: 'mackerel', name: '鲭鱼', tier: 3, value: 180, bite: 28, spd: 1.2, rod: 'rod', avgKg: 2.2, avgCm: 55, color: '#4c7d7a', desc: '背上带花纹的洄游鱼，肉很肥。' },
  { id: 'eel', name: '海鳗', tier: 3, value: 240, bite: 22, spd: 1.35, rod: 'eel', avgKg: 4.5, avgCm: 110, color: '#5c5340', desc: '滑得抓不住，会绕着船缠来缠去。' },
  { id: 'snapper', name: '红鳍笛鲷', tier: 3, value: 300, bite: 18, spd: 1.25, rod: 'body', avgKg: 5.5, avgCm: 68, color: '#c85b52', desc: '红鳍一闪就是它，礁区的中层猎手。' },
  { id: 'bluefin', name: '蓝鳍金枪王', tier: 3, value: 16000, bite: 1.6, spd: 1.7, rod: 'body', special: true, avgKg: 120, avgCm: 210, color: '#2b4f73', desc: '整片海最贵的鱼之一，能钓到全凭运气和体力。' },

  /* ---------------- 4 级 ---------------- */
  { id: 'swordfish', name: '剑鱼', tier: 4, value: 900, bite: 26, spd: 1.5, rod: 'bill', avgKg: 68, avgCm: 220, color: '#41546b', desc: '上颌像一把剑，冲刺起来时速惊人。' },
  { id: 'marlin', name: '马林鱼', tier: 4, value: 1150, bite: 22, spd: 1.6, rod: 'bill', avgKg: 95, avgCm: 260, color: '#2f4a63', desc: '海上的跳高冠军，收线时常常跃出水面。' },
  { id: 'amberjack', name: '鰤鱼', tier: 4, value: 780, bite: 24, spd: 1.4, rod: 'body', avgKg: 24, avgCm: 110, color: '#8a9b45', desc: '力量型的黄色大块头。' },
  { id: 'ray', name: '鳐鱼', tier: 4, value: 1020, bite: 20, spd: 1.3, rod: 'flat', avgKg: 40, avgCm: 165, color: '#6b6f7a', desc: '像一张会飞的地毯，贴着海底滑行。' },
  { id: 'golden_mahi', name: '黄金鬼头刀', tier: 4, value: 42000, bite: 1.3, spd: 1.8, rod: 'body', special: true, avgKg: 45, avgCm: 175, color: '#e8b23a', desc: '浑身金光，在阳光下像一块会游的金子。' },

  /* ---------------- 5 级 ---------------- */
  { id: 'sailfish', name: '旗鱼', tier: 5, value: 3200, bite: 25, spd: 1.65, rod: 'bill', avgKg: 88, avgCm: 300, color: '#3a5f86', desc: '背鳍展开像一面帆，海域里最快的鱼。' },
  { id: 'moonfish', name: '翻车鱼', tier: 5, value: 3800, bite: 20, spd: 1.1, rod: 'flat', avgKg: 520, avgCm: 190, color: '#9aa6ad', desc: '圆滚滚的一坨，被钓上来时自己都很懵。' },
  { id: 'oarfish', name: '皇带鱼', tier: 5, value: 4600, bite: 18, spd: 1.45, rod: 'eel', avgKg: 180, avgCm: 620, color: '#c9d2dd', desc: '深海里的长带子，被误认成海怪好多次。' },
  { id: 'sturgeon', name: '大白鲟', tier: 5, value: 5200, bite: 16, spd: 1.5, rod: 'eel', avgKg: 260, avgCm: 340, color: '#7b7f6a', desc: '活化石，硬鳞像盔甲一样。' },
  { id: 'ghost_ray', name: '幽灵鳐', tier: 5, value: 110000, bite: 1.0, spd: 1.9, rod: 'flat', special: true, avgKg: 300, avgCm: 420, color: '#cfe4ff', desc: '夜里才出现的半透明巨鳐，见过的人不多。' },

  /* ---------------- 6 级 ---------------- */
  { id: 'dragonfish', name: '皇冠龙鱼', tier: 6, value: 9800, bite: 24, spd: 1.7, rod: 'eel', avgKg: 60, avgCm: 260, color: '#b8443c', desc: '鳞片像熔金，怒吼一声整片海都安静了。' },
  { id: 'abyss_angler', name: '深渊鮟鱇', tier: 6, value: 12000, bite: 22, spd: 1.6, rod: 'body', avgKg: 45, avgCm: 150, color: '#3b2f4a', desc: '头顶挂着一盏灯，从深渊里慢慢浮上来。' },
  { id: 'leviathan_eel', name: '利维坦鳗', tier: 6, value: 15000, bite: 18, spd: 1.85, rod: 'eel', avgKg: 460, avgCm: 900, color: '#3f5b52', desc: '传说中绕着岛一圈的海鳗之王。' },
  { id: 'star_whale', name: '星鲸', tier: 6, value: 18000, bite: 14, spd: 1.4, rod: 'body', avgKg: 2400, avgCm: 1100, color: '#5d6fa8', desc: '皮肤上落满星点的小鲸，脾气意外的好。' },
  { id: 'moon_koi', name: '月光锦鲤', tier: 6, value: 480000, bite: 0.8, spd: 2.0, rod: 'body', special: true, avgKg: 18, avgCm: 95, color: '#f2f6ff', desc: '只在满月的凌晨浮上水面，一生能见到一次就算圆满。' },
];

export const FISH_BY_ID = new Map(FISH.map((f) => [f.id, f]));
export const SEA_BY_ID = new Map(SEA_PRODUCTS.map((s) => [s.id, s]));

/** 取某一等级的鱼（含特殊鱼） */
export function fishOfTier(tier) {
  return FISH.filter((f) => f.tier === tier);
}

/* ------------------------------------------------------------------ *
 * 鱼饵
 * ------------------------------------------------------------------ */

/**
 * 鱼饵：
 *   tier       等级，必须 >= 鱼的等级（高等级鱼只认对应等级的饵）
 *   biteSpeed  咬钩等待时间倍率（越小越快）
 *   rareBonus  稀有鱼概率加成（乘算）
 *   price      单个售价
 *   useChance  每次抛竿消耗一个的概率
 */
export const BAITS = [
  { id: 'bait_worm', name: '沙蚕', tier: 1, price: 8, biteSpeed: 1.0, rareBonus: 1.0, useChance: 0.55, color: '#d08a6a', desc: '沙滩上挖的沙蚕，什么都能骗一骗。' },
  { id: 'bait_shrimp', name: '活虾', tier: 2, price: 30, biteSpeed: 0.76, rareBonus: 1.25, useChance: 0.6, color: '#e59a86', desc: '活蹦乱跳，中小型鱼很难拒绝。' },
  { id: 'bait_squid', name: '鱿鱼条', tier: 3, price: 90, biteSpeed: 0.58, rareBonus: 1.5, useChance: 0.62, color: '#f0d7e6', desc: '腥味重，专钓掠食性的大鱼。' },
  { id: 'bait_lure', name: '亮片假饵', tier: 4, price: 260, biteSpeed: 0.44, rareBonus: 1.9, useChance: 0.4, color: '#dfe5ee', desc: '反光的金属片，能反复使用。' },
  { id: 'bait_live', name: '活饵桶', tier: 5, price: 700, biteSpeed: 0.34, rareBonus: 2.4, useChance: 0.5, color: '#9fd6c8', desc: '一整桶活饵，深海的大家伙也扛不住。' },
  { id: 'bait_lure_pro', name: '拟真路亚', tier: 6, price: 1800, biteSpeed: 0.26, rareBonus: 3.2, useChance: 0.32, color: '#ffd98a', desc: '手工雕刻的高仿真路亚，几乎是永久的。' },
];

export const BAIT_BY_ID = new Map(BAITS.map((b) => [b.id, b]));

export function baitOfTier(tier) {
  return BAITS.find((b) => b.tier === tier) || null;
}

/* ------------------------------------------------------------------ *
 * 烤架
 * ------------------------------------------------------------------ */

export const GRILL = {
  /** 点火费用 */
  igniteCost: 60,
  /** 一次点火持续多少秒 */
  duration: 180,
  /** 一块鱼最多能烤多久（超过就是焦炭） */
  maxCookTime: 100,
  /**
   * 火候阶段：t 为已烤秒数
   *   raw    还没熟，价值不变但吃起来一般
   *   rare   半熟
   *   ready  最佳火候（价值最高）
   *   well   偏老
   *   burnt  开始烤焦，价值下降
   *   charcoal 焦炭，不值钱
   */
  stages: [
    { key: 'raw', name: '生', from: 0 },
    { key: 'rare', name: '半熟', from: 8 },
    { key: 'ready', name: '刚好好', from: 18 },
    { key: 'well', name: '偏老', from: 34 },
    { key: 'burnt', name: '烤焦', from: 48 },
    { key: 'charcoal', name: '焦炭', from: 78 },
  ],
  /** 各阶段相对「生鱼」的价值倍率 */
  valueMult: { raw: 1.0, rare: 1.5, ready: 2.35, well: 1.75, burnt: 0.75, charcoal: 0.06 },
  /** 各阶段相对「生鱼」的饱食度倍率 */
  hungerMult: { raw: 1.0, rare: 1.25, ready: 1.8, well: 1.6, burnt: 1.0, charcoal: 0.35 },
  /** 各阶段的标签颜色（UI） */
  stageColor: {
    raw: '#9fb6c9',
    rare: '#7fd08a',
    ready: '#ffcf4a',
    well: '#ff9a3c',
    burnt: '#b3612f',
    charcoal: '#4a4a4a',
  },
};

/** 根据已烤秒数取阶段 */
export function cookStage(t) {
  const stages = GRILL.stages;
  let cur = stages[0];
  for (const s of stages) {
    if (t >= s.from) cur = s;
    else break;
  }
  return cur;
}

/**
 * 火候价值曲线（连续版本，用于 UI 里给玩家一根会动的条）：
 * 从 0 秒的 1.0 一路涨到推荐区间，然后缓慢下降，最后砸到谷底（焦炭）。
 * stage 用的是分段倍率，这里给一个平滑插值，两者在 UI 上观感一致。
 */
export function cookValueMultiplier(t) {
  const o = GRILL.stages[2].from; // 刚好好的起点
  const p = GRILL.stages[3].from; // 偏老的起点
  const b = GRILL.stages[4].from; // 烤焦起点
  const c = GRILL.stages[5].from; // 焦炭起点
  if (t <= 0) return 1.0;
  if (t < o) return 1.0 + 1.35 * (t / o);
  if (t <= p) return 2.35;
  if (t <= b) return 2.35 - 1.6 * ((t - p) / (b - p));
  if (t <= c) return 0.75 - 0.69 * ((t - b) / (c - b));
  return 0.06;
}

/* ------------------------------------------------------------------ *
 * 钓鱼难度 / 概率模型（纯函数，方便测试）
 * ------------------------------------------------------------------ */

/**
 * 计算当前抛竿能钓到的最高等级。
 * 钓竿等级 + 钓点加成。
 */
export function effectiveMaxTier(rodTier, spotBonus = 0) {
  return Math.min(MAX_TIER, Math.max(1, rodTier + spotBonus));
}

/**
 * 咬钩等待时间（秒）。
 * 竿越好越快，饵越好越快，等级差越大越慢（小鱼闹钩少，但要等对口的）。
 */
export function biteWait({ rodTier = 1, baitTier = 1, targetTier = 1, depth = 1 }) {
  const bait = baitOfTier(baitTier) || BAITS[0];
  const rodFactor = 1.35 - 0.07 * (rodTier - 1); // 1.35 -> 1.0
  const depthFactor = 1.0 + 0.18 * (depth - 1);
  const tierGap = Math.max(0, targetTier - baitTier);
  const gapFactor = 1 + 0.85 * tierGap; // 饵不匹配就得等更久
  const base = 3.2;
  const lo = base * 0.4 * bait.biteSpeed * rodFactor * depthFactor * gapFactor;
  const hi = base * 1.15 * bait.biteSpeed * rodFactor * depthFactor * gapFactor;
  return randRange(lo, hi);
}

/**
 * 特殊鱼的基础出现权重（乘在 bite 上）。
 * 数值很小，因为下面还会被饵的稀有加成和竿的稀有加成放大。
 * 目标是：最好的配置下也只有 1~3% 左右，低级配置几乎钓不到。
 */
const SPECIAL_BASE_WEIGHT = 0.055;

/**
 * 在候选鱼里按「等级匹配度」加权抽一条。
 * 等级低于饵等级的鱼也算候选（大鱼饵也能钓小鱼），但权重会下调。
 */
export function pickFish({ maxTier = 1, baitTier = 1, spotTier = 1 }) {
  const candidates = FISH.filter((f) => f.tier <= maxTier && f.tier >= Math.max(1, spotTier - 3));
  if (candidates.length === 0) return FISH[0];
  const bait = baitOfTier(baitTier) || BAITS[0];
  const weights = candidates.map((f) => {
    let w = f.bite;
    if (f.special) {
      // 特殊鱼：固定一个极低的基础权重，只受饵与竿的稀有加成影响，
      // 这样它的稀有度和它的 bite 数值无关（bite 只用来描述它相对同级普通鱼的地位）。
      w = SPECIAL_BASE_WEIGHT * bait.rareBonus * (1 + 0.05 * (maxTier - 1));
    } else if (f.tier > baitTier) {
      // 饵等级不够，权重按等级差指数衰减（不是完全钓不到，但很难）
      w *= Math.pow(0.24, f.tier - baitTier);
    } else if (f.tier < baitTier) {
      // 饵太好，小鱼兴趣下降（但用大饵也不至于只能钓到最小的鱼）
      w *= Math.pow(0.82, baitTier - f.tier);
    }
    // 略偏好能吃到饵最高等级的鱼
    if (f.tier === Math.min(baitTier, maxTier) && !f.special) w *= 1.25;
    return w;
  });
  const idx = weightedIndex(weights);
  return candidates[idx < 0 ? 0 : idx];
}

/**
 * 计算出钩概率（抛竿后鱼已经咬钩，玩家面对的是「提竿 / 收线」阶段）。
 * 这里用于「脱钩」判定：收线过程中每次张力过载都有概率跑鱼。
 */
export function hookHoldChance({ rodTier = 1, quality = 1, fishSpeed = 1 }) {
  const rodBonus = 0.1 * (rodTier - 1);
  const q = 0.02 * quality;
  const speedPenalty = 0.07 * (fishSpeed - 1);
  return Math.min(0.985, 0.78 + rodBonus + q - speedPenalty);
}

/**
 * 特殊鱼出现概率（在已经决定上钩的那一条上再判定一次「稀有加成」）。
 * 返回 0..1。用于统计面板和调试显示。
 */
export function specialChance({ rodTier = 1, baitTier = 1 }) {
  const bait = baitOfTier(baitTier) || BAITS[0];
  const base = 0.0025;
  return Math.min(0.5, base * bait.rareBonus * (1 + 0.35 * (rodTier - 1)) * 4);
}

/* ------------------------------------------------------------------ *
 * 实例生成
 * ------------------------------------------------------------------ */

/**
 * 生成一条鱼的实例数据（品质/重量/尺寸）。
 * @returns {{speciesId:string, quality:number, weightKg:number, lengthCm:number}}
 */
export function rollFishInstance(species, rodTier = 1) {
  const quality = rollQuality(rodTier);
  const nudge = QUALITY_WEIGHT_NUDGE[quality.id] ?? 1;
  const sd = species.avgKg * 0.22;
  const weightKg = Math.max(
    species.avgKg * 0.28,
    gaussianRange(species.avgKg * nudge, sd, species.avgKg * 0.25, species.avgKg * 2.6)
  );
  const lengthCm = Math.max(
    species.avgCm * 0.4,
    species.avgCm * (0.72 + rand() * 0.62) * Math.pow(weightKg / species.avgKg, 0.24)
  );
  return { speciesId: species.id, quality: quality.id, weightKg, lengthCm: Math.round(lengthCm * 10) / 10 };
}

/** 生成一个海产品实例 */
export function rollSeaInstance(product, luck = 1) {
  const quality = rollQuality(1 + Math.min(2, Math.floor(luck)));
  const weightKg = Math.max(product.avgKg * 0.4, product.avgKg * (0.65 + rand() * 0.95));
  const lengthCm = Math.max(product.avgCm * 0.4, product.avgCm * (0.7 + rand() * 0.7));
  return { speciesId: product.id, quality: quality.id, weightKg, lengthCm: Math.round(lengthCm * 10) / 10 };
}

/**
 * 随机一条「鱼」（用于测试 / 图鉴）
 * @param {number} maxTier
 */
export function randomFishInstance(maxTier = MAX_TIER, rodTier = maxTier) {
  const pool = FISH.filter((f) => f.tier <= maxTier);
  const f = pool[Math.floor(rand() * pool.length)];
  return rollFishInstance(f, rodTier);
}

export { chance };
