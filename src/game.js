/**
 * 游戏主控：把渲染、世界、玩家、各系统、UI 串起来。
 */

import * as THREE from 'three';
import { GameState, safeLocalStorage, HUNGER_MAX } from './core/state.js';
import { Settings } from './core/settings.js';
import { Emitter } from './core/emitter.js';
import { clamp, rand, randRange, chance, makeSeededRandom } from './core/rng.js';
import { AudioSystem } from './systems/audio.js';
import { FishingSystem, FISHING_STATE } from './systems/fishing.js';
import { ShopSystem } from './systems/shop.js';
import { GrillSystem } from './systems/grill.js';
import { UI } from './ui/ui.js';
import { icons } from './ui/icons.js';
import { World, WATER_Y } from './world/world.js';
import { PlayerController } from './player/controller.js';
import {
  buildItemModel, buildHandRod, buildSeaProduct, buildFish, MAT, buildPlayer,
  meshFromParts, part, lighten, darken,
} from './world/models.js';
import {
  SEA_PRODUCTS, FISHING_SPOTS, makeItem, itemName, kindOf, speciesOf, RODS, BAITS,
  ROD_BY_ID, BAIT_BY_ID, makeBait, makeRod, itemValue, sellPrice, isEdible,
  MAX_SLOTS,
} from './data/items.js';
import { rollSeaInstance } from './data/fish.js';

export class Game {
  constructor() {
    this.bus = new Emitter();
    this.storage = safeLocalStorage();
    this.settings = new Settings(this.storage, (k) => this.onSettingsChanged(k));
    this.audio = new AudioSystem(this.settings);

    this.canvas = document.getElementById('game-canvas');
    this.initRenderer();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.settings.get('fov'),
      window.innerWidth / window.innerHeight,
      0.1,
      this.quality.drawDistance * 2.2
    );

    // 状态：有存档就读取
    this.state = GameState.load(this.storage, { seed: Math.floor(Math.random() * 1e9) });
    this.world = new World(this.scene, {
      quality: this.quality,
      settings: this.settings,
      state: this.state,
      emit: (t, p) => this.bus.emit(t, p),
    });

    this.player = new PlayerController(this.camera, {
      world: this.world,
      state: this.state,
      settings: this.settings,
      audio: this.audio,
      emit: (t, p) => this.bus.emit(t, p),
    });
    this.scene.add(this.player.rig);
    this.player.attach(this.canvas);
    this.player.inputBlocked = () => this.ui?.isPanelOpen() || this.ui?.isInspecting() || this.paused;

    this.fishing = new FishingSystem(this.state, {
      playerPos: () => this.player.position,
    });
    this.shop = new ShopSystem(this.state);
    this.grill = new GrillSystem(this.state);

    this.ui = new UI({      state: this.state,
      settings: this.settings,
      shop: this.shop,
      grill: this.grill,
      fishing: this.fishing,
      audio: this.audio,
      emit: (t, p) => this.bus.emit(t, p),
      callbacks: {
        onHandChanged: () => this.onHandChanged(),
        onSellHeld: () => this.sellHeld(),
        onSellAll: () => this.sellAll(),
        onSellSlot: (i) => this.shop.sellSlot(i),
        onEatHeld: () => this.eatHeld(),
        onDropHeld: () => this.dropHeld(),
        onInspectHeld: () => this.ui.inspect(this.state.heldItem),
        onPondHeld: () => this.pondPutHeld(),
        onPondChanged: () => this.world.syncPond(),
        onSave: () => this.save(),
        onReset: () => this.confirmReset(),
        onPanelClosed: () => this.onPanelClosed(),
        onSettingsChanged: (k, v) => this.onSettingsChanged(k, v),
      },
    });

    this._buildFishingVisuals();
    this._bindEvents();
    this._ensureShopGoods();
    this._spawnInitialWorldItems();

    this.paused = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.fpsSamples = [];
    this.fps = 0;
    this.autoSaveTimer = 0;
    this.seaSpawnTimer = 2;
    this.gameTime = 0;
    this.interaction = null;
    this._pendingConfirm = null;

    this.onHandChanged();
    this.world.syncPond();
    this.applyQuality();

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('beforeunload', () => this.save(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save(true);
    });

    this.showStartOverlay();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  initRenderer() {
    const preset = this.settings.preset;
    this.quality = preset;
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = preset.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.info.autoReset = true;
    if ('setAnimationLoop' in renderer) renderer.setAnimationLoop(null);
    this.renderer = renderer;
  }

  /** 画质变更需要重建渲染器 / 世界 */
  applyQuality() {
    const preset = this.settings.preset;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
    this.renderer.shadowMap.enabled = preset.shadows;
    this.camera.far = preset.drawDistance * 2.2;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog) {
      this.scene.fog.far = preset.drawDistance * 1.5;
    }
  }

  _buildFishingVisuals() {
    // 鱼线：一条动态更新的线段
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 24), 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = new THREE.LineBasicMaterial({ color: '#e8f4ff', transparent: true, opacity: 0.75 });
    this.fishingLine = new THREE.Line(lineGeo, lineMat);
    this.fishingLine.frustumCulled = false;
    this.scene.add(this.fishingLine);

    // 浮标
    const floatParts = [
      part('sphere', { r: 0.14, seg: 7, rings: 5 }, '#e8483c', {}),
      part('sphere', { r: 0.11, seg: 7, rings: 5 }, '#f4f4f4', { y: -0.16 }),
      part('cyl', { rt: 0.02, rb: 0.02, h: 0.3, seg: 4 }, '#333', { y: 0.22 }),
    ];
    this.bobber = meshFromParts(floatParts);
    this.bobber.visible = false;
    this.scene.add(this.bobber);

    // 落点提示圈
    const ringGeo = new THREE.RingGeometry(0.9, 1.15, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.castRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, side: THREE.DoubleSide })
    );
    this.castRing.visible = false;
    this.scene.add(this.castRing);

    // 垂钓者手持竿（第一人称时可以看见）已经在 player.handSlot 里
  }

  _bindEvents() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (!this.player.locked) {
        this.audio.unlock();
        this.player.requestLock();
        return;
      }
      if (this.ui.isPanelOpen()) return;
      if (e.button === 0) {
        this.audio.unlock();
        this.onPrimaryDown();
      } else if (e.button === 2) {
        this.onSecondary();
      }
    });
    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.onPrimaryUp();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (this.ui.isPanelOpen()) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      this.state.inventory.cycleHandSkipEmpty(dir);
      this.onHandChanged();
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    // 系统事件 -> UI / 音效
    this.bus.on('toast', ({ text, kind }) => this.ui.toast(text, kind));
    this.bus.on('catch:special', (entry) => {
      this.ui.notify(`★ ${entry.name}！`, `${entry.qualityName} · ${entry.weightKg.toFixed(2)} kg · 约 ${Math.round(entry.value)} 元`, 'gold');
    });
    this.bus.on('sound', ({ id }) => this.audio.play(id));
    this.fishing.on('sound', ({ id }) => this.audio.play(id));
    this.fishing.on('toast', ({ text, kind }) => this.ui.toast(text, kind));
    this.fishing.on('fishing:cast', () => this.audio.play('cast'));
    this.fishing.on('fishing:landed', (res) => {
      this.audio.play('splash');
      this.ui.notify(itemName(res.item), `${res.item.weightKg.toFixed(2)} kg · 约 ${res.value} 元`, res.species.special ? 'gold' : 'good');
      this.world.syncPond();
    });
    this.fishing.on('fishing:failed', () => this.player.shake(0.12, 0.25));
    this.fishing.on('fishing:baitUsed', () => this.ui.toast('用掉了一个鱼饵', 'info'));
    this.grill.on('grill:ignited', () => {
      this.world.flame.visible = true;
    });

    // 状态事件
    this.state.on('money:changed', () => {
      // 钱变了就刷新商店里的可买状态
      if (this.ui.openPanel === 'shop') this.ui._renderShop();
    });
    // 任何来源的地面掉落物都要有 3D 模型（玩家放下的、背包满时掉在海滩上的鱼……）
    this.state.on('ground:add', (entry) => {
      if (this.world.groundItemMeshes.has(entry.uid)) return;
      this.world.addGroundItem(entry, this.buildWorldItemModel(entry.item));
    });
    this.state.on('ground:remove', (entry) => {
      this.world.removeGroundItem(entry.uid);
    });
  }

  /* ------------------------------------------------------------------ *
   * 世界物品刷新
   * ------------------------------------------------------------------ */

  _spawnInitialWorldItems() {
    // 前 8 秒钟岛上先有一批海产品，玩家一路捡
    const count = 14;
    for (let i = 0; i < count; i++) this.spawnSeaProduct(true);
    // 地上放一块「免费初始鱼饵」提示玩家去钓鱼
    if (!this.state.inventory.bait) {
      this.state.inventory.addBait('bait_worm', 10);
    }
  }

  spawnSeaProduct(initial = false) {
    const rnd = makeSeededRandom(Math.floor(Math.random() * 1e9));
    // 按 spawn 权重挑
    const total = SEA_PRODUCTS.reduce((a, p) => a + p.spawn, 0);
    let r = Math.random() * total;
    let product = SEA_PRODUCTS[0];
    for (const p of SEA_PRODUCTS) {
      r -= p.spawn;
      if (r <= 0) {
        product = p;
        break;
      }
    }
    // 找位置：优先沙滩与水边
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const radius = 26 + Math.random() * 20;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const y = this.world.heightAt(x, z);
      if (y < -0.9 || y > 1.4) continue;
      if (Math.hypot(x, z) < 12) continue;
      const pos = new THREE.Vector3(x, Math.max(y, -0.05), z);
      this.world.spawnSeaProduct(product, pos);
      return;
    }
  }

  /* ------------------------------------------------------------------ *
   * 输入处理
   * ------------------------------------------------------------------ */

  onKeyDown(e) {
    const code = e.code;
    if (code === 'Escape') {
      if (this.ui.isPanelOpen()) this.ui.closeModal();
      else if (this.ui.isInspecting()) this.ui.closeInspect();
      else this.togglePause();
      return;
    }
    if (this._pendingConfirm) {
      if (code === 'Enter' || code === 'KeyY') this.resolveConfirm(true);
      if (code === 'Escape' || code === 'KeyN') this.resolveConfirm(false);
      return;
    }
    if (code === 'Enter') {
      if (!this.player.locked) {
        this.hideStartOverlay();
        this.audio.unlock();
        this.player.requestLock();
      }
      return;
    }

    // 面板打开时只处理关闭类按键
    if (this.ui.isPanelOpen()) {
      if (code === 'KeyE' || code === 'KeyV') {
        if ((code === 'KeyV' && this.ui.openPanel === 'stats') || (code === 'KeyE' && this.ui.openPanel !== 'stats' && this.ui.openPanel !== 'settings')) {
          this.ui.closeModal();
        }
      }
      return;
    }
    if (this.ui.isInspecting() && code !== 'KeyF') {
      // 检视面板打开时只允许关闭 / 继续操作
      if (!['KeyX', 'KeyB', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].includes(code)) {
        return;
      }
    }

    if (code === 'KeyE') {
      this.interact();
      return;
    }
    if (code === 'KeyX') {
      this.dropHeld();
      return;
    }
    if (code === 'KeyF') {
      if (this.ui.isInspecting()) this.ui.closeInspect();
      else this.ui.inspect(this.state.heldItem);
      return;
    }
    if (code === 'KeyV') {
      this.audio.play('uiOpen');
      this.ui.setPanel(this.ui.openPanel === 'stats' ? null : 'stats');
      return;
    }
    if (code === 'KeyB') {
      this.switchBait();
      return;
    }
    if (code === 'KeyC') {
      this.player.toggleView();
      return;
    }
    if (code === 'KeyH') {
      this.audio.play('uiOpen');
      this.ui.setPanel('help');
      return;
    }
    if (code === 'KeyP') {
      this.settings.set('showFps', !this.settings.get('showFps'));
      this.ui._applySettingsToDom();
      return;
    }
    if (code === 'KeyQ') {
      // 快速进食（等同长按左键）
      this.eatHeld();
      return;
    }
    // 数字键切换手持
    if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= MAX_SLOTS) {
        if (n <= this.state.inventory.slots) {
          this.state.inventory.setHand(n - 1);
          this.onHandChanged();
        }
      }
    }
  }

  onPrimaryDown() {
    const held = this.state.heldItem;
    if (held && held.kind === 'rod') {
      this.fishing.onPrimaryDown();
      return;
    }
    if (held && isEdible(held)) {
      this.startEating();
      return;
    }
    // 手上空的：不做事
  }

  onPrimaryUp() {
    const held = this.state.heldItem;
    if (held && held.kind === 'rod') {
      this.fishing.onPrimaryUp(this.player.castContext());
      return;
    }
    this.stopEating();
  }

  onSecondary() {
    const held = this.state.heldItem;
    if (held && held.kind === 'rod') {
      this.fishing.onSecondary();
      return;
    }
    // 非鱼竿：右键也能快速收杆（避免玩家忘了切回竿）
    if (this.fishing.isFishing) this.fishing.forceIdle('secondary');
  }

  startEating() {
    this.eating = { t: 0, need: 1.1 };
  }

  stopEating() {
    this.eating = null;
  }

  eatHeld() {
    const gain = this.state.eatHeld();
    if (gain > 0) {
      this.audio.play('eat');
      this.onHandChanged();
    }
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */

  /** 找玩家附近可以交互的东西（基于距离 + 朝向） */
  findInteraction() {
    if (this.ui.isPanelOpen()) return null;
    const p = this.player.position;
    const yaw = this.player.yaw;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);

    const candidates = [];

    // NPC
    for (const npc of this.world.npcs) {
      const d = Math.hypot(npc.position.x - p.x, npc.position.z - p.z);
      if (d > 3.6) continue;
      const dot = ((npc.position.x - p.x) * fx + (npc.position.z - p.z) * fz) / (d || 1);
      candidates.push({
        kind: 'npc', npc, d, dot,
        text: this.npcPromptText(npc),
        key: 'E',
        weight: 2,
      });
    }

    // 商店货架上的商品（摆在室外，直接买）
    for (const good of this.world.shopGoods) {
      const d = Math.hypot(good.position.x - p.x, good.position.z - p.z);
      if (d > 3.0) continue;
      const dot = ((good.position.x - p.x) * fx + (good.position.z - p.z) * fz) / (d || 1);
      candidates.push({
        kind: 'good', good, d, dot,
        text: `买下 ${good.label}（${good.priceText}）`,
        key: 'E',
        weight: 3,
      });
    }

    // 地上的物品
    for (const g of this.state.groundItems) {
      const d = Math.hypot(g.x - p.x, g.z - p.z);
      if (d > 2.8) continue;
      const dot = ((g.x - p.x) * fx + (g.z - p.z) * fz) / (d || 1);
      candidates.push({ kind: 'ground', entry: g, d, dot, text: `捡起 ${itemName(g.item)}`, key: 'E', weight: 4 });
    }

    // 海产品
    for (const s of this.world.seaProducts) {
      const d = Math.hypot(s.mesh.position.x - p.x, s.mesh.position.z - p.z);
      if (d > 2.8) continue;
      const dot = ((s.mesh.position.x - p.x) * fx + (s.mesh.position.z - p.z) * fz) / (d || 1);
      candidates.push({
        kind: 'sea', entry: s, d, dot,
        text: `捡起 ${s.product.name}`,
        key: 'E',
        weight: 4,
      });
    }

    // 鱼池
    const pondD = Math.hypot(p.x, p.z);
    if (pondD < 14) {
      candidates.push({
        kind: 'pond',
        d: pondD,
        dot: 1,
        text: '查看观赏鱼池（把手上的鱼放进去）',
        key: 'E',
        weight: 1,
      });
    }

    // 烧烤架
    const gp = this.world.grillPos;
    const gd = Math.hypot(gp.x - p.x, gp.z - p.z);
    if (gd < 4.2) {
      candidates.push({
        kind: 'grill',
        d: gd,
        dot: ((gp.x - p.x) * fx + (gp.z - p.z) * fz) / (gd || 1),
        text: this.grill.isLit ? '使用烧烤架（烤鱼 / 取鱼）' : '烧烤架（点火要 60 元）',
        key: 'E',
        weight: 5,
      });
    }

    if (candidates.length === 0) return null;
    // 优先：正对着的、近的、权重高的
    candidates.sort((a, b) => {
      const sa = a.weight * 2 - a.d - (a.dot < 0.2 ? 1.5 : 0);
      const sb = b.weight * 2 - b.d - (b.dot < 0.2 ? 1.5 : 0);
      return sb - sa;
    });
    return candidates[0];
  }

  npcPromptText(npc) {
    if (npc.role === 'shop') return '和商店老板交易（买 / 卖）';
    if (npc.role === 'grill') return this.grill.isLit ? '和阿炭聊两句（烤架正烧着）' : '找阿炭点火烧烤架';
    return '和老渔夫聊聊（教学 / 按键）';
  }

  interact() {
    const it = this.interaction;
    if (!it) {
      this.ui.toast('附近没有可以交互的东西', 'info');
      return;
    }
    switch (it.kind) {
      case 'npc': {
        this.audio.play('uiOpen');
        if (it.npc.role === 'shop') this.ui.setPanel('shop');
        else if (it.npc.role === 'grill') this.ui.setPanel('grill');
        else this.ui.setPanel('fisher');
        break;
      }
      case 'good': {
        this.buyGood(it.good);
        break;
      }
      case 'ground': {
        const item = this.state.pickUpNearest(this.player.position, 3);
        if (item) this.audio.play('pickup');
        break;
      }
      case 'sea': {
        this.pickSeaProduct(it.entry);
        break;
      }
      case 'pond': {
        this.audio.play('uiOpen');
        this.ui.setPanel('pond');
        break;
      }
      case 'grill': {
        this.audio.play('uiOpen');
        this.ui.setPanel('grill');
        break;
      }
      default:
        break;
    }
  }

  pickSeaProduct(entry) {
    if (!this.state.inventory.hasRoomFor({ kind: 'sea' })) {
      this.ui.toast('背包满了', 'warn');
      return;
    }
    const roll = rollSeaInstance(entry.product, 1);
    const item = makeItem('sea', entry.product.id, {
      quality: roll.quality,
      weightKg: roll.weightKg,
      lengthCm: roll.lengthCm,
    });
    this.state.give(item);
    this.state.recordCatch(item, { spot: 'beach' });
    this.world.removeSeaProduct(entry);
    this.audio.play('pickup');
  }

  /** 花钱买室外货架上的商品（策划：商品直接摆在商店外面） */
  buyGood(good) {    if (!this.state.canAfford(good.price)) {
      this.ui.toast('钱不够', 'warn');
      this.audio.play('fail');
      return;
    }
    const item = good.makeItem();
    if (!this.state.inventory.hasRoomFor(item)) {
      this.ui.toast('背包满了', 'warn');
      return;
    }
    this.state.spend(good.price, 'good:' + good.key);
    this.state.give(item);
    this.audio.play('coin');
    this.ui.toast(`买下 ${good.label}`, 'good');
  }

  /* ------------------------------------------------------------------ *
   * 手持物品变化
   * ------------------------------------------------------------------ */

  onHandChanged(preserveRod = false) {
    const held = this.state.heldItem;
    this.fishing.forceIdle('switch');
    this.player.setHandItem(held);
    this.ui.refreshInspect();
    this.updateFishingRodVisibility();
    // 手上不是鱼竿时竿模型移除
    if (held && held.kind === 'rod') {
      this.player.fishingPose = 0.25;
    } else {
      this.player.fishingPose = 0;
    }
  }

  updateFishingRodVisibility() {
    // 第三人称下，手持模型挂在手上；第一人称时移到镜头前
    if (this.player.viewMode === 1) {
      this.player.handSlot.position.set(0.42, 1.05, 0.55);
    } else {
      this.player.handSlot.position.set(0.3, 1.0, 0.24);
    }
  }

  switchBait() {
    // 在背包里找鱼饵物品，循环切换
    const inv = this.state.inventory;
    const baits = [];
    for (let i = 0; i < inv.slots; i++) {
      const it = inv.items[i];
      if (it && it.kind === 'bait') baits.push({ slot: i, item: it });
    }
    if (inv.bait) baits.unshift({ slot: 'bait', item: makeBait(inv.bait.speciesId, inv.bait.count) });
    if (baits.length === 0) {
      this.ui.toast('没有鱼饵，去商店买点', 'warn');
      return;
    }
    const cur = inv.bait ? inv.bait.speciesId : null;
    let idx = baits.findIndex((b) => b.item.speciesId === cur);
    idx = (idx + 1) % baits.length;
    const target = baits[idx];
    if (target.slot === 'bait') {
      this.ui.toast(`当前鱼饵：${BAIT_BY_ID.get(target.item.speciesId)?.name}`, 'info');
      return;
    }
    // 把背包里的饵换进鱼饵格；原来的饵原处放回同一个格子（绝不丢东西）
    const old = inv.bait ? { speciesId: inv.bait.speciesId, count: inv.bait.count } : null;
    const swapped = inv.items[target.slot];
    inv.items[target.slot] = old ? makeBait(old.speciesId, old.count) : null;
    inv.bait = { speciesId: swapped.speciesId, count: swapped.count };
    this.audio.play('uiClick');
    this.ui.toast(`换成 ${BAIT_BY_ID.get(swapped.speciesId)?.name}`, 'good');
    this.onHandChanged();
  }

  dropHeld() {
    const item = this.state.heldItem;
    if (!item) {
      this.ui.toast('手上没有东西', 'info');
      return;
    }
    const taken = this.state.inventory.takeHeld();
    const ctx = this.player.castContext();
    const pos = {
      x: this.player.position.x + ctx.dir.x * 1.4,
      y: this.player.position.y + 0.2,
      z: this.player.position.z + ctx.dir.z * 1.4,
    };
    // 3D 模型由 state 的 ground:add 事件统一创建
    this.state.dropItem(taken, pos);
    this.audio.play('uiClick');
    this.ui.toast(`放下了 ${itemName(taken)}`, 'info');
    this.onHandChanged();
  }

  buildWorldItemModel(item) {
    const kind = kindOf(item);
    const sp = speciesOf(kind, item.speciesId);
    if (kind === 'rod') {
      const m = buildHandRod(ROD_BY_ID.get(item.speciesId));
      m.rotation.set(0, 0, 1.1);
      return m;
    }
    return buildItemModel(item, { species: sp, scale: kind === 'bait' ? 1 : 1.6 });
  }

  pondPutHeld() {
    const r = this.state.addToPond();
    if (r.ok) {
      this.audio.play('splash');
      this.world.syncPond();
      this.onHandChanged();
    } else if (r.reason === 'not_fish') {
      this.ui.toast('只有鱼可以放进鱼池', 'warn');
    } else if (r.reason === 'pond_full') {
      this.ui.toast('鱼池满了', 'warn');
    }
  }

  sellHeld() {
    const item = this.state.heldItem;
    if (!item) return;
    if (this.shop.needsConfirm(item)) {
      this.askConfirm(`确定要卖掉 ${itemName(item)} 吗？价值约 ${sellPrice(item)} 元。`, () => {
        this.shop.sellSlot();
        this.audio.play('coin');
        this.onHandChanged();
      });
      return;
    }
    const r = this.shop.sellSlot();
    if (r.ok) {
      this.audio.play('coin');
      this.onHandChanged();
    }
  }

  sellAll() {
    const r = this.shop.sellAll();
    if (r.ok) this.audio.play('coin');
    this.onHandChanged();
  }

  /* ------------------------------------------------------------------ *
   * 确认弹窗（借用一个极简实现）
   * ------------------------------------------------------------------ */

  askConfirm(text, onOk) {
    this._pendingConfirm = { text, onOk };
    this.ui.notify(text, '回车 / Y 确认 · Esc / N 取消', 'warn');
  }

  resolveConfirm(ok) {
    const p = this._pendingConfirm;
    this._pendingConfirm = null;
    if (ok && p) p.onOk();
    if (ok) this.audio.play('uiClick');
  }

  confirmReset() {
    this.askConfirm('确定重开新档吗？当前进度会被清空。', () => {
      GameState.clearSave(this.storage);
      this.state.reset();
      this.world.syncPond();
      for (const [uid] of this.world.groundItemMeshes) this.world.removeGroundItem(uid);
      this.onHandChanged();
      this.ui.closeModal();
      this.ui.toast('已重开新档', 'good');
    });
  }

  /* ------------------------------------------------------------------ *
   * 暂停 / 开始遮罩
   * ------------------------------------------------------------------ */

  showStartOverlay() {
    const el = document.getElementById('start-overlay');
    if (!el) return;
    const hasSave = GameState.hasSave(this.storage);
    el.querySelector('#start-save-hint').textContent = hasSave
      ? '检测到本地存档，将自动继续上次进度。'
      : '没有找到存档，将开始新的一局。';
    el.classList.remove('hidden');
    this.paused = true;
  }

  hideStartOverlay() {
    document.getElementById('start-overlay')?.classList.add('hidden');
    this.paused = false;
    this.audio.startAmbience();
  }

  togglePause() {
    if (this.paused) {
      this.hideStartOverlay();
      this.player.requestLock();
    } else {
      this.paused = true;
      document.getElementById('start-overlay')?.classList.remove('hidden');
      this.player.exitLock();
    }
  }

  onPanelClosed() {
    // 关闭面板后重新锁鼠标，省得玩家还要点一下
    if (!this.paused) this.player.requestLock();
  }

  onSettingsChanged(key) {
    if (key === 'quality' || key === '*') this.applyQuality();
    this.audio.applyVolumes();
    this.ui?._applySettingsToDom?.();
  }

  save(quiet = false) {
    this.state.grillSlots = this.grill.toJSON();
    const ok = this.state.save();
    if (!ok) this.ui.toast('保存失败：浏览器本地存储不可用', 'warn');
    return ok;
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /* ------------------------------------------------------------------ *
   * 世界物品与玩家模型
   * ------------------------------------------------------------------ */

  _ensureShopGoods() {
    // 在商店前摆出可以「直接买」的商品模型
    const root = this.world.shopGoodsRoot;
    const defs = [
      { kind: 'bait', id: 'bait_worm', dx: -2.0, dz: 6.2, dy: 1.12, label: '沙蚕 ×10', price: BAITS[0].price * 10 },
      { kind: 'bait', id: 'bait_shrimp', dx: -1.2, dz: 6.2, dy: 1.12, label: '活虾 ×10', price: BAITS[1].price * 10 },
      { kind: 'rod', id: 'rod_bamboo', dx: 1.0, dz: 6.2, dy: 0.05, label: '竹制手竿', price: RODS[0].price },
      { kind: 'rod', id: 'rod_fiber', dx: 2.0, dz: 6.2, dy: 0.05, label: '玻璃钢竿', price: RODS[1].price },
    ];
    for (const d of defs) {
      let model;
      if (d.kind === 'rod') {
        model = buildHandRod(ROD_BY_ID.get(d.id));
        model.rotation.set(0.2, 0.4, 1.3);
        model.scale.setScalar(0.9);
      } else {
        model = buildItemModel(makeBait(d.id, 10), { species: BAIT_BY_ID.get(d.id), scale: 1.3 });
      }
      model.position.set(d.dx, d.dy, d.dz);
      model.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      root.add(model);
      const worldPos = new THREE.Vector3();
      model.getWorldPosition(worldPos);
      this.world.shopGoods.push({
        key: `${d.kind}:${d.id}`,
        ...d,
        position: worldPos,
        model,
        priceText: `${d.price} 元`,
        makeItem: () => (d.kind === 'rod' ? makeRod(d.id) : makeBait(d.id, 10)),
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 主循环
   * ------------------------------------------------------------------ */

  loop(now) {
    requestAnimationFrame(this.loop);
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.25) dt = 0.25; // 切标签页回来别一次跑太多
    if (dt <= 0) return;

    // FPS 统计
    this.fpsSamples.push(dt);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    this.fps = Math.round(1 / avg);

    if (!this.paused) {
      this.update(dt);
    }
    this.render();
  }

  update(dt) {
    this.gameTime += dt;
    const s = this.state;

    // 时间 / 饱食度
    s.tickTime(dt);
    const moving = this.player.isMoving;
    s.tickHunger(dt, moving);

    // 玩家
    this.player.update(dt);
    // 截图 / 巡检用的自由机位（正常游戏里 window.__freezeCamPose 不存在）
    if (typeof window !== 'undefined' && window.__freezeCamPose) {
      const pose = window.__freezeCamPose;
      this.camera.position.set(pose.x, pose.y, pose.z);
      this.camera.lookAt(pose.tx, pose.ty, pose.tz);
      this.camera.updateMatrixWorld();
    }
    this.player.fishingPose += ((this.fishing.isFishing ? 1 : 0) - this.player.fishingPose) * Math.min(1, 6 * dt);

    // 钓鱼
    this.chargeFishingHold(dt);
    this.fishing.update(dt, this.player.castContext());

    // 吃
    if (this.eating) {
      this.eating.t += dt;
      if (this.eating.t >= this.eating.need) {
        this.eatHeld();
        this.eating = null;
      }
    }

    // 系统
    this.grill.update(dt);
    this.world.update(dt, {
      dayProgress: s.dayProgress,
      grillLit: this.grill.isLit,
      flamePower: this.grill.flamePower,
    });
    this.world.syncGrill(this.grill.views());

    // 海产品刷新（保持岛上一直有东西可捡，但不会太多）
    this.seaSpawnTimer -= dt;
    const targetCount = 10 + Math.round(this.quality.environmentProps * 0.12);
    if (this.seaSpawnTimer <= 0) {
      this.seaSpawnTimer = randRange(4, 9);
      if (this.world.seaProducts.length < targetCount) this.spawnSeaProduct();
    }

    // 交互
    this.interaction = this.findInteraction();
    if (this.interaction && this.interaction.kind === 'sea' && !this.interaction.entry.mesh.visible) {
      this.interaction = null;
    }

    // 视觉：鱼线
    this.updateFishingVisuals(dt);

    // UI
    this.ui.update(dt, { interaction: this.interaction, fps: this.fps });

    // 自动保存
    this.autoSaveTimer += dt;
    if (this.autoSaveTimer > 45) {
      this.autoSaveTimer = 0;
      this.save(true);
    }

    // 饱食度归零时的提示
    if (s.hunger <= 0 && !this._hungerWarned) {
      this._hungerWarned = true;
      this.ui.notify('饿得走不动了', '吃个海产品或烤鱼恢复饱食度', 'warn');
    }
    if (s.hunger > 20) this._hungerWarned = false;
  }

  /** 长按左键持续收线 */
  chargeFishingHold(dt) {
    if (this.fishing.phase !== FISHING_STATE.FIGHT) return;
    if (this.mouseDown && this.fishing.fight) {
      // 长按期间额外给一点进度（按住本身就是"稳定收线"）
      this.fishing.fight.progress += 0.06 * dt;
    }
  }

  updateFishingVisuals(dt) {
    const f = this.fishing;
    const phase = f.phase;
    const showBobber = phase === FISHING_STATE.CASTING || phase === FISHING_STATE.WAITING ||
      phase === FISHING_STATE.BITE || phase === FISHING_STATE.FIGHT;

    if (!showBobber) {
      this.fishingLine.visible = false;
      this.bobber.visible = false;
      this.castRing.visible = false;
      return;
    }

    this.bobber.visible = true;
    const bob = phase === FISHING_STATE.BITE
      ? Math.sin(this.gameTime * 22) * 0.22 - 0.15
      : Math.sin(this.gameTime * 2.2) * 0.06;
    this.bobber.position.set(f.hookPos.x, Math.max(f.hookPos.y, WATER_Y + 0.06) + bob, f.hookPos.z);

    // 鱼线：从竿尖到手/浮标，用一条折线近似
    const rodTip = new THREE.Vector3();
    if (this.player.handModel) {
      this.player.handSlot.updateWorldMatrix(true, false);
      rodTip.setFromMatrixPosition(this.player.handSlot.matrixWorld);
      rodTip.y += 0.12;
    } else {
      this.player.eyePosition(rodTip);
      rodTip.y -= 0.15;
    }
    const start = rodTip;
    const end = this.bobber.position;
    const mid = start.clone().lerp(end, 0.5);
    mid.y -= Math.min(2.5, start.distanceTo(end) * 0.12);
    const pts = [];
    const SEG = 22;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // 二次贝塞尔，让线自然下垂
      const p = new THREE.Vector3()
        .copy(start).multiplyScalar((1 - t) * (1 - t))
        .addScaledVector(mid, 2 * (1 - t) * t)
        .addScaledVector(end, t * t);
      pts.push(p);
    }
    const arr = this.fishingLine.geometry.attributes.position.array;
    for (let i = 0; i < pts.length; i++) {
      arr[i * 3] = pts[i].x;
      arr[i * 3 + 1] = pts[i].y;
      arr[i * 3 + 2] = pts[i].z;
    }
    this.fishingLine.geometry.attributes.position.needsUpdate = true;
    this.fishingLine.geometry.setDrawRange(0, pts.length);
    this.fishingLine.visible = true;
    this.fishingLine.frustumCulled = false;

    // 落点提示
    if (phase === FISHING_STATE.CHARGING && this.settings.get('castAssist')) {
      this.castRing.visible = true;
      const ctx = this.player.castContext();
      const eased = Math.pow(f.charge, 0.72);
      const dist = 9 + (72 - 9) * eased;
      this.castRing.position.set(
        this.player.position.x + ctx.dir.x * dist,
        WATER_Y + 0.05,
        this.player.position.z + ctx.dir.z * dist
      );
      const sc = 1 + eased * 1.6;
      this.castRing.scale.setScalar(sc);
      this.castRing.material.opacity = 0.25 + 0.35 * eased;
    } else if (phase === FISHING_STATE.CASTING || phase === FISHING_STATE.WAITING) {
      this.castRing.visible = true;
      this.castRing.position.set(f.hookPos.x, WATER_Y + 0.05, f.hookPos.z);
      this.castRing.scale.setScalar(1.1);
      this.castRing.material.opacity = 0.28;
    } else {
      this.castRing.visible = false;
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/** 启动入口 */
export function boot() {
  // 需要 mousedown 状态来判断长按
  const game = new Game();
  game.canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) game.mouseDown = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) game.mouseDown = false;
  });
  window.game = game;
  return game;
}
