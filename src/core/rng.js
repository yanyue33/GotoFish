/**
 * 随机数 / 数学工具
 *
 * 设计要点：
 * - 全局使用一个内部 RNG，可注入种子（测试时用固定种子复现结果）。
 * - 所有游戏逻辑都走这里，绝不直接用 Math.random()，否则无法确定性测试。
 */

let _rand = Math.random;

/** 注入自定义随机源（测试 / 回放用）。传入 null 恢复 Math.random */
export function setRandomSource(fn) {
  _rand = typeof fn === 'function' ? fn : Math.random;
}

/** 当前随机源，便于组合子随机流 */
export function randomSource() {
  return _rand;
}

/** [0, 1) */
export function rand() {
  return _rand();
}

/** [min, max) 浮点 */
export function randRange(min, max) {
  return min + _rand() * (max - min);
}

/** [min, max] 整数 */
export function randInt(min, max) {
  return Math.floor(min + _rand() * (max - min + 1));
}

/** 概率判定 */
export function chance(p) {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return _rand() < p;
}

/** 数组随机取一个 */
export function pick(arr) {
  return arr[Math.floor(_rand() * arr.length)];
}

/**
 * 按权重取索引。weights 中的非正数视为不参与。
 * 若总权重为 0，返回 -1。
 */
export function weightedIndex(weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w > 0) total += w;
  }
  if (total <= 0) return -1;
  let r = _rand() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return i;
  }
  // 浮点兜底
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/** 按权重取元素 */
export function weightedPick(items, weightOf) {
  const idx = weightedIndex(items.map(weightOf));
  return idx < 0 ? null : items[idx];
}

/** 近似标准正态（Irwin–Hall，12 次均匀分布求和） */
export function gaussian() {
  let s = 0;
  for (let i = 0; i < 12; i++) s += _rand();
  return s - 6;
}

/** 正态分布裁剪到 [min, max] */
export function gaussianRange(mean, sd, min, max) {
  const v = mean + gaussian() * sd;
  return clamp(v, min, max);
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 把 v 从 [a1,b1] 线性映射到 [a2,b2]，并裁剪 */
export function remap(v, a1, b1, a2, b2) {
  if (b1 === a1) return a2;
  return clamp(lerp(a2, b2, (v - a1) / (b1 - a1)), Math.min(a2, b2), Math.max(a2, b2));
}

/** 可重复的伪随机数发生器（mulberry32） */
export function makeSeededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串转 32 位种子（存档校验等） */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
