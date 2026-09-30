/**
 * 钓鱼系统（纯逻辑，不依赖 three.js / DOM）。
 *
 * 状态机：
 *   idle      没抛竿
 *   charging  按住左键蓄力中（蓄力越久抛得越远）
 *   casting   钩子飞出去（视觉阶段）
 *   waiting   等鱼咬钩
 *   bite      鱼咬钩了！有短暂的提竿窗口
 *   fight     收线搏斗（QTE：按住收线，注意张力不要爆表）
 *   result    结算（成功/脱钩/断线）
 *
 * 关键公式都在 data/fish.js 里，这个文件只管「流程 + 手感参数」。
 */

import { Emitter } from '../core/emitter.js';
import { clamp, rand, randRange, chance, remap } from '../core/rng.js';
import {
  FISH_BY_ID, biteWait, pickFish, hookHoldChance, rollFishInstance,
  baitOfTier, BAITS, MAX_TIER, GRILL,
} from '../data/fish.js';
import { ROD_BY_ID, FISHING_SPOTS, makeItem, itemValue, itemName, sellPrice, SPOT_BY_ID } from '../data/items.js';

export const FISHING_STATE = {
  IDLE: 'idle',
  CHARGING: 'charging',
  CASTING: 'casting',
  WAITING: 'waiting',
  BITE: 'bite',
  FIGHT: 'fight',
  RESULT: 'result',
};

/** 手感参数：集中放这里方便调 */
export const TUNING = {
  /** 蓄力到满需要几秒 */
  chargeTime: 0.85,
  /** 最小/最大抛竿距离（米） */
  minCast: 9,
  maxCast: 72,
  /** 钩子飞行速度（米/秒） */
  castSpeed: 42,
  /** 提竿窗口（秒）：咬钩后必须在这段时间内点左键 */
  strikeWindow: 1.35,
  /** 收线时每点一次左键带来的进度（基础值，会乘竿威力等系数） */
  reelPerClick: 0.9,
  /** 按住收线的持续力度 */
  reelHoldRate: 1.15,
  /** 张力上升速度（按住收线时） */
  tensionRise: 0.62,
  /** 张力自然回落速度 */
  tensionFall: 0.85,
  /** 张力超过 1.0 视为过载 */
  tensionBreak: 1.0,
  /** 过载时每秒断线概率基数 */
  breakBaseChance: 0.62,
  /** 过载时每秒脱钩概率基数 */
  escapeBaseChance: 0.34,
  /** 鱼挣扎的节奏：多久换一次力度 */
  strugglePeriod: 1.15,
  /** 张力高低对进度的影响 */
  progressFromReel: 1.0,
  progressDecay: 0.55,
};

/**
 * 计算搏斗阶段的难度系数
 */
export function fightDifficulty({ species, rod, bait }) {
  const rodTier = rod.tier;
  const weightMass = Math.pow((species.avgKg || 1) / 2, 0.42);
  const speed = species.spd || 1;
  const tier = species.tier;
  // 越高级、越重、越狂暴 -> 进度需求越高
  const need = (2.6 + weightMass * 1.5 + speed * 1.1 + tier * 0.28) / (0.65 + 0.35 * rodTier);
  return {
    need: clamp(need, 1.6, 34),
    tensionRise: TUNING.tensionRise * (0.75 + 0.22 * speed) / (0.7 + 0.3 * rodTier),
    tensionFall: TUNING.tensionFall * (0.85 + 0.15 * rod.lineStr),
    reelRate: (0.85 + 0.15 * rodTier) * (0.85 + 0.1 * (bait?.tier || 1)),
    escapeChance: 1 - hookHoldChance({ rodTier, quality: 1, fishSpeed: speed }),
  };
}

export class FishingSystem extends Emitter {
  /**
   * @param {import('../core/state.js').GameState} state
   * @param {object} [opts]
   * @param {object} [opts.rng] 预留
   */
  constructor(state, opts = {}) {
    super();
    this.state = state;
    this.opts = opts;

    /** 供 UI 读取的只读视图，避免每帧创建对象 */
    this.view = {
      state: FISHING_STATE.IDLE,
      power: 0,
      progress: 0,
      tension: 0,
      fish: null,
      spotId: 'shore',
      hookDist: 0,
      hint: '',
    };

    this.reset();
  }

  reset() {
    this.phase = FISHING_STATE.IDLE;
    this.charge = 0;
    this.castPower = 0;
    this.hookPos = { x: 0, y: 0, z: 0 };
    this.castFrom = { x: 0, y: 0, z: 0 };
    this.castTarget = { x: 0, y: 0, z: 0 };
    this.castT = 0;
    this.waitT = 0;
    this.waitFor = 0;
    this.biteT = 0;
    this.fight = null;
    this.result = null;
    this.resultT = 0;
    this.spot = SPOT_BY_ID.get('shore');
    this.baitSnapshot = null;
    this.rodSnapshot = null;
    this.usedBaitOnce = false;
    this._syncView();
  }

  /* ------------------------------------------------------------------ *
   * 便捷读取
   * ------------------------------------------------------------------ */

  get rod() {
    const held = this.state.heldItem;
    if (!held || held.kind !== 'rod') return null;
    return ROD_BY_ID.get(held.speciesId) || null;
  }

  get rodItem() {
    const held = this.state.heldItem;
    return held && held.kind === 'rod' ? held : null;
  }

  get bait() {
    const b = this.state.inventory.bait;
    return b ? baitOfTier(BAITS.find((x) => x.id === b.speciesId)?.tier || 1) : null;
  }

  get baitEntry() {
    return this.state.inventory.bait;
  }

  get isFishing() {
    return this.phase !== FISHING_STATE.IDLE && this.phase !== FISHING_STATE.RESULT;
  }

  /** 当前可钓到的最高等级 = 竿等级 + 钓点加成 */
  maxTierAt(spotId) {
    const rod = this.rod;
    if (!rod) return 0;
    const spot = SPOT_BY_ID.get(spotId) || this.spot;
    return Math.min(MAX_TIER, rod.tier + spot.bonusTier);
  }

  /* ------------------------------------------------------------------ *
   * 输入接口
   * ------------------------------------------------------------------ */

  /**
   * 左键按下。
   * - 手持钓竿且空闲 -> 开始蓄力
   * - bite 阶段 -> 提竿（进入搏斗）
   * - fight 阶段 -> 开始收线
   * @returns {boolean} 是否被钓鱼系统消费
   */
  onPrimaryDown() {
    if (!this.rodItem) return false;
    switch (this.phase) {
      case FISHING_STATE.IDLE:
        this.startCharge();
        return true;
      case FISHING_STATE.BITE:
        this.strike();
        return true;
      case FISHING_STATE.FIGHT:
        this.fight.reeling = true;
        return true;
      default:
        return true; // 钓鱼中吞掉左键
    }
  }

  /** 左键松开：蓄力结束就抛竿；搏斗中停止收线 */
  onPrimaryUp(ctx) {
    if (!this.rodItem) return false;
    if (this.phase === FISHING_STATE.CHARGING) {
      this.doCast(ctx);
      return true;
    }
    if (this.phase === FISHING_STATE.FIGHT && this.fight) {
      this.fight.reeling = false;
      return true;
    }
    return this.isFishing;
  }

  /** 右键：快速收竿（放弃本次） */
  onSecondary() {
    if (this.phase === FISHING_STATE.IDLE) return false;
    if (this.phase === FISHING_STATE.CHARGING) {
      this.cancel();
      return true;
    }
    if (this.phase === FISHING_STATE.BITE || this.phase === FISHING_STATE.FIGHT) {
      // 搏斗中右键 = 放弃，鱼跑掉
      this.finish({ ok: false, reason: 'giveup' });
      return true;
    }
    this.cancel();
    return true;
  }

  /** 因为手持物品切换 / 背包变动 -> 强制收竿 */
  forceIdle(reason = 'switch') {
    if (this.phase === FISHING_STATE.IDLE) return;
    this.cancel(reason);
  }

  cancel(reason = 'cancel') {
    this.reset();
    this.emit('fishing:cancel', { reason });
  }

  /* ------------------------------------------------------------------ *
   * 阶段实现
   * ------------------------------------------------------------------ */

  startCharge() {
    if (!this.rodItem) return;
    if (!this.state.inventory.bait) {
      this.emit('toast', { text: '没有鱼饵了，去商店买点（B 键切换鱼饵）', kind: 'warn' });
      return;
    }
    this.phase = FISHING_STATE.CHARGING;
    this.charge = 0;
    this._syncView();
  }

  /** 蓄力：0..1，来回不是必须的，按住到顶就停在最大 */
  updateCharge(dt) {
    if (this.phase !== FISHING_STATE.CHARGING) return;
    this.charge = clamp(this.charge + dt / TUNING.chargeTime, 0, 1);
    this._syncView();
  }

  /**
   * 抛竿。
   * @param {object} ctx 需要外部提供玩家位置与朝向：
   *   { origin:{x,y,z}, dir:{x,y,z} }
   */
  doCast(ctx) {
    if (this.phase !== FISHING_STATE.CHARGING) return;
    const rod = this.rod;
    if (!rod) return this.cancel('no_rod');

    // 抛竿距离 = 蓄力曲线（前段灵敏，后段收益递减）
    const eased = Math.pow(this.charge, 0.72);
    const dist = TUNING.minCast + (TUNING.maxCast - TUNING.minCast) * eased;
    this.castPower = this.charge;

    const origin = (ctx && ctx.origin) || { x: 0, y: 1.2, z: 0 };
    const dir = (ctx && ctx.dir) || { x: 0, y: 0, z: 1 };
    const flat = Math.hypot(dir.x, dir.z) || 1;
    const nd = { x: dir.x / flat, z: dir.z / flat };

    this.castFrom = { ...origin };
    this.castTarget = {
      x: origin.x + nd.x * dist,
      y: 0.04,
      z: origin.z + nd.z * dist,
    };
    this.hookPos = { ...this.castFrom };
    this.castT = 0;
    this.phase = FISHING_STATE.CASTING;

    // 钓点判定：按落点找最近的钓点，决定等级加成与深度
    this.spot = nearestSpot(this.castTarget);

    const baitEntry = this.state.inventory.bait;
    this.baitSnapshot = baitEntry ? baitEntry.speciesId : null;
    this.rodSnapshot = rod.id;

    this.state.stats.casts += 1;
    this.emit('fishing:cast', {
      power: this.castPower,
      dist,
      spot: this.spot,
      hook: { ...this.castTarget },
    });
    this._syncView();
  }

  /** 钩子飞行 */
  updateCast(dt) {
    const total = Math.hypot(
      this.castTarget.x - this.castFrom.x,
      this.castTarget.z - this.castFrom.z
    );
    const duration = Math.max(0.18, total / TUNING.castSpeed);
    this.castT += dt / duration;
    const t = clamp(this.castT, 0, 1);
    this.hookPos.x = this.castFrom.x + (this.castTarget.x - this.castFrom.x) * t;
    this.hookPos.z = this.castFrom.z + (this.castTarget.z - this.castFrom.z) * t;
    // 抛物线
    this.hookPos.y = this.castFrom.y + (this.castTarget.y - this.castFrom.y) * t + Math.sin(Math.PI * t) * (2.4 + 3.2 * this.castPower);
    if (t >= 1) {
      this.hookPos.y = this.castTarget.y;
      this.beginWaiting();
    }
    this._syncView();
  }

  beginWaiting() {
    const rod = this.rod;
    if (!rod) return this.cancel('no_rod');
    const baitEntry = this.state.inventory.bait;
    const baitTier = baitEntry ? (BAITS.find((b) => b.id === baitEntry.speciesId)?.tier || 1) : 1;

    // 先决定这一竿的「目标鱼」，再据此算等待时间
    const maxTier = this.maxTierAt(this.spot.id);
    const target = pickFish({ maxTier, baitTier, spotTier: this.spot.bonusTier + 1 });
    this.targetSpecies = target;
    this.waitFor = biteWait({
      rodTier: rod.tier,
      baitTier,
      targetTier: target.tier,
      depth: this.spot.depth,
    });
    this.waitT = 0;
    this.phase = FISHING_STATE.WAITING;

    // 每次抛竿有一定概率消耗一个鱼饵（不管有没有鱼上钩）
    this._rollBaitConsumption();

    this.emit('fishing:waiting', { waitFor: this.waitFor, spot: this.spot });
    this._syncView();
  }

  _rollBaitConsumption() {
    if (this.usedBaitOnce) return;
    const entry = this.state.inventory.bait;
    if (!entry) return;
    const bait = BAITS.find((b) => b.id === entry.speciesId);
    if (!bait) return;
    const p = bait.useChance;
    if (chance(p)) {
      this.state.inventory.consumeBait(1);
      this.usedBaitOnce = true;
      this.emit('fishing:baitUsed', { baitId: bait.id, left: this.state.inventory.bait?.count || 0 });
      this.emit('state:changed', null);
    }
  }

  /** 咬钩 */
  triggerBite() {
    const rod = this.rod;
    if (!rod) return this.cancel('no_rod');
    const species = this.targetSpecies || pickFish({ maxTier: this.maxTierAt(this.spot.id), baitTier: 1 });
    const roll = rollFishInstance(species, rod.tier);
    this.pendingCatch = { species, roll };
    this.phase = FISHING_STATE.BITE;
    this.biteT = 0;

    const diff = fightDifficulty({ species, rod, bait: this.bait });
    this.fight = {
      tension: 0,
      progress: 0,
      reeling: false,
      elapsed: 0,
      struggle: 0,
      struggleT: 0,
      overloadT: 0,
      clicks: 0,
      need: diff.need,
      tensionRise: diff.tensionRise,
      tensionFall: diff.tensionFall,
      reelRate: diff.reelRate,
      escapeChance: diff.escapeChance,
    };

    this.emit('fishing:bite', { species, strikeWindow: TUNING.strikeWindow });
    this.emit('sound', { id: 'bite' });
    this._syncView();
  }

  /** 提竿：进入搏斗 */
  strike() {
    if (this.phase !== FISHING_STATE.BITE) return;
    this.phase = FISHING_STATE.FIGHT;
    this.emit('fishing:strike', null);
    this._syncView();
  }

  /** 收线阶段的点击：给一次性的进度加成（手感更像在「点收」） */
  reelClick() {
    if (this.phase !== FISHING_STATE.FIGHT || !this.fight) return;
    this.fight.clicks += 1;
    this.fight.progress += TUNING.reelPerClick * 0.35 * this.fight.reelRate;
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */

  update(dt, ctx) {
    switch (this.phase) {
      case FISHING_STATE.CHARGING:
        this.updateCharge(dt);
        break;
      case FISHING_STATE.CASTING:
        this.updateCast(dt);
        break;
      case FISHING_STATE.WAITING:
        this.waitT += dt;
        // 等待中每帧有小概率提前咬钩（模拟鱼群靠近），但不会早于 35% 的预期时间
        if (this.waitT >= this.waitFor) this.triggerBite();
        else if (this.waitT > this.waitFor * 0.35 && chance(dt * 0.18)) this.triggerBite();
        break;
      case FISHING_STATE.BITE:
        this.biteT += dt;
        if (this.biteT > TUNING.strikeWindow) {
          this.state.stats.bitesMissed += 1;
          this.emit('toast', { text: '提竿晚了，鱼跑了……', kind: 'warn' });
          this.finish({ ok: false, reason: 'missed' });
        }
        break;
      case FISHING_STATE.FIGHT:
        this.updateFight(dt);
        break;
      case FISHING_STATE.RESULT:
        this.resultT += dt;
        if (this.resultT > 2.2) this.reset();
        break;
      default:
        break;
    }
    if (ctx) this.castFrom = { ...ctx.origin };
  }

  updateFight(dt) {
    const f = this.fight;
    if (!f) return;
    f.elapsed += dt;

    // 鱼的挣扎节奏：周期切换力度，制造「该松手了」的节拍
    f.struggleT -= dt;
    if (f.struggleT <= 0) {
      f.struggleT = TUNING.strugglePeriod * randRange(0.7, 1.3);
      f.struggle = rand();
    }
    const struggle = 0.45 + f.struggle * 1.05; // 0.45 ~ 1.5

    if (f.reeling) {
      f.tension += f.tensionRise * struggle * dt;
      f.progress += (TUNING.reelHoldRate * f.reelRate * dt) / f.need * 12;
    } else {
      // 松手：张力回落，鱼会拉走一点线
      f.tension -= f.tensionFall * dt;
      f.progress -= (TUNING.progressDecay * struggle * dt) / f.need * 12;
    }
    f.tension = clamp(f.tension, 0, 1.6);
    f.progress = clamp(f.progress, 0, 1);

    // 过载判定
    if (f.tension > TUNING.tensionBreak) {
      f.overloadT += dt;
      const rod = this.rod;
      const lineStr = rod ? rod.lineStr : 1;
      // 越强的线越不容易断
      const breakP = TUNING.breakBaseChance * dt * (f.tension - TUNING.tensionBreak + 0.25) / lineStr;
      const escapeP = f.escapeChance * TUNING.escapeBaseChance * dt * 3.2;
      if (chance(breakP)) {
        this.state.stats.lineBroken += 1;
        this.emit('sound', { id: 'lineBreak' });
        this.finish({ ok: false, reason: 'lineBreak' });
        return;
      }
      if (chance(escapeP)) {
        this.finish({ ok: false, reason: 'escape' });
        return;
      }
    } else {
      f.overloadT = Math.max(0, f.overloadT - dt * 0.5);
    }

    if (f.progress >= 1) {
      this.landFish();
      return;
    }

    // 超时保护：超过 40 秒自动放弃（防止卡住）
    if (f.elapsed > 40) {
      this.finish({ ok: false, reason: 'timeout' });
      return;
    }
    this._syncView();
  }

  /** 成功上鱼 */
  landFish() {
    const rod = this.rod;
    const pending = this.pendingCatch;
    if (!pending) return this.finish({ ok: false, reason: 'error' });
    const { species, roll } = pending;
    const item = makeItem('fish', species.id, {
      quality: roll.quality,
      weightKg: roll.weightKg,
      lengthCm: roll.lengthCm,
    });
    const value = itemValue(item);

    // 进背包；背包满 -> 鱼掉在脚下
    const added = this.state.give(item);
    if (!added) {
      const pos = this.opts.playerPos ? this.opts.playerPos() : { x: this.castFrom.x, y: 0, z: this.castFrom.z };
      this.state.dropItem(item, { x: pos.x + randRange(-1, 1), y: 0.2, z: pos.z + randRange(-1, 1) });
    }

    this.state.recordCatch(item, {
      spot: this.spot.id,
      rodId: rod ? rod.id : null,
      baitId: this.baitSnapshot,
      castPower: this.castPower,
    });

    this.emit('sound', { id: species.special ? 'special' : 'catch' });
    this.emit('fishing:landed', {
      item,
      species,
      value,
      quality: roll.quality,
      spot: this.spot,
      fightTime: this.fight ? this.fight.elapsed : 0,
    });
    this.finish({ ok: true, item, species, value });
  }

  finish(result) {
    this.result = result;
    this.resultT = 0;
    this.phase = FISHING_STATE.RESULT;
    if (!result.ok) {
      this.emit('fishing:failed', result);
      const msg = {
        lineBreak: '线绷断了！鱼带着你的钩跑了',
        escape: '张力没控住，鱼脱钩了',
        missed: null,
        giveup: '你收回了鱼竿',
        timeout: '僵持太久，鱼自己跑了',
        error: null,
      }[result.reason];
      if (msg) this.emit('toast', { text: msg, kind: 'warn' });
      if (result.reason === 'lineBreak' || result.reason === 'escape') this.emit('sound', { id: 'fail' });
    }
    this._syncView();
  }

  /* ------------------------------------------------------------------ *
   * 视图同步（给 UI / 世界渲染用）
   * ------------------------------------------------------------------ */

  _syncView() {
    const v = this.view;
    if (!v) return null;
    v.state = this.phase;
    v.power = this.charge;
    v.progress = this.fight ? this.fight.progress : 0;
    v.tension = this.fight ? clamp(this.fight.tension, 0, 1.2) : 0;
    v.fish = this.pendingCatch ? this.pendingCatch.species : null;
    v.spotId = this.spot ? this.spot.id : 'shore';
    v.hookDist = Math.hypot(this.hookPos.x - this.castFrom.x, this.hookPos.z - this.castFrom.z);
    v.hint = this.hintText();
    v.result = this.result;
    v.biteWindow = this.phase === FISHING_STATE.BITE ? this.biteT / TUNING.strikeWindow : 0;
    v.maxTier = this.rod ? this.maxTierAt(this.spot ? this.spot.id : 'shore') : 0;
    return v;
  }

  hintText() {
    switch (this.phase) {
      case FISHING_STATE.CHARGING:
        return '松开左键抛竿（按得越久抛得越远）';
      case FISHING_STATE.CASTING:
        return '抛竿中……';
      case FISHING_STATE.WAITING:
        return `等鱼上钩……（${this.spot ? this.spot.name : ''}）`;
      case FISHING_STATE.BITE:
        return '咬钩了！快按左键提竿！';
      case FISHING_STATE.FIGHT:
        return '按住左键收线，张力条变红就松开';
      case FISHING_STATE.RESULT:
        if (this.result && this.result.ok) {
          return `收获 ${itemName(this.result.item)}（约 §${this.result.value}）`;
        }
        return '鱼跑了……';
      default:
        return this.rodItem ? '左键蓄力抛竿' : '手上没有鱼竿';
    }
  }
}

/** 找离落点最近的钓点 */
export function nearestSpot(p) {
  let best = FISHING_SPOTS[0];
  let bestD = Infinity;
  for (const s of FISHING_SPOTS) {
    const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

export { MAX_TIER, GRILL };
