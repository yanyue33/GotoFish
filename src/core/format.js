/**
 * 命名与格式化工具
 */

/** 32 位整数哈希（FNV-1a 变体），用于给名称取确定性随机数 */
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 由字符串确定性地生成一个 [0,1) 随机流 */
export function seededFromString(str) {
  let a = hash32(str);
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 数字千分位 */
export function formatNumber(n) {
  const v = Math.round(n);
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金钱显示：1234 -> §1,234 */
export function formatMoney(n) {
  return '§' + formatNumber(n);
}

/** 重量显示：0.85 -> 0.85 kg；12.4 -> 12.4 kg；340 -> 340 kg */
export function formatWeight(kg) {
  if (kg >= 100) return kg.toFixed(0) + ' kg';
  if (kg >= 10) return kg.toFixed(1) + ' kg';
  return kg.toFixed(2) + ' kg';
}

/** 长度显示 */
export function formatLength(cm) {
  if (cm >= 100) return (cm / 100).toFixed(2) + ' m';
  return cm.toFixed(1) + ' cm';
}

/** 秒 -> mm:ss */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** 秒 -> 1小时23分（用于统计面板） */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}
