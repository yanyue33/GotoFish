/**
 * UI 层：HUD、物品栏、提示、以及各个面板（检视 / 统计 / 设置 / 商店 / 烤架 / 鱼池）。
 *
 * 设计取向：
 * - 游戏内 HUD 尽量少、贴着四角，中间永远留给画面。
 * - 面板用 DOM，方便排版、滚动和文字；3D 部分交给 WebGL。
 * - 物品图标用 icons.js 的离屏渲染结果（真的是那件东西的模型）。
 */

import { icons } from './icons.js';
import {
  itemName, itemValue, sellPrice, valueBreakdown, itemHunger, itemTier, kindOf,
  qualityById, QUALITIES, speciesOf, isEdible, ROD_BY_ID, BAIT_BY_ID, GRILL, cookStage,
  cookValueMultiplier, MAX_SLOTS, BASE_SLOTS,
} from '../data/items.js';
import { FISH, SEA_PRODUCTS, BAITS, MAX_TIER } from '../data/fish.js';
import { formatMoney, formatNumber, formatWeight, formatLength, formatDuration, formatTime } from '../core/format.js';
import { clamp } from '../core/rng.js';

const HOTBAR_SLOT_COUNT = MAX_SLOTS;

export class UI {
  /**
   * @param {object} ctx { state, settings, shop, grill, fishing, audio, emit, callbacks }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.settings = ctx.settings;
    this.shop = ctx.shop;
    this.grill = ctx.grill;
    this.fishing = ctx.fishing;
    this.audio = ctx.audio;
    this.emit = ctx.emit || (() => {});
    this.cb = ctx.callbacks || {};

    this.el = {
      hud: document.getElementById('hud'),
      money: document.getElementById('hud-money'),
      hungerBar: document.getElementById('hunger-fill'),
      hungerText: document.getElementById('hunger-text'),
      hungerWrap: document.getElementById('hunger'),
      hotbar: document.getElementById('hotbar'),
      bait: document.getElementById('hud-bait'),
      prompt: document.getElementById('prompt'),
      toast: document.getElementById('toast'),
      fishing: document.getElementById('fishing'),
      fishHint: document.getElementById('fish-hint'),
      powerWrap: document.getElementById('power-wrap'),
      powerFill: document.getElementById('power-fill'),
      fightWrap: document.getElementById('fight-wrap'),
      progressFill: document.getElementById('progress-fill'),
      tensionFill: document.getElementById('tension-fill'),
      tensionText: document.getElementById('tension-text'),
      spot: document.getElementById('hud-spot'),
      clock: document.getElementById('hud-clock'),
      fps: document.getElementById('hud-fps'),
      crosshair: document.getElementById('crosshair'),
      vignette: document.getElementById('vignette'),
      panels: document.getElementById('panels'),
      modal: document.getElementById('modal'),
      modalTitle: document.getElementById('modal-title'),
      modalBody: document.getElementById('modal-body'),
      modalFoot: document.getElementById('modal-foot'),
      inspect: document.getElementById('inspect'),
      inspectBody: document.getElementById('inspect-body'),
      promptKey: document.getElementById('prompt-key'),
      promptText: document.getElementById('prompt-text'),
      hintBar: document.getElementById('hint-bar'),
      starving: document.getElementById('starving'),
      notify: document.getElementById('notify'),
    };

    this.hotbarSlots = [];
    this.openPanel = null;
    this.inspectUid = null;
    this._toastTimer = null;
    this._lastHud = {};
    this._buildHotbar();
    this._bindButtons();
    this._applySettingsToDom();
  }

  /* ------------------------------------------------------------------ *
   * 构造
   * ------------------------------------------------------------------ */

  _buildHotbar() {
    const wrap = this.el.hotbar;
    wrap.innerHTML = '';
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.index = String(i);
      slot.innerHTML = `
        <span class="slot-key">${i + 1}</span>
        <div class="slot-icon"></div>
        <span class="slot-count"></span>
        <span class="slot-quality"></span>
      `;
      slot.addEventListener('click', () => {
        this.state.inventory.setHand(i);
        this.cb.onHandChanged?.();
        this._syncHotbar(true);
      });
      wrap.appendChild(slot);
      this.hotbarSlots.push(slot);
    }
  }

  _bindButtons() {
    // 1) 静态按钮（写在 index.html 上的）
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.audio?.play('uiClick');
        this.runAction(btn.dataset.action);
      });
    });
    // 2) 动态按钮（面板每次重绘都会重建 DOM，所以用事件委托最稳）
    this.el.modal?.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-action]');
      if (!btn) return;
      this.runAction(btn.dataset.action);
    });
    this.el.inspect?.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-action]');
      if (!btn) return;
      this.runAction(btn.dataset.action);
    });
  }

  /** 统一的动作分发：静态与动态按钮共用 */
  runAction(action) {
    if (!action) return;
    switch (action) {
      case 'close-modal':
        this.closeModal();
        break;
      case 'sell-held':
        this.cb.onSellHeld?.();
        break;
      case 'sell-all':
        this.cb.onSellAll?.();
        break;
      case 'eat-held':
        this.cb.onEatHeld?.();
        break;
      case 'drop-held':
        this.cb.onDropHeld?.();
        break;
      case 'inspect-held':
        this.cb.onInspectHeld?.();
        break;
      case 'save-game':
        this.cb.onSave?.();
        break;
      case 'reset-game':
        this.cb.onReset?.();
        break;
      default:
        break;
    }
  }

  _applySettingsToDom() {
    if (this.el.crosshair) this.el.crosshair.style.display = this.settings.get('crosshair') ? '' : 'none';
    if (this.el.fps) this.el.fps.style.display = this.settings.get('showFps') ? '' : 'none';
  }

  /* ------------------------------------------------------------------ *
   * HUD 同步
   * ------------------------------------------------------------------ */

  update(dt, extra = {}) {
    const s = this.state;
    const hud = this.el;

    // 钱 / 饱食度（有变化才写 DOM）
    const moneyText = formatMoney(s.money);
    if (this._lastHud.money !== moneyText) {
      hud.money.textContent = moneyText;
      this._lastHud.money = moneyText;
    }
    const hungerPct = Math.round(s.hunger);
    if (this._lastHud.hunger !== hungerPct) {
      hud.hungerBar.style.width = `${clamp(s.hunger, 0, 100)}%`;
      hud.hungerText.textContent = `${hungerPct}%`;
      hud.hungerWrap.classList.toggle('low', s.hunger < 25);
      hud.starving.style.display = s.hunger < 25 ? '' : 'none';
      this._lastHud.hunger = hungerPct;
    }

    // 时钟（dayTime 单位是分钟）
    const clockText = formatTime(s.dayTime * 60);
    if (this._lastHud.clock !== clockText) {
      hud.clock.textContent = clockText;
      hud.clock.classList.toggle('night', s.isNight);
      this._lastHud.clock = clockText;
    }
    if (extra.fps !== undefined && this.settings.get('showFps')) {
      hud.fps.textContent = `${extra.fps} FPS`;
    }

    this._syncBait();
    this._syncHotbar();
    this._syncFishing();
    this._syncPrompt(extra.interaction);

    // 打开的面板按帧刷新（商店/烤架/鱼池需要实时数值）
    if (this.openPanel) this._refreshPanel();
  }

  _syncBait() {
    const b = this.state.inventory.bait;
    const el = this.el.bait;
    if (!b) {
      if (this._lastHud.bait !== 'none') {
        el.innerHTML = `<span class="bait-icon">✕</span><span class="bait-name">没有鱼饵</span>`;
        el.classList.add('empty');
        this._lastHud.bait = 'none';
      }
      return;
    }
    const def = BAIT_BY_ID.get(b.speciesId);
    const key = `${b.speciesId}:${b.count}`;
    if (this._lastHud.bait === key) return;
    this._lastHud.bait = key;
    el.classList.remove('empty');
    el.innerHTML = `
      <span class="bait-icon">${b.count}</span>
      <span class="bait-name">${def ? def.name : b.speciesId}</span>
      <span class="bait-tier">${def ? `T${def.tier}` : ''}</span>
    `;
  }

  _syncHotbar(force = false) {
    const inv = this.state.inventory;
    for (let i = 0; i < this.hotbarSlots.length; i++) {
      const slot = this.hotbarSlots[i];
      const item = inv.items[i];
      const locked = i >= inv.slots;
      slot.classList.toggle('locked', locked);
      slot.classList.toggle('active', i === inv.hand && !locked);
      const iconEl = slot.querySelector('.slot-icon');
      const countEl = slot.querySelector('.slot-count');
      const qEl = slot.querySelector('.slot-quality');
      const sig = item ? `${item.uid}:${item.kind}:${item.speciesId}:${item.cookStage || ''}` : 'empty';
      if (slot.dataset.sig !== sig || force) {
        slot.dataset.sig = sig;
        if (!item) {
          iconEl.style.backgroundImage = '';
          iconEl.textContent = locked ? '🔒' : '';
          countEl.textContent = '';
          qEl.textContent = '';
          slot.classList.remove('q0', 'q1', 'q2', 'q3', 'q4');
        } else {
          const url = icons().get(item);
          iconEl.textContent = url ? '' : shortLabel(item);
          iconEl.style.backgroundImage = url ? `url(${url})` : '';
          const kind = kindOf(item);
          countEl.textContent = kind === 'bait' && item.count > 1 ? `×${item.count}` : '';
          const q = qualityById(item.quality);
          qEl.textContent = q.name;
          slot.classList.remove('q0', 'q1', 'q2', 'q3', 'q4');
          slot.classList.add(`q${item.quality}`);
        }
      }
    }
  }

  _syncFishing() {
    const v = this.fishing ? this.fishing.view : null;
    const hud = this.el;
    if (!v || v.state === 'idle') {
      hud.fishing.classList.add('hidden');
      hud.fishHint.textContent = '';
      hud.spot.textContent = '';
      this._lastHud.fishState = 'idle';
      return;
    }
    if (this._lastHud.fishState !== v.state) {
      hud.fishing.classList.remove('hidden');
      this._lastHud.fishState = v.state;
    }
    hud.fishHint.textContent = v.hint || '';
    hud.spot.textContent = this.fishing.spot ? `钓点：${this.fishing.spot.name} · 上限 T${v.maxTier}` : '';

    // 蓄力条
    const showPower = v.state === 'charging' || v.state === 'casting';
    hud.powerWrap.classList.toggle('hidden', !showPower);
    if (showPower) hud.powerFill.style.width = `${Math.round(v.power * 100)}%`;

    // 搏斗面板
    const showFight = v.state === 'fight' || v.state === 'bite';
    hud.fightWrap.classList.toggle('hidden', !showFight);
    if (showFight) {
      hud.progressFill.style.width = `${Math.round(v.progress * 100)}%`;
      const t = clamp(v.tension, 0, 1.2);
      hud.tensionFill.style.width = `${Math.round(t * 100)}%`;
      hud.tensionFill.classList.toggle('warn', t > 0.72);
      hud.tensionFill.classList.toggle('danger', t > 1.0);
      hud.tensionText.textContent = this.settings.get('showTensionNumbers') ? t.toFixed(2) : '';
      hud.fightWrap.classList.toggle('bite', v.state === 'bite');
      if (v.state === 'bite') {
        hud.fishHint.textContent = '咬钩了！快按左键提竿！';
      }
    }
  }

  _syncPrompt(interaction) {
    const el = this.el.prompt;
    if (!interaction) {
      if (this._lastHud.prompt !== null) {
        el.classList.add('hidden');
        this._lastHud.prompt = null;
      }
      return;
    }
    const sig = `${interaction.key}:${interaction.text}`;
    if (this._lastHud.prompt === sig) return;
    this._lastHud.prompt = sig;
    this.el.promptKey.textContent = interaction.key || 'E';
    this.el.promptText.textContent = interaction.text;
    el.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ *
   * 提示 / 通知
   * ------------------------------------------------------------------ */

  toast(text, kind = 'info') {
    const el = this.el.toast;
    const item = document.createElement('div');
    item.className = `toast-item ${kind}`;
    item.textContent = text;
    el.appendChild(item);
    setTimeout(() => {
      item.classList.add('out');
      setTimeout(() => item.remove(), 400);
    }, 2400);
    while (el.children.length > 5) el.firstChild.remove();
  }

  /** 屏幕中央的大通知（稀有鱼、升级） */
  notify(title, subtitle = '', kind = 'good') {
    const el = this.el.notify;
    el.innerHTML = `<div class="notify-title">${title}</div>${subtitle ? `<div class="notify-sub">${subtitle}</div>` : ''}`;
    el.className = `notify show ${kind}`;
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------------ *
   * 面板框架
   * ------------------------------------------------------------------ */

  isPanelOpen() {
    return !!this.openPanel;
  }

  setPanel(name) {
    this.openPanel = name;
    if (!name) {
      this.el.modal.classList.add('hidden');
      return;
    }
    this.el.modal.classList.remove('hidden');
    this._renderPanel();
  }

  closeModal() {
    const was = this.openPanel;
    this.openPanel = null;
    this.el.modal.classList.add('hidden');
    this.audio?.play('uiClose');
    this.cb.onPanelClosed?.(was);
  }

  _renderPanel() {
    switch (this.openPanel) {
      case 'shop':
        this._renderShop();
        break;
      case 'grill':
        this._renderGrill();
        break;
      case 'pond':
        this._renderPond();
        break;
      case 'stats':
        this._renderStats();
        break;
      case 'settings':
        this._renderSettings();
        break;
      case 'fisher':
        this._renderFisher();
        break;
      case 'help':
        this._renderHelp();
        break;
      default:
        break;
    }
  }

  _refreshPanel() {
    // 商店/烤架需要跟着钱和火候实时刷
    if (['shop', 'grill', 'pond'].includes(this.openPanel)) {
      const now = performance.now();
      if (!this._lastRefresh || now - this._lastRefresh > 250) {
        this._lastRefresh = now;
        this._renderPanel();
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 商店
   * ------------------------------------------------------------------ */

  _renderShop() {
    const catalog = this.shop.catalog();
    const held = this.state.heldItem;
    const quote = this.shop.quoteHeld();
    this.el.modalTitle.textContent = `老陈的杂货铺 — ${formatMoney(this.state.money)}`;

    const rodRows = catalog.filter((c) => c.kind === 'rod').map((c) => `
      <div class="card ${c.owned ? 'owned' : ''} ${c.affordable ? '' : 'poor'}">
        <div class="card-head">
          <span class="card-name">${c.name}</span>
          <span class="tag tier">T${c.tier}</span>
        </div>
        <div class="card-desc">${c.desc}</div>
        <div class="card-stats">
          <span>力度 ${c.stats.power.toFixed(2)}</span>
          <span>线强 ${c.stats.lineStr.toFixed(2)}</span>
          <span>稀有 +${Math.round((c.stats.rare - 1) * 100)}%</span>
        </div>
        <div class="card-foot">
          <span class="price">${c.owned ? '已拥有' : formatMoney(c.price)}</span>
          <button class="btn" data-buy="${c.key}" ${c.owned || !c.affordable ? 'disabled' : ''}>
            ${c.owned ? '已购买' : '购买'}
          </button>
        </div>
      </div>`).join('');

    const baitRows = catalog.filter((c) => c.kind === 'bait').map((c) => `
      <div class="card ${c.affordable ? '' : 'poor'}">
        <div class="card-head">
          <span class="card-name">${c.name} ×${c.bundle}</span>
          <span class="tag tier">T${c.tier}</span>
        </div>
        <div class="card-desc">${c.desc}</div>
        <div class="card-foot">
          <span class="price">${formatMoney(c.price)}</span>
          <button class="btn" data-buy="${c.key}" ${c.affordable ? '' : 'disabled'}>购买</button>
        </div>
      </div>`).join('');

    const up = catalog.find((c) => c.kind === 'upgrade');
    const upRow = up ? `
      <div class="card wide ${up.affordable ? '' : 'poor'}">
        <div class="card-head"><span class="card-name">${up.name}</span></div>
        <div class="card-desc">${up.desc}</div>
        <div class="card-foot">
          <span class="price">${up.price ? formatMoney(up.price) : '—'}</span>
          <button class="btn" data-buy="${up.key}" ${!up.price || !up.affordable ? 'disabled' : ''}>扩容</button>
        </div>
      </div>` : '';

    this.el.modalBody.innerHTML = `
      <div class="tabs">
        <div class="tab-col">
          <h3>钓竿</h3>
          <div class="cards">${rodRows}</div>
        </div>
        <div class="tab-col">
          <h3>鱼饵</h3>
          <div class="cards">${baitRows}</div>
          <h3>其它</h3>
          <div class="cards">${upRow}</div>
        </div>
      </div>
      <div class="sellbar">
        <div class="sell-info">
          ${quote
            ? `手上：<b>${quote.name}</b>（品质 ${qualityById(held.quality).name}）<br>
               <span class="dim">参考价值 ${formatMoney(quote.full)} · 老板出价 <b class="good">${formatMoney(quote.price)}</b></span>`
            : '<span class="dim">把手上的东西拿给老板就能卖（先在物品栏选中它）</span>'}
        </div>
        <div class="sell-actions">
          <button class="btn good" data-action="sell-held" ${quote ? '' : 'disabled'}>卖出手上物品</button>
          <button class="btn" data-action="sell-all">全部卖出</button>
        </div>
      </div>
    `;

    this.el.modalFoot.innerHTML = `<span class="dim">提示：稀有鱼与高价鱼卖出前会再确认一次。</span><button class="btn ghost" data-action="close-modal">离开 (E)</button>`;

    this.el.modalBody.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const res = this.shop.buy(btn.dataset.buy);
        if (res.ok) {
          this.audio?.play('coin');
          this._renderShop();
        } else {
          this.audio?.play('fail');
        }
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 烧烤架
   * ------------------------------------------------------------------ */

  _renderGrill() {
    const lit = this.grill.isLit;
    const fuelPct = clamp(this.state.grillFuel / GRILL.duration, 0, 1);
    this.el.modalTitle.textContent = '烧烤架 · 阿炭';
    const held = this.state.heldItem;
    const canCook = held && (kindOf(held) === 'fish' || kindOf(held) === 'sea');

    const slots = this.grill.views().map((v, i) => {
      if (!v) {
        return `<div class="grill-slot empty"><span class="dim">空位</span></div>`;
      }
      const stageColor = GRILL.stageColor[v.stage.key] || '#fff';
      const pct = clamp(v.t / GRILL.maxCookTime, 0, 1) * 100;
      return `
        <div class="grill-slot ${v.ready ? 'ready' : ''} ${v.burning ? 'burning' : ''}">
          <div class="grill-icon" style="background-image:url(${icons().get(v.item)})"></div>
          <div class="grill-name">${v.name}</div>
          <div class="grill-stage" style="color:${stageColor}">${v.stage.name}</div>
          <div class="cookbar"><div class="cookbar-fill" style="width:${pct}%;background:${stageColor}"></div></div>
          <div class="grill-meta">
            <span>x${v.mult.toFixed(2)}</span>
            <span>${formatMoney(v.value)}</span>
          </div>
          <div class="grill-warn">${v.burning ? (v.timeToCharcoal > 0 ? `${Math.ceil(v.timeToCharcoal)} 秒后成焦炭！` : '已经是焦炭了') : ''}</div>
          <button class="btn small" data-take="${i}">取下 (E)</button>
        </div>`;
    }).join('');

    this.el.modalBody.innerHTML = `
      <div class="grill-top">
        <div class="fuel">
          <span>火候燃料</span>
          <div class="cookbar wide"><div class="cookbar-fill fire" style="width:${fuelPct * 100}%"></div></div>
          <span>${lit ? `${Math.ceil(this.state.grillFuel)} 秒` : '已熄灭'}</span>
        </div>
        <button class="btn ${lit ? 'ghost' : 'good'}" data-action="ignite" ${lit ? 'disabled' : ''}>
          ${lit ? '火还在烧' : `点火 (${formatMoney(GRILL.igniteCost)})`}
        </button>
      </div>
      <div class="grill-slots">${slots}</div>
      <div class="grill-bottom">
        <div class="sell-info">
          ${canCook
            ? `手上：<b>${itemName(held)}</b><br><span class="dim">放上去烤吧，别烤糊了。</span>`
            : '<span class="dim">手上没有能烤的东西（选中鱼或海产品）</span>'}
        </div>
        <div class="sell-actions">
          <button class="btn good" data-action="puton" ${canCook && lit ? '' : 'disabled'}>放上烤架</button>
          <button class="btn" data-action="takeall">全部取下</button>
        </div>
      </div>
      <p class="dim small">火候：8 秒半熟 → 18 秒刚好好（价值最高）→ 34 秒偏老 → 48 秒开始烤焦 → 78 秒成焦炭。</p>
    `;
    this.el.modalFoot.innerHTML = `<button class="btn ghost" data-action="close-modal">离开 (E)</button>`;

    this.el.modalBody.querySelector('[data-action="ignite"]')?.addEventListener('click', () => {
      this.grill.ignite();
      this.audio?.play('fire');
      this._renderGrill();
    });
    this.el.modalBody.querySelector('[data-action="puton"]')?.addEventListener('click', () => {
      const r = this.grill.putOn();
      if (r.ok) this.audio?.play('sizzle');
      this._renderGrill();
    });
    this.el.modalBody.querySelector('[data-action="takeall"]')?.addEventListener('click', () => {
      this.grill.takeAll();
      this._renderGrill();
    });
    this.el.modalBody.querySelectorAll('[data-take]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = this.grill.takeOff(Number(btn.dataset.take));
        if (r.ok) this.audio?.play('pickup');
        this._renderGrill();
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 鱼池
   * ------------------------------------------------------------------ */

  _renderPond() {
    this.el.modalTitle.textContent = `观赏鱼池（${this.state.pond.length}/${60}）`;
    const list = this.state.pond;
    const held = this.state.heldItem;
    const canPut = held && (kindOf(held) === 'fish' || kindOf(held) === 'cooked');
    const rows = list.length
      ? list.map((p) => {
          const sp = speciesOf('fish', p.speciesId);
          return `
            <div class="card pond-card">
              <div class="card-head">
                <span class="card-name">${p.name}${sp?.special ? ' <span class="tag special">稀有</span>' : ''}</span>
                <span class="tag tier">T${p.tier}</span>
              </div>
              <div class="card-stats">
                <span style="color:${qualityById(p.quality).color}">${qualityById(p.quality).name}</span>
                <span>${formatWeight(p.weightKg)}</span>
                <span>${formatLength(p.lengthCm)}</span>
                <span class="good">${formatMoney(p.value)}</span>
              </div>
              <div class="card-foot">
                <button class="btn small" data-pondback="${p.uid}">拿回背包</button>
                <button class="btn small good" data-pondsell="${p.uid}">卖掉</button>
              </div>
            </div>`;
        }).join('')
      : '<p class="dim">池子里还没有鱼。钓到不想要的鱼可以放进来观赏，也能随时捞出来卖掉。</p>';

    this.el.modalBody.innerHTML = `
      <div class="sellbar">
        <div class="sell-info">
          ${canPut ? `手上：<b>${itemName(held)}</b>` : '<span class="dim">手上没有可以放进去的鱼</span>'}
        </div>
        <div class="sell-actions">
          <button class="btn good" data-action="pondadd" ${canPut ? '' : 'disabled'}>放进鱼池</button>
        </div>
      </div>
      <div class="pond-grid">${rows}</div>
    `;
    this.el.modalFoot.innerHTML = `<button class="btn ghost" data-action="close-modal">离开 (E)</button>`;
    this.el.modalBody.querySelector('[data-action="pondadd"]')?.addEventListener('click', () => {
      const r = this.state.addToPond();
      if (r.ok) {
        this.audio?.play('splash');
        this.syncPond();
      }
      this._renderPond();
    });
    this.el.modalBody.querySelectorAll('[data-pondback]').forEach((b) =>
      b.addEventListener('click', () => {
        this.state.pondTake(b.dataset.pondback);
        this.syncPond();
        this._renderPond();
      })
    );
    this.el.modalBody.querySelectorAll('[data-pondsell]').forEach((b) =>
      b.addEventListener('click', () => {
        this.state.pondSell(b.dataset.pondsell);
        this.audio?.play('coin');
        this.syncPond();
        this._renderPond();
      })
    );
  }

  /** 由 game.js 提供：鱼池里有变动时把 3D 同步一下 */
  syncPond() {
    this.cb.onPondChanged?.();
  }

  /* ------------------------------------------------------------------ *
   * 统计面板（V 键）
   * ------------------------------------------------------------------ */

  _renderStats() {
    const s = this.state.summary();
    this.el.modalTitle.textContent = '统计面板';

    const tierRows = [];
    for (let t = 1; t <= MAX_TIER; t++) {
      const n = s.byTier[t] || 0;
      const max = Math.max(1, ...Object.values(s.byTier));
      tierRows.push(`
        <div class="stat-row">
          <span class="stat-label">T${t} 鱼获</span>
          <div class="stat-bar"><div class="stat-bar-fill" style="width:${(n / max) * 100}%"></div></div>
          <span class="stat-value">${n}</span>
        </div>`);
    }

    const speciesRows = Object.entries(s.bySpecies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([id, n]) => {
        const sp = speciesOf('fish', id) || speciesOf('sea', id);
        if (!sp) return '';
        const caught = this.state.caughtSpecies.has(id);
        return `<div class="species-row">
          <span class="species-name ${sp.special ? 'special' : ''}">${caught ? sp.name : '？？？'}</span>
          <span class="tag tier">T${sp.tier}</span>
          <span class="species-count">×${n}</span>
        </div>`;
      }).join('');

    const recent = s.recent.map((e) => `
      <tr>
        <td>${formatTime(e.t)}</td>
        <td>${e.special ? '★ ' : ''}${e.name}</td>
        <td style="color:${qualityById(e.quality).color}">${e.qualityName}</td>
        <td>${formatWeight(e.weightKg)}</td>
        <td>${formatLength(e.lengthCm)}</td>
        <td class="good">${formatMoney(e.value)}</td>
        <td class="dim">${spotName(e.spot)}</td>
      </tr>`).join('');

    this.el.modalBody.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-title">持有金钱</span><span class="stat-big">${formatMoney(s.money)}</span></div>
        <div class="stat-card"><span class="stat-title">累计收入</span><span class="stat-big">${formatMoney(s.totalEarned)}</span></div>
        <div class="stat-card"><span class="stat-title">累计支出</span><span class="stat-big">${formatMoney(s.totalSpent)}</span></div>
        <div class="stat-card"><span class="stat-title">钓鱼次数</span><span class="stat-big">${s.casts}</span></div>
        <div class="stat-card"><span class="stat-title">上鱼数</span><span class="stat-big">${s.fishCaught}</span></div>
        <div class="stat-card"><span class="stat-title">跑鱼数</span><span class="stat-big">${s.lineBroken + s.bitesMissed}</span></div>
        <div class="stat-card"><span class="stat-title">海产品拾取</span><span class="stat-big">${s.seaPicked}</span></div>
        <div class="stat-card"><span class="stat-title">稀有鱼</span><span class="stat-big good">${s.specialCaught}</span></div>
        <div class="stat-card"><span class="stat-title">单条最重</span><span class="stat-big">${formatWeight(s.bestWeightKg)}</span><span class="dim">${s.bestWeightName || '—'}</span></div>
        <div class="stat-card"><span class="stat-title">单条最贵</span><span class="stat-big">${formatMoney(s.bestValue)}</span><span class="dim">${s.bestValueName || '—'}</span></div>
        <div class="stat-card"><span class="stat-title">平均价值</span><span class="stat-big">${formatMoney(s.avgValue)}</span></div>
        <div class="stat-card"><span class="stat-title">游戏时长</span><span class="stat-big">${formatDuration(s.playTime)}</span></div>
      </div>
      <h3>等级分布</h3>
      <div class="stat-rows">${tierRows.join('')}</div>
      <h3>图鉴（${this.state.caughtSpecies.size}/${FISH.length + SEA_PRODUCTS.length}）</h3>
      <div class="species-grid">${speciesRows || '<p class="dim">还没有记录，先去钓鱼吧。</p>'}</div>
      <h3>最近渔获</h3>
      <div class="table-wrap">
        <table class="log-table">
          <thead><tr><th>时间</th><th>名称</th><th>品质</th><th>重量</th><th>尺寸</th><th>价值</th><th>钓点</th></tr></thead>
          <tbody>${recent || '<tr><td colspan="7" class="dim">还没有渔获记录</td></tr>'}</tbody>
        </table>
      </div>
    `;
    this.el.modalFoot.innerHTML = `<button class="btn ghost" data-action="close-modal">关闭 (V)</button>`;
  }

  /* ------------------------------------------------------------------ *
   * 设置面板
   * ------------------------------------------------------------------ */

  _renderSettings() {
    const s = this.settings.values;
    this.el.modalTitle.textContent = '设置';
    const slider = (key, label, min, max, step, fmt = (v) => v) => `
      <div class="set-row">
        <label>${label}</label>
        <input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}">
        <span class="set-val" data-val="${key}">${fmt(s[key])}</span>
      </div>`;
    const toggle = (key, label) => `
      <div class="set-row">
        <label>${label}</label>
        <button class="toggle ${s[key] ? 'on' : ''}" data-toggle="${key}">${s[key] ? '开启' : '关闭'}</button>
      </div>`;

    this.el.modalBody.innerHTML = `
      <h3>操作</h3>
      ${slider('sensitivity', '鼠标灵敏度', 0.1, 3, 0.05, (v) => Number(v).toFixed(2))}
      ${slider('fov', '视野范围 (FOV)', 55, 105, 1, (v) => `${v}°`)}
      ${toggle('invertY', '垂直视角反转')}
      ${toggle('crosshair', '显示准星')}
      ${toggle('headBob', '走路视角起伏')}
      ${toggle('screenShake', '屏幕震动')}
      ${toggle('showTensionNumbers', '张力条显示数值')}
      ${toggle('castAssist', '抛竿辅助落点')}
      <h3>画质</h3>
      <div class="set-row">
        <label>画质档位</label>
        <div class="quality-btns">
          ${['low', 'medium', 'high'].map((q) => `
            <button class="btn ${s.quality === q ? 'good' : ''}" data-quality="${q}">
              ${q === 'low' ? '流畅' : q === 'medium' ? '均衡' : '精细'}
            </button>`).join('')}
        </div>
      </div>
      ${toggle('showFps', '显示帧率')}
      <h3>声音</h3>
      ${slider('masterVolume', '总音量', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      ${slider('sfxVolume', '音效音量', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      ${slider('ambienceVolume', '环境音量（海浪）', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      <h3>存档</h3>
      <div class="set-row">
        <label>当前进度</label>
        <div class="quality-btns">
          <button class="btn" data-action="save-game">保存进度</button>
          <button class="btn" data-action="reset-game">重开新档</button>
        </div>
      </div>
      <p class="dim small">进度会自动保存到浏览器本地存储，关掉网页再回来可以继续。</p>
    `;
    this.el.modalFoot.innerHTML = `<button class="btn ghost" data-action="close-modal">关闭</button>`;

    this.el.modalBody.querySelectorAll('input[type=range]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.set;
        const v = Number(input.value);
        this.settings.set(key, v);
        const out = this.el.modalBody.querySelector(`[data-val="${key}"]`);
        if (out) {
          out.textContent = key === 'fov' ? `${v}°`
            : key === 'sensitivity' ? v.toFixed(2)
            : `${Math.round(v * 100)}%`;
        }
        this.cb.onSettingsChanged?.(key, v);
      });
    });
    this.el.modalBody.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.toggle;
        const nv = !this.settings.get(key);
        this.settings.set(key, nv);
        btn.classList.toggle('on', nv);
        btn.textContent = nv ? '开启' : '关闭';
        this._applySettingsToDom();
        this.cb.onSettingsChanged?.(key, nv);
      });
    });
    this.el.modalBody.querySelectorAll('[data-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.settings.set('quality', btn.dataset.quality);
        this._renderSettings();
        this.cb.onSettingsChanged?.('quality', btn.dataset.quality);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 老渔夫的教学 / 提示面板
   * ------------------------------------------------------------------ */

  _renderFisher() {
    const hasRod = this.state.inventory.items.some((it) => it && it.kind === 'rod');
    const hasBait = !!this.state.inventory.bait;
    const tips = [];
    if (!hasRod) tips.push('你手上还没有鱼竿。先在海滩上捡些贝壳海螺，卖给商店老板换钱，再买一根竹制手竿。');
    else tips.push('有竿了。别忘了配鱼饵，选中鱼竿后按住左键蓄力，松开就抛出去。');
    if (!hasBait) tips.push('没有鱼饵的话，商店里有沙蚕卖，很便宜。');
    tips.push('抛得越远水越深，能钓到的鱼等级越高。栈桥尽头是个好位置。');
    tips.push('鱼咬钩之后左键提竿，然后按住左键收线。下面的张力条变红就松手，绷太久会断线。');
    tips.push('钓上来的小鱼可以自己烤了吃，填饱肚子；好鱼留着卖钱。');
    tips.push('钓到不想要的鱼，可以放到岛中央的鱼池里养着观赏。');

    this.el.modalTitle.textContent = '老渔夫 阿海';
    this.el.modalBody.innerHTML = `
      <div class="dialog">
        <p class="dim">「小伙子，看你这身打扮，是来岛上讨生活的吧？听我几句。」</p>
        <ul class="tips">${tips.map((t) => `<li>${t}</li>`).join('')}</ul>
        <div class="keyhelp">
          <h3>按键一览</h3>
          <div class="keys">
            <div><kbd>W A S D</kbd> 移动</div>
            <div><kbd>Shift</kbd> 冲刺</div>
            <div><kbd>鼠标</kbd> 视角</div>
            <div><kbd>滚轮 / 1~9</kbd> 切换手持物品</div>
            <div><kbd>左键</kbd> 抛竿 / 提竿 / 收线 / 进食</div>
            <div><kbd>右键</kbd> 快速收竿</div>
            <div><kbd>E</kbd> 交互（购买 / 卖出 / 捡起 / 点火）</div>
            <div><kbd>X</kbd> 放下手持物品</div>
            <div><kbd>B</kbd> 切换鱼饵</div>
            <div><kbd>F</kbd> 检视物品</div>
            <div><kbd>V</kbd> 统计面板</div>
            <div><kbd>C</kbd> 切换第一/第三人称</div>
            <div><kbd>Esc</kbd> 设置 / 暂停</div>
          </div>
        </div>
      </div>
    `;
    this.el.modalFoot.innerHTML = `<button class="btn ghost" data-action="close-modal">知道了</button>`;
  }

  _renderHelp() {
    this._renderFisher();
  }

  /* ------------------------------------------------------------------ *
   * 检视面板（F 键）
   * ------------------------------------------------------------------ */

  inspect(item) {
    if (!item) {
      this.toast('手上没有东西可以检视', 'warn');
      return;
    }
    const el = this.el.inspect;
    const kind = kindOf(item);
    const sp = speciesOf(kind, item.speciesId);
    const q = qualityById(item.quality);
    const bd = valueBreakdown(item);
    const tier = itemTier(item);
    const cooked = kind === 'cooked';
    const stage = cooked ? cookStage(Math.max(0, item.cookT || 0)) : null;

    const rows = [];
    if (bd && sp) {
      rows.push(row('基础价值', formatMoney(bd.base)));
      rows.push(row('品质倍率', `${q.name} ×${bd.quality.multiplier.toFixed(2)}`, q.color));
      rows.push(row('重量系数', `×${bd.weight.toFixed(2)}`, null, formatWeight(item.weightKg)));
      rows.push(row('体型系数', `×${bd.size.toFixed(2)}`, null, formatLength(item.lengthCm)));
      rows.push(row('等级系数', `×${bd.tierMult.toFixed(2)}`, null, `T${tier}`));
      if (cooked) rows.push(row('火候倍率', `×${bd.cook.toFixed(2)}`, GRILL.stageColor[item.cookStage || 'raw'], stage ? stage.name : ''));
      rows.push(row('最终价值', formatMoney(itemValue(item)), 'var(--good)'));
      if (sp.special) rows.push(row('稀有度', '★ 特殊鱼（同级稀有）', 'var(--gold)'));
    }

    el.querySelector('#inspect-title').textContent = itemName(item);
    el.querySelector('#inspect-icon').style.backgroundImage = `url(${icons().get(item)})`;
    el.querySelector('#inspect-sub').innerHTML =
      `<span style="color:${q.color}">${q.name}</span> · T${tier}${sp?.special ? ' · <span class="gold">稀有</span>' : ''}`;
    el.querySelector('#inspect-desc').textContent = sp?.desc || '';
    el.querySelector('#inspect-rows').innerHTML = rows.join('');
    el.querySelector('#inspect-actions').innerHTML = `
      ${isEdible(item) ? `<button class="btn good" data-inspect-act="eat">吃掉（饱食度 +${itemHunger(item)}）</button>` : ''}
      ${kind === 'fish' || kind === 'cooked' ? '<button class="btn" data-inspect-act="pond">放进鱼池</button>' : ''}
      <button class="btn" data-inspect-act="drop">放到地上</button>
      <button class="btn ghost" data-inspect-act="close">关闭 (F)</button>
    `;
    el.querySelector('#inspect-actions').querySelectorAll('[data-inspect-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.inspectAct;
        if (act === 'eat') this.cb.onEatHeld?.();
        if (act === 'pond') this.cb.onPondHeld?.();
        if (act === 'drop') this.cb.onDropHeld?.();
        if (act === 'close') this.closeInspect();
        this.closeInspect();
      });
    });
    el.classList.remove('hidden');
    this.inspectUid = item.uid;
    this.audio?.play('uiOpen');
  }

  closeInspect() {
    this.el.inspect.classList.add('hidden');
    this.inspectUid = null;
  }

  isInspecting() {
    return !this.el.inspect.classList.contains('hidden');
  }

  /** 手持物品换了 -> 检视面板跟着切 */
  refreshInspect() {
    if (!this.isInspecting()) return;
    const held = this.state.heldItem;
    if (!held) {
      this.closeInspect();
      return;
    }
    if (held.uid !== this.inspectUid) this.inspect(held);
  }

  /** 供底部操作提示条使用 */
  setHintBar(text) {
    if (this._lastHud.hint === text) return;
    this._lastHud.hint = text;
    this.el.hintBar.textContent = text || '';
  }
}

function row(label, value, color = null, extra = null) {
  return `<div class="inspect-row">
    <span class="ir-label">${label}</span>
    <span class="ir-value" ${color ? `style="color:${color}"` : ''}>${value}${extra ? ` <span class="dim">${extra}</span>` : ''}</span>
  </div>`;
}

function shortLabel(item) {
  const n = itemName(item);
  return n.slice(0, 2);
}

function spotName(id) {
  return { shore: '近岸', pier: '栈桥', boat: '外海' }[id] || id || '';
}
