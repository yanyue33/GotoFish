/**
 * 玩家控制器：WASD 移动、鼠标视角、冲刺、视角切换、手持物品挂点。
 *
 * 碰撞极简但够用：
 *  - 地面 = 地形高度函数；
 *  - 水深超过阈值不能走（会游泳的设定没做，直接挡住更符合休闲游戏）；
 *  - 栈桥是一个矩形区域的特殊地面高度。
 */

import * as THREE from 'three';
import { clamp } from '../core/rng.js';
import { buildHandRod, buildItemModel, buildPlayer } from '../world/models.js';
import { ROD_BY_ID, speciesOf, kindOf } from '../data/items.js';

export const PIER_ZONE = { x0: -1.7, x1: 1.7, z0: 40, z1: 82, y: 0.83 };
export const PIER_PLATFORM = { x0: -3, x1: 3, z0: 79, z1: 85, y: 0.83 };

export class PlayerController {
  /**
   * @param {THREE.Camera} camera
   * @param {object} ctx { world, state, settings, audio, emit }
   */
  constructor(camera, ctx) {
    this.camera = camera;
    this.world = ctx.world;
    this.state = ctx.state;
    this.settings = ctx.settings;
    this.audio = ctx.audio;
    this.emit = ctx.emit || (() => {});

    /** 位置（脚底） */
    this.position = new THREE.Vector3(0, 0, 42);
    this.position.y = this.groundAt(this.position.x, this.position.z);
    /** 水平朝向（弧度，0 = +Z） */
    this.yaw = Math.PI;
    this.pitch = -0.1;
    this.velocity = new THREE.Vector3();
    this.moveSpeed = 4.6;
    this.runMultiplier = 1.75;
    this.sprinting = false;
    this.isMoving = false;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepTimer = 0;

    /** 视角模式：0 = 第三人称，1 = 第一人称 */
    this.viewMode = 0;
    this.thirdPersonDist = 4.4;
    this.thirdPersonHeight = 1.65;

    this.keys = new Set();
    this.locked = false;
    this.mouse = { dx: 0, dy: 0 };
    this._shake = { t: 0, mag: 0 };

    this.rig = new THREE.Group();
    this.rig.name = 'player';
    this.rig.position.copy(this.position);
    this.rig.rotation.y = this.yaw;

    this.body = ctx.playerModel || buildPlayer();
    this.rig.add(this.body);
    this.handSlot = new THREE.Group();
    this.handSlot.position.set(0.28, 1.05, 0.2);
    this.rig.add(this.handSlot);
    this.handModel = null;
    this.groundModel = null;
    this.fishingPose = 0;

    this._tmpDir = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._forward = new THREE.Vector3();
  }

  /* ------------------------------------------------------------------ *
   * 输入
   * ------------------------------------------------------------------ */

  attach(domElement) {
    this.dom = domElement;
    this._onKeyDown = (e) => this.onKeyDown(e);
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseMove = (e) => this.onMouseMove(e);
    this._onPointerLockChange = () => {
      this.locked = document.pointerLockElement === domElement;
      this.emit('pointerlock', this.locked);
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }

  requestLock() {
    if (!this.dom) return;
    // 页面不可见 / 没有焦点时（切标签页、自动化、iframe 里），浏览器会直接拒绝，
    // 而且拒绝的 Promise 有时并不交给我们，所以先自己挡一层。
    if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus?.())) return;
    // 在 iframe / 自动化 / 用户还没交互等情况下，requestPointerLock 会返回一个被拒绝的
    // Promise。必须吃掉它，否则会冒成 unhandledrejection。
    try {
      const p = this.dom.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            this.dom.requestPointerLock();
          } catch {
            /* 浏览器不允许锁定，忽略 */
          }
        });
      }
    } catch {
      try {
        this.dom.requestPointerLock();
      } catch {
        /* 忽略 */
      }
    }
  }

  exitLock() {
    try {
      document.exitPointerLock?.();
    } catch {
      /* 忽略 */
    }
  }

  onKeyDown(e) {
    // 面板打开时不要把按键当成移动
    if (this.inputBlocked && this.inputBlocked()) {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft'].includes(e.code)) return;
    }
    this.keys.add(e.code);
    if (e.code === 'KeyV' && !e.repeat) {
      this.toggleView();
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprinting = true;
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault?.();
  }

  toggleView() {
    this.viewMode = this.viewMode === 0 ? 1 : 0;
    this.emit('view:changed', this.viewMode);
    this.emit('toast', { text: this.viewMode === 1 ? '第一人称视角' : '第三人称视角', kind: 'info' });
  }

  onMouseMove(e) {
    if (!this.locked) return;
    const s = this.settings.get('sensitivity');
    const invert = this.settings.get('invertY') ? -1 : 1;
    this.yaw -= e.movementX * 0.0022 * s;
    this.pitch -= e.movementY * 0.0022 * s * invert;
    this.pitch = clamp(this.pitch, -1.35, 1.15);
  }

  /** 屏幕震动（起钩、断线时） */
  shake(mag = 0.2, time = 0.3) {
    if (!this.settings.get('screenShake')) return;
    this._shake.mag = Math.max(this._shake.mag, mag);
    this._shake.t = Math.max(this._shake.t, time);
  }

  /* ------------------------------------------------------------------ *
   * 地面 / 碰撞
   * ------------------------------------------------------------------ */

  inPierZone(x, z) {
    const inWalk = x >= PIER_ZONE.x0 && x <= PIER_ZONE.x1 && z >= PIER_ZONE.z0 && z <= PIER_ZONE.z1;
    const inPlat = x >= PIER_PLATFORM.x0 && x <= PIER_PLATFORM.x1 && z >= PIER_PLATFORM.z0 && z <= PIER_PLATFORM.z1;
    return inWalk || inPlat;
  }

  groundAt(x, z) {
    const terrain = this.world.heightAt(x, z);
    if (this.inPierZone(x, z)) return Math.max(terrain, PIER_ZONE.y);
    return terrain;
  }

  /** 是否可以站在这（水太深不行；栈桥区域永远可以走） */
  canStandAt(x, z) {
    if (this.inPierZone(x, z)) return true;
    const h = this.world.heightAt(x, z);
    if (h < -1.15) return false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 每帧
   * ------------------------------------------------------------------ */

  update(dt) {
    const blocked = this.inputBlocked ? this.inputBlocked() : false;
    const keys = this.keys;
    let ix = 0;
    let iz = 0;
    if (!blocked) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    }
    const len = Math.hypot(ix, iz);
    this.isMoving = len > 0;

    // 前方向量（水平）
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    let dx = 0;
    let dz = 0;
    if (this.isMoving) {
      const nx = ix / len;
      const nz = iz / len;
      dx = fx * nz + fz * nx;
      dz = fz * nz - fx * nx;
      const nl = Math.hypot(dx, dz) || 1;
      dx /= nl;
      dz /= nl;
    }

    this.sprinting = !blocked && (keys.has('ShiftLeft') || keys.has('ShiftRight'));
    const hungerFactor = this.state.speedFactor;
    const speed = this.moveSpeed * (this.sprinting ? this.runMultiplier : 1) * hungerFactor;

    // 加速度插值，手感更顺
    const targetVx = dx * speed;
    const targetVz = dz * speed;
    const accel = this.isMoving ? 14 : 16;
    this.velocity.x += (targetVx - this.velocity.x) * Math.min(1, accel * dt);
    this.velocity.z += (targetVz - this.velocity.z) * Math.min(1, accel * dt);

    // 分轴推进 + 碰撞
    const nx = this.position.x + this.velocity.x * dt;
    const nz = this.position.z + this.velocity.z * dt;
    if (this.canStandAt(nx, this.position.z)) this.position.x = nx;
    else this.velocity.x = 0;
    if (this.canStandAt(this.position.x, nz)) this.position.z = nz;
    else this.velocity.z = 0;

    // 地面高度（含栈桥）
    const groundY = this.groundAt(this.position.x, this.position.z);
    this.position.y += (groundY - this.position.y) * Math.min(1, 18 * dt);

    // 走路头部起伏
    const moving = this.isMoving && Math.hypot(this.velocity.x, this.velocity.z) > 0.6;
    const targetBob = moving ? (this.sprinting ? 0.11 : 0.07) : 0;
    this.bobAmount += (targetBob - this.bobAmount) * Math.min(1, 8 * dt);
    if (moving) {
      this.bobPhase += dt * (this.sprinting ? 12 : 8);
      this.stepTimer += dt * (this.sprinting ? 1.5 : 1);
      if (this.stepTimer > 0.42) {
        this.stepTimer = 0;
        this.audio?.step?.(this.sprinting ? 1 : 0.6, performance.now() / 1000);
      }
    } else {
      this.bobPhase += dt * 1.2;
    }

    // 角色朝向：移动时朝移动方向，静止时朝向视角
    if (this.isMoving) {
      const targetYaw = Math.atan2(dx, dz);
      this.yaw = this.yaw; // 视角不改
      this._bodyYaw = lerpAngle(this._bodyYaw ?? targetYaw, targetYaw, Math.min(1, 10 * dt));
    } else {
      this._bodyYaw = lerpAngle(this._bodyYaw ?? this.yaw, this.yaw, Math.min(1, 6 * dt));
    }

    this._updateRig(dt);
    this._updateCamera(dt);
  }

  _updateRig(dt) {
    this.rig.position.set(this.position.x, this.position.y, this.position.z);
    // 身体朝向与视角解耦（移动朝移动方向，站立朝视角）
    if (this.viewMode === 1) {
      this.body.visible = false;
    } else {
      this.body.visible = true;
      this.rig.rotation.y = this._bodyYaw ?? this.yaw;
    }
    this.rig.visible = true;

    // 手持模型放在视图前方（因为 rig 会旋转，这里用局部坐标）
    if (this.handModel) {
      this.handModel.visible = true;
      const bob = Math.sin(this.bobPhase) * this.bobAmount;
      this.handSlot.position.set(0.3, 1.0 - bob * 0.4, 0.24);
      this.handSlot.rotation.x = -0.15 + Math.sin(this.bobPhase * 0.5) * 0.03 - this.fishingPose * 0.5;
      this.handSlot.rotation.z = this.fishingPose * 0.35;
    }
  }

  _updateCamera(dt) {
    const fov = this.settings.get('fov');
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const bob = this.settings.get('headBob') ? Math.sin(this.bobPhase) * this.bobAmount : 0;
    const shakeX = this._shake.t > 0 ? (Math.random() - 0.5) * this._shake.mag : 0;
    const shakeY = this._shake.t > 0 ? (Math.random() - 0.5) * this._shake.mag : 0;
    if (this._shake.t > 0) {
      this._shake.t -= dt;
      if (this._shake.t <= 0) this._shake.mag = 0;
    }

    const eyeY = this.position.y + 1.62 + bob;

    if (this.viewMode === 1) {
      // 第一人称
      this.camera.position.set(this.position.x + shakeX, eyeY + shakeY, this.position.z);
      this.camera.rotation.set(0, 0, 0);
      this.camera.rotateY(this.yaw + Math.PI);
      this.camera.rotateX(this.pitch);
      this.rig.rotation.y = this.yaw;
    } else {
      // 第三人称：从玩家背后拉出，撞到地面就抬高
      this.camera.rotation.set(0, 0, 0);
      this.camera.rotateY(this.yaw + Math.PI);
      this.camera.rotateX(this.pitch);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const dist = this.thirdPersonDist;
      const targetX = this.position.x + dir.x * dist;
      const targetY = eyeY + this.thirdPersonHeight * 0.0 + dir.y * dist + 0.35;
      const targetZ = this.position.z + dir.z * dist;
      const groundHere = this.groundAt(targetX, targetZ) + 0.6;
      const finalY = Math.max(targetY, groundHere);
      this.camera.position.set(targetX + shakeX, finalY + shakeY, targetZ);
      this.rig.rotation.y = this._bodyYaw ?? this.yaw;
    }
    this.camera.updateMatrixWorld();
  }

  /** 抛竿用的起点与方向（世界坐标） */
  castContext() {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    // 需要的是水平方向 + 一个起点
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    return {
      origin: { x: this.position.x, y: this.position.y + 1.5, z: this.position.z },
      dir: { x: flat.x, y: 0, z: flat.z },
      pitch: this.pitch,
    };
  }

  /** 眼睛位置（世界坐标） */
  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + 1.62, this.position.z);
  }

  /** 手持物品改变时重建手上模型 */
  setHandItem(item) {
    if (this.handModel) {
      this.handSlot.remove(this.handModel);
      this.handModel.traverse?.((o) => o.geometry?.dispose?.());
      this.handModel = null;
    }
    if (!item) return;
    const kind = kindOf(item);
    if (kind === 'rod') {
      const def = ROD_BY_ID.get(item.speciesId);
      const model = buildHandRod(def);
      model.rotation.set(0, 0, 0);
      this.handModel = model;
      this.handSlot.add(model);
    } else {
      const sp = speciesOf(kind, item.speciesId);
      const model = buildItemModel(item, { species: sp, scale: 0.55 });
      this.handModel = model;
      this.handSlot.add(model);
    }
  }
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
