/**
 * 世界：海岛地形、海水、鱼池、商店、烧烤架、栈桥、植被、天空。
 *
 * 坐标约定：
 *   岛中心在原点，鱼池在中心。水面 y = 0。
 *   玩家出生在南侧沙滩（+Z 方向），栈桥向南伸出。
 */

import * as THREE from 'three';
import { makeSeededRandom, clamp, lerp, rand, randRange } from '../core/rng.js';
import {
  MAT, buildPalmTree, buildRock, buildBush, buildGrassTuft, buildShopHouse,
  buildShopCounter, buildShelf, buildGrill, buildFlame, buildPierSegment,
  buildPondRim, buildPiling, buildBoat, buildLamp, buildSeagull, buildCloud,
  buildFish, buildSeaProduct, buildNPC, buildPlayer, meshFromParts, part,
  lighten, darken,
} from './models.js';
import { SEA_PRODUCTS, FISHING_SPOTS } from '../data/items.js';

export const WATER_Y = 0;
export const POND_WATER_Y = -0.55;
export const ISLAND_RADIUS = 46;
export const POND_RADIUS = 9.5;

/** 地形高度函数（世界坐标 -> 地面高度）。玩家移动、物体摆放都用它。 */
export function terrainHeight(x, z) {
  const r = Math.hypot(x, z);
  // 中央鱼池：做成一个碗
  if (r < POND_RADIUS + 1) {
    const t = clamp(r / (POND_RADIUS + 1), 0, 1);
    return lerp(-1.9, 1.15, Math.pow(t, 1.6));
  }
  if (r < 12) return lerp(1.15, 1.35, (r - POND_RADIUS - 1) / (12 - POND_RADIUS - 1));
  if (r < 30) {
    const t = (r - 12) / 18;
    return 1.35 + Math.sin(t * Math.PI) * 0.85 + Math.sin(x * 0.28) * 0.18 + Math.cos(z * 0.24) * 0.16;
  }
  if (r < ISLAND_RADIUS) {
    const t = (r - 30) / (ISLAND_RADIUS - 30);
    return lerp(1.35 + Math.sin(Math.PI) * 0.85, -0.35, Math.pow(t, 1.5));
  }
  // 海底：向外缓慢变深
  const t = clamp((r - ISLAND_RADIUS) / 70, 0, 1);
  return lerp(-0.35, -12, Math.pow(t, 0.85));
}

/** 岛屿表面颜色（按高度分层：水下沙、沙滩、草地、深草） */
function terrainColor(y, r) {
  if (y < -1.6) return '#3b6a76'; // 水下
  if (y < -0.1) return '#c8b98a'; // 潮间带湿沙
  if (y < 0.9) return '#e6d9ae'; // 沙滩
  if (y < 1.9) return '#8fb95c'; // 草地
  if (y < 2.6) return '#6fa348'; // 深处草地
  return '#5c8f3c';
}

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {object} ctx { quality, settings, state, emit }
   */
  constructor(scene, ctx) {
    this.scene = scene;
    this.ctx = ctx;
    this.quality = ctx.quality;
    this.state = ctx.state;
    this.emit = ctx.emit || (() => {});
    /** 可交互对象 @type {Array<object>} */
    this.interactables = [];
    /** 场景里漂浮的鱼（鱼池 + 海里） @type {object[]} */
    this.swimmingFish = [];
    this.seaProducts = [];
    this.animatables = [];
    this.groundItemMeshes = new Map();

    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);
    this.dynamicRoot = new THREE.Group();
    this.dynamicRoot.name = 'dynamic';
    scene.add(this.dynamicRoot);

    this._time = 0;
    this._build();
  }

  /* ------------------------------------------------------------------ *
   * 构建
   * ------------------------------------------------------------------ */

  _build() {
    this._buildLights();
    this._buildSky();
    this._buildTerrain();
    this._buildWater();
    this._buildPond();
    this._buildPier();
    this._buildShop();
    this._buildGrillArea();
    this._buildProps();
    this._buildNPCs();
    this._buildSeaLife();
    this._buildClouds();
    this._buildBoat();
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight('#bfe3ff', '#6b7a52', 0.72);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight('#fff2d0', 1.15);
    sun.position.set(60, 80, 40);
    if (this.quality.shadows) {
      sun.castShadow = true;
      const size = 80;
      sun.shadow.camera.left = -size;
      sun.shadow.camera.right = size;
      sun.shadow.camera.top = size;
      sun.shadow.camera.bottom = -size;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 260;
      sun.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
      sun.shadow.bias = -0.0012;
      sun.shadow.normalBias = 0.03;
    }
    this.scene.add(sun);
    this.sun = sun;

    // 补一点环境光，避免背光面全黑
    this.scene.add(new THREE.AmbientLight('#8fa8c8', 0.28));
  }

  _buildSky() {
    // 天空：一个巨大的内翻球，用顶点色做上下渐变
    const geo = new THREE.SphereGeometry(600, 24, 16);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    const top = new THREE.Color('#4a9de0');
    const bottom = new THREE.Color('#cfe9f7');
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = clamp((pos.getY(i) / 600) * 0.5 + 0.5, 0, 1);
      const c = bottom.clone().lerp(top, Math.pow(t, 0.7));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // 太阳圆盘
    const sunGeo = new THREE.SphereGeometry(14, 12, 10);
    const sunMat = new THREE.MeshBasicMaterial({ color: '#fff2c0', fog: false });
    this.sunDisc = new THREE.Mesh(sunGeo, sunMat);
    this.sunDisc.frustumCulled = false;
    this.scene.add(this.sunDisc);

    // 星空（夜晚淡入）
    const starCount = 420;
    const sg = new THREE.BufferGeometry();
    const sp = new Float32Array(starCount * 3);
    const srnd = makeSeededRandom(20240607);
    for (let i = 0; i < starCount; i++) {
      const a = srnd() * Math.PI * 2;
      const b = Math.acos(srnd() * 0.95);
      const r = 520;
      sp[i * 3] = Math.sin(b) * Math.cos(a) * r;
      sp[i * 3 + 1] = Math.abs(Math.cos(b)) * r;
      sp[i * 3 + 2] = Math.sin(b) * Math.sin(a) * r;
    }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({
      color: '#ffffff', size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false,
    }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    // 雾（远处淡出，省性能也更像海岛）
    this.scene.fog = new THREE.Fog('#bcdcee', 110, 620);
  }

  _buildTerrain() {
    const seg = this.quality.waterDetail * 2 + 40;
    const rings = 34;
    const outer = 150;

    const grid = buildDiskGeometry(outer, seg, rings, (x, z) => terrainHeight(x, z));
    paintByHeight(grid, terrainHeight);

    const mesh = new THREE.Mesh(grid, MAT.solid);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.terrain = mesh;
    this.root.add(mesh);
  }

  _buildWater() {
    // 两层水面：
    //  - 近处（240m）：细分较密，做波浪起伏，玩家看得最清楚
    //  - 远处（2600m）：极大平面 + 极低起伏，一直铺到雾里，避免出现「水面的直边」
    const near = this._makeWaterPlane(240, Math.max(24, this.quality.waterDetail), true, 1);
    near.position.y = WATER_Y;
    this.water = near;
    this.root.add(near);
    this._waterBase = Float32Array.from(near.geometry.attributes.position.array);

    const far = this._makeWaterPlane(2600, 20, false, 0.18);
    far.position.y = WATER_Y - 0.02;
    this.farWater = far;
    this.root.add(far);
    this._farWaterBase = Float32Array.from(far.geometry.attributes.position.array);

    // 更远的海底（避免透过水面看到虚空）
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(3200, 3200, 1, 1),
      new THREE.MeshLambertMaterial({ color: '#173a4d', flatShading: true })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -16;
    this.root.add(floor);
  }

  _makeWaterPlane(size, seg, detailed, ampScale) {
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    const deep = new THREE.Color('#1f6f9c');
    const shallow = new THREE.Color('#3fa2c8');
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      // 离岛越远颜色越深，看起来更像深海
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      const c = shallow.clone().lerp(deep, clamp((r - 40) / 160, 0, 1));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true, flatShading: true, transparent: true, opacity: detailed ? 0.82 : 0.95,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.ampScale = ampScale;
    mesh.receiveShadow = false;
    return mesh;
  }

  _buildPond() {
    // 池水
    const geo = new THREE.CircleGeometry(POND_RADIUS, 26);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      color: '#2f9fb5', flatShading: true, transparent: true, opacity: 0.86,
    });
    const pond = new THREE.Mesh(geo, mat);
    pond.position.y = POND_WATER_Y;
    this.pondWater = pond;
    this.root.add(pond);

    // 池底（浅色石头，透过去能看到鱼）
    const bed = new THREE.Mesh(
      new THREE.CircleGeometry(POND_RADIUS - 0.2, 22),
      new THREE.MeshLambertMaterial({ color: '#8fa8a0', flatShading: true })
    );
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = -1.85;
    this.root.add(bed);

    // 池边石头圈
    const rim = buildPondRim(POND_RADIUS + 0.6, 20, 99);
    rim.receiveShadow = true;
    this.root.add(rim);

    // 池心小岛装饰 + 灯笼
    const decor = meshFromParts([
      part('ico', { r: 1.2, detail: 0 }, '#8a8d94', { y: 0.3 }),
      part('cyl', { rt: 0.08, rb: 0.1, h: 2.2, seg: 6 }, '#5a4a3a', { y: 1.4 }),
      part('box', { w: 0.5, h: 0.5, d: 0.5 }, '#e8d9a0', { y: 2.7 }),
    ]);
    decor.position.y = POND_WATER_Y - 1.2;
    this.root.add(decor);

    this.emit('world:pond', { radius: POND_RADIUS, waterY: POND_WATER_Y });
  }

  _buildPier() {
    const z0 = 40;
    const z1 = 80;
    const width = 3.4;
    const group = new THREE.Group();
    const segCount = Math.ceil((z1 - z0) / 4);
    for (let i = 0; i < segCount; i++) {
      const seg = buildPierSegment(4, width);
      seg.position.z = z0 + i * 4 + 2;
      seg.position.y = 0.75;
      group.add(seg);
      for (const sx of [-1, 1]) {
        const p = buildPiling(2.4);
        p.position.set(sx * (width / 2 - 0.25), -0.4, z0 + i * 4 + 2);
        group.add(p);
      }
    }
    // 栏杆
    for (const sx of [-1, 1]) {
      for (let i = 0; i <= segCount * 2; i++) {
        const post = meshFromParts([
          part('box', { w: 0.09, h: 0.9, d: 0.09 }, '#8a6640', { y: 0.45 }),
        ]);
        post.position.set(sx * (width / 2 - 0.15), 1.3, z0 + i * 2);
        group.add(post);
      }
      const rail = meshFromParts([
        part('box', { w: 0.11, h: 0.11, d: z1 - z0 }, '#8a6640', {}),
      ]);
      rail.position.set(sx * (width / 2 - 0.15), 1.7, (z0 + z1) / 2);
      group.add(rail);
    }
    // 尽头的钓台
    const platform = meshFromParts([
      part('box', { w: 6, h: 0.16, d: 5 }, '#9c7648', {}),
      part('box', { w: 6, h: 0.16, d: 5 }, '#7d5f3a', { y: -0.2 }),
    ]);
    platform.position.set(0, 0.75, z1 + 2);
    group.add(platform);
    for (const sx of [-2.4, 2.4]) for (const sz of [-1.6, 1.6]) {
      const p = buildPiling(2.4);
      p.position.set(sx, -0.4, z1 + 2 + sz);
      group.add(p);
    }
    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.pier = group;
    this.root.add(group);
  }

  _buildShop() {
    const pos = new THREE.Vector3(-19, 0, 12);
    const y = terrainHeight(pos.x, pos.z);
    const group = new THREE.Group();
    group.position.set(pos.x, y - 0.1, pos.z);
    group.rotation.y = -0.9;

    const house = buildShopHouse();
    group.add(house);

    const counter = buildShopCounter();
    counter.position.set(0, 0, 5.2);
    group.add(counter);

    const shelf = buildShelf();
    shelf.position.set(-4.4, 0, 4.6);
    shelf.rotation.y = 0.5;
    group.add(shelf);

    // 招牌
    const sign = meshFromParts([
      part('box', { w: 3.6, h: 1.0, d: 0.16 }, '#8a5a34', { y: 0 }),
      part('box', { w: 3.3, h: 0.75, d: 0.2 }, '#f0e0c0', { y: 0, z: 0.03 }),
    ]);
    sign.position.set(0, 3.9, 5.6);
    group.add(sign);
    this.shopSign = sign;

    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.root.add(group);
    this.shopGroup = group;
    this.shopPos = new THREE.Vector3(pos.x, y, pos.z);

    // 室外货架上的商品（策划：商品直接放在商店外面）
    this.shopGoods = [];
    const goodsDefs = [
      { kind: 'bait', id: 'bait_worm' },
      { kind: 'bait', id: 'bait_shrimp' },
      { kind: 'rod', id: 'rod_bamboo' },
      { kind: 'rod', id: 'rod_fiber' },
    ];
    this.shopGoodsRoot = new THREE.Group();
    this.shopGoodsRoot.position.copy(group.position);
    this.shopGoodsRoot.rotation.y = group.rotation.y;
    this.root.add(this.shopGoodsRoot);
    /** 摆在室外、可以直接买的商品（由 Game 填充） */
    this.shopGoods = [];
  }

  _buildGrillArea() {
    const pos = new THREE.Vector3(17, 0, 9);
    const y = terrainHeight(pos.x, pos.z);
    const group = new THREE.Group();
    group.position.set(pos.x, y, pos.z);
    group.rotation.y = 0.6;

    const grill = buildGrill();
    group.add(grill);

    this.flame = buildFlame();
    this.flame.position.set(0, 1.0, 0);
    this.flame.visible = false;
    group.add(this.flame);

    // 火堆旁的柴火堆
    const logs = meshFromParts([
      part('cyl', { rt: 0.14, rb: 0.14, h: 1.4, seg: 6 }, '#6f5230', { rx: Math.PI / 2, x: -1.9, y: 0.14 }),
      part('cyl', { rt: 0.14, rb: 0.14, h: 1.4, seg: 6 }, '#7d5f3a', { rx: Math.PI / 2, y: 0.42, x: -1.9 }),
      part('cyl', { rt: 0.14, rb: 0.14, h: 1.4, seg: 6 }, '#6f5230', { rx: Math.PI / 2, y: 0.7, x: -1.9 }),
    ]);
    group.add(logs);

    // 小桌子（放取下的烤鱼）
    const table = meshFromParts([
      part('box', { w: 2.2, h: 0.12, d: 1.2 }, '#9c7648', { y: 0.9 }),
      ...[-0.9, 0.9].flatMap((x) => [-0.45, 0.45].map((z) =>
        part('box', { w: 0.12, h: 0.9, d: 0.12 }, '#6f5230', { x, z, y: 0.45 })
      )),
    ]);
    table.position.set(2.6, 0, 0.6);
    group.add(table);

    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.root.add(group);
    this.grillGroup = group;
    this.grillPos = new THREE.Vector3(pos.x, y, pos.z);

    // 烤架上的鱼（跟随 UI 槽位显示）
    this.grillFishMeshes = new Array(4).fill(null);
  }

  _buildProps() {
    const q = this.quality;
    const rnd = makeSeededRandom(20240608);
    const props = new THREE.Group();
    const keepOut = [
      { x: -19, z: 12, r: 12 }, // 商店
      { x: 17, z: 9, r: 9 },    // 烧烤区
      { x: 0, z: 0, r: POND_RADIUS + 3 }, // 鱼池
      { x: 0, z: 46, r: 7 },    // 栈桥口
    ];
    const blocked = (x, z) => keepOut.some((k) => Math.hypot(x - k.x, z - k.z) < k.r);

    // 棕榈树
    for (let i = 0; i < q.treeCount; i++) {
      for (let tries = 0; tries < 20; tries++) {
        const a = rnd() * Math.PI * 2;
        const r = 14 + rnd() * 26;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = terrainHeight(x, z);
        if (y < 0.15 || y > 2.6 || blocked(x, z)) continue;
        const tree = buildPalmTree(5 + rnd() * 3.5, Math.floor(rnd() * 1e6));
        tree.position.set(x, y - 0.1, z);
        tree.rotation.y = rnd() * Math.PI * 2;
        props.add(tree);
        break;
      }
    }

    // 灌木
    for (let i = 0; i < Math.floor(q.treeCount * 1.6); i++) {
      const a = rnd() * Math.PI * 2;
      const r = 12 + rnd() * 30;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeight(x, z);
      if (y < 0.5 || blocked(x, z)) continue;
      const b = buildBush(1.2 + rnd() * 0.9, Math.floor(rnd() * 1e6));
      b.position.set(x, y, z);
      b.rotation.y = rnd() * 3;
      props.add(b);
    }

    // 石头
    for (let i = 0; i < Math.floor(q.environmentProps * 0.5); i++) {
      const a = rnd() * Math.PI * 2;
      const r = 6 + rnd() * 48;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeight(x, z);
      if (blocked(x, z)) continue;
      const rock = buildRock(0.7 + rnd() * 2.2, Math.floor(rnd() * 1e6));
      // 别让石头浮在深水上方：海底越深，石头就应该越往下埋
      const baseY = y < -0.2 ? Math.max(y, -1.6) : y;
      rock.position.set(x, baseY, z);
      rock.rotation.y = rnd() * 3;
      props.add(rock);
    }

    props.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.root.add(props);

    // 草：用 InstancedMesh 一次性画完（性能关键）
    this._buildGrass(q.grassCount, keepOut);

    // 路灯
    for (const [lx, lz] of [[-11, 4], [11, 3], [0, 34], [-9, 24], [9, 26]]) {
      const lamp = buildLamp();
      lamp.position.set(lx, terrainHeight(lx, lz), lz);
      lamp.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      this.root.add(lamp);
    }
  }

  _buildGrass(count, keepOut) {
    if (count <= 0) return;
    const template = buildGrassTuft(1);
    const geo = template.geometry;
    const mesh = new THREE.InstancedMesh(geo, MAT.double, count);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const m = new THREE.Matrix4();
    const rnd = makeSeededRandom(777);
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 12 + rnd() * 32;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = terrainHeight(x, z);
      if (y < 0.6) continue;
      if (keepOut.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
      m.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 3, 0)),
        new THREE.Vector3(1, 0.7 + rnd() * 0.8, 1)
      );
      mesh.setMatrixAt(placed, m);
      placed += 1;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.grass = mesh;
    this.root.add(mesh);
  }

  _buildNPCs() {
    this.npcs = [];
    // 商店老板（站在柜台后）
    const shopkeeper = this._makeNPC({
      name: '商店老板 老陈',
      pos: new THREE.Vector3(-19, 0, 12),
      localOffset: new THREE.Vector3(-3.6, 0, 4.2),
      rotationY: -0.9,
      colors: { shirt: '#c86a4a', pants: '#4a4438', hat: '#8a6a3a' },
      beard: '#6b5a4a',
      apron: '#e8e0d0',
      role: 'shop',
    });
    // 烧烤架老板
    const griller = this._makeNPC({
      name: '烧烤架老板 阿炭',
      pos: new THREE.Vector3(17, 0, 9),
      localOffset: new THREE.Vector3(-2.6, 0, 1.6),
      rotationY: 1.4,
      colors: { shirt: '#4a6a8a', pants: '#3a3a3a', hat: '#c0c0c0' },
      beard: '#3a3a3a',
      apron: '#8a5a34',
      role: 'grill',
    });
    // 老渔夫（教钓鱼 + 卖小船）
    const fisherman = this._makeNPC({
      name: '老渔夫 阿海',
      pos: new THREE.Vector3(3.6, 0, 40),
      localOffset: new THREE.Vector3(0, 0, 0),
      rotationY: Math.PI,
      colors: { shirt: '#3f7fd6', pants: '#2f3b52', hat: '#8fd4e8' },
      beard: '#d8d8d8',
      role: 'fisher',
    });
    this.fisherman = fisherman;
  }

  _makeNPC({ name, pos, localOffset, rotationY, colors, beard, apron, role }) {
    const y = terrainHeight(pos.x + localOffset.x, pos.z + localOffset.z);
    const obj = buildNPC({ ...colors, beard, apron });
    obj.position.set(pos.x + localOffset.x, y, pos.z + localOffset.z);
    obj.rotation.y = rotationY;
    obj.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    obj.userData = { kind: 'npc', role, name, baseY: y };
    this.root.add(obj);
    const npc = { obj, role, name, position: obj.position, walkPhase: 0 };
    this.npcs.push(npc);
    return npc;
  }

  /** 海里游动的鱼（远景装饰，性能友好：只有少量） */
  _buildSeaLife() {
    const rnd = makeSeededRandom(31415);
    const count = this.quality.fishDetail;
    for (let i = 0; i < count; i++) {
      const fish = buildFish({
        rod: rnd() > 0.6 ? 'flat' : 'rod',
        color: ['#7fa8c8', '#c8a87f', '#88c0a8', '#b8b0d0'][Math.floor(rnd() * 4)],
        size: 0.7 + rnd() * 1.2,
      });
      const a = rnd() * Math.PI * 2;
      const r = 70 + rnd() * 60;
      fish.position.set(Math.cos(a) * r, -1.2 - rnd() * 2.2, Math.sin(a) * r);
      fish.castShadow = false;
      this.dynamicRoot.add(fish);
      this.swimmingFish.push({
        obj: fish,
        kind: 'sea',
        radius: r,
        angle: a,
        speed: (0.04 + rnd() * 0.06) * (rnd() > 0.5 ? 1 : -1),
        bob: rnd() * Math.PI * 2,
        baseY: fish.position.y,
      });
    }
  }

  _buildClouds() {
    const rnd = makeSeededRandom(5150);
    this.clouds = [];
    for (let i = 0; i < 10; i++) {
      const cloud = buildCloud(Math.floor(rnd() * 1e6));
      const a = rnd() * Math.PI * 2;
      const r = 240 + rnd() * 180;
      // 云要高，否则会被误认成浮在空中的石头
      cloud.position.set(Math.cos(a) * r, 120 + rnd() * 70, Math.sin(a) * r);
      cloud.scale.setScalar(5 + rnd() * 5);
      cloud.traverse((o) => {
        if (o.isMesh) o.castShadow = false;
      });
      this.dynamicRoot.add(cloud);
      this.clouds.push({ obj: cloud, speed: 0.6 + rnd() * 0.9 });
    }
    // 海鸥
    this.gulls = [];
    for (let i = 0; i < 4; i++) {
      const gull = buildSeagull();
      gull.scale.setScalar(1.4);
      this.dynamicRoot.add(gull);
      this.gulls.push({
        obj: gull,
        a: rnd() * Math.PI * 2,
        r: 52 + rnd() * 40,
        y: 22 + rnd() * 14,
        speed: 0.09 + rnd() * 0.06,
        flap: rnd() * 10,
      });
    }
  }

  _buildBoat() {
    const boat = buildBoat();
    boat.position.set(6, WATER_Y + 0.05, 62);
    boat.rotation.y = -0.3;
    boat.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.boat = boat;
    this.root.add(boat);
  }

  /* ------------------------------------------------------------------ *
   * 海产品刷新（沙滩上捡东西）
   * ------------------------------------------------------------------ */

  /** 刷一个新的海产品到世界（返回 mesh 数据） */
  spawnSeaProduct(product, position) {
    const mesh = buildSeaProduct({ shape: product.shape, color: product.color });
    const s = 0.9 + rand() * 0.5;
    mesh.scale.setScalar(s);
    mesh.position.copy(position);
    mesh.rotation.y = rand() * Math.PI * 2;
    mesh.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.root.add(mesh);
    const entry = { id: product.id, product, mesh, x: position.x, y: position.y, z: position.z, born: this._time };
    this.seaProducts.push(entry);
    return entry;
  }

  removeSeaProduct(entry) {
    const i = this.seaProducts.indexOf(entry);
    if (i >= 0) this.seaProducts.splice(i, 1);
    this.root.remove(entry.mesh);
    entry.mesh.geometry?.dispose?.();
  }

  /* ------------------------------------------------------------------ *
   * 地面物品模型
   * ------------------------------------------------------------------ */

  addGroundItem(entry, model) {
    model.position.set(entry.x, entry.y + 0.25, entry.z);
    model.rotation.y = rand() * Math.PI;
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.dynamicRoot.add(model);
    this.groundItemMeshes.set(entry.uid, model);
  }

  removeGroundItem(uid) {
    const m = this.groundItemMeshes.get(uid);
    if (m) {
      this.dynamicRoot.remove(m);
      this.groundItemMeshes.delete(uid);
    }
  }

  /* ------------------------------------------------------------------ *
   * 鱼池观赏鱼
   * ------------------------------------------------------------------ */

  /** 根据 state.pond 同步鱼池里的鱼（增量） */
  syncPond() {
    const want = new Map(this.state.pond.map((p) => [p.uid, p]));
    // 移除
    for (let i = this.swimmingFish.length - 1; i >= 0; i--) {
      const f = this.swimmingFish[i];
      if (f.kind !== 'pond') continue;
      if (!want.has(f.uid)) {
        this.dynamicRoot.remove(f.obj);
        this.swimmingFish.splice(i, 1);
      }
    }
    const have = new Set(this.swimmingFish.filter((f) => f.kind === 'pond').map((f) => f.uid));
    for (const [uid, p] of want) {
      if (have.has(uid)) continue;
      const fish = buildFish({
        rod: p.rod, color: p.color, special: p.special,
        belly: lighten(p.color, 0.32), fin: darken(p.color, 0.24),
        size: clamp(0.5 + (p.lengthCm || 40) / 130, 0.5, 2.4),
      });
      fish.castShadow = false;
      this.dynamicRoot.add(fish);
      this.swimmingFish.push({
        obj: fish, kind: 'pond', uid,
        angle: p.swim?.angle ?? rand() * 6.28,
        radius: p.swim?.radius ?? 3 + rand() * 5,
        speed: (p.swim?.speed ?? 0.35) * (rand() > 0.5 ? 1 : -1) * 0.35,
        bob: p.swim?.phase ?? 0,
        baseY: POND_WATER_Y - (p.swim?.depth ?? 1) * 0.45,
      });
    }
  }

  /** 烤架上的鱼：把 UI 槽位映射成 3D 小模型 */
  syncGrill(views) {
    for (let i = 0; i < 4; i++) {
      const view = views[i];
      let mesh = this.grillFishMeshes[i];
      if (!view) {
        if (mesh) {
          this.grillGroup.remove(mesh);
          this.grillFishMeshes[i] = null;
        }
        continue;
      }
      if (!mesh || mesh.userData.speciesId !== view.item.speciesId) {
        if (mesh) this.grillGroup.remove(mesh);
        const sp = view.item;
        mesh = buildFish({
          rod: 'rod', color: '#c8a06a', size: 0.32,
          belly: '#e8c79a', fin: '#8a6a44',
        });
        mesh.castShadow = true;
        mesh.userData.speciesId = sp.speciesId;
        // 摆成环形
        const a = (i / 4) * Math.PI * 2;
        mesh.position.set(Math.cos(a) * 0.45, 1.06, Math.sin(a) * 0.45);
        mesh.rotation.y = -a;
        this.grillGroup.add(mesh);
        this.grillFishMeshes[i] = mesh;
      }
      // 烤糊了慢慢变黑
      const burn = clamp((view.t - 34) / 45, 0, 1);
      mesh.visible = true;
      mesh.scale.setScalar(1 - burn * 0.25);
    }
  }

  /* ------------------------------------------------------------------ *
   * 每帧更新
   * ------------------------------------------------------------------ */

  update(dt, ctx) {
    this._time += dt;
    const { dayProgress } = ctx;

    // 天空 / 光照随时间变化
    this._updateSky(dayProgress);

    // 水面波动
    this._updateWater(dt);

    // 云
    for (const c of this.clouds) {
      c.obj.position.x += c.speed * dt;
      if (c.obj.position.x > 320) c.obj.position.x = -320;
    }
    // 海鸥
    for (const g of this.gulls) {
      g.a += g.speed * dt;
      g.flap += dt * 6;
      g.obj.position.set(Math.cos(g.a) * g.r, g.y + Math.sin(g.flap * 0.5) * 0.9, Math.sin(g.a) * g.r);
      g.obj.rotation.y = -g.a + Math.PI / 2;
      g.obj.rotation.z = Math.sin(g.flap) * 0.18;
    }
    // 漂浮的鱼
    for (const f of this.swimmingFish) {
      f.angle += f.speed * dt;
      f.bob += dt * 1.6;
      const y = f.baseY + Math.sin(f.bob) * 0.22;
      f.obj.position.set(Math.cos(f.angle) * f.radius, y, Math.sin(f.angle) * f.radius);
      f.obj.rotation.y = -f.angle + (f.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
    // 小船摇晃
    if (this.boat) {
      this.boat.position.y = WATER_Y + 0.05 + Math.sin(this._time * 0.9) * 0.09;
      this.boat.rotation.z = Math.sin(this._time * 0.7) * 0.035;
    }
    // 火苗
    if (this.flame) {
      const lit = ctx.grillLit;
      this.flame.visible = lit;
      if (lit) {
        const p = 0.7 + Math.sin(this._time * 12) * 0.12 + Math.sin(this._time * 27) * 0.06;
        this.flame.scale.set(p * ctx.flamePower, p * (0.8 + ctx.flamePower * 0.6), p * ctx.flamePower);
        this.flame.rotation.y = this._time * 2.4;
      }
    }
    // NPC 轻微摇摆（呼吸感）
    for (const npc of this.npcs) {
      npc.walkPhase += dt;
      npc.obj.position.y = npc.obj.userData.baseY + Math.sin(npc.walkPhase * 1.6) * 0.02;
    }
  }

  _updateSky(dayProgress) {
    // dayProgress: 0 = 0:00, 1 = 24:00
    const t = dayProgress * 24;
    // 太阳角度：6 点升起，18 点落下
    const sunAngle = ((t - 6) / 12) * Math.PI;
    const sunX = Math.cos(sunAngle) * 220;
    const sunY = Math.sin(sunAngle) * 200;
    this.sun.position.set(sunX, Math.max(-40, sunY), 60);
    this.sunDisc.position.set(sunX * 2, sunY * 2, 120);

    const dayness = clamp(Math.sin(sunAngle) * 1.6, 0, 1);
    const dusk = clamp(1 - Math.abs(Math.sin(sunAngle)) * 3.2, 0, 1);

    this.sun.intensity = 0.15 + dayness * 1.15;
    this.hemi.intensity = 0.22 + dayness * 0.6;
    this.sun.color.setHex(dayness > 0.5 ? 0xfff2d0 : 0xffc98a);

    // 天空颜色
    const night = new THREE.Color('#101a33');
    const dawn = new THREE.Color('#e79a6a');
    const day = new THREE.Color('#4a9de0');
    let top;
    if (dayness < 0.35) {
      top = night.clone().lerp(dawn, dayness / 0.35);
    } else {
      top = dawn.clone().lerp(day, (dayness - 0.35) / 0.65);
    }
    const bottom = top.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    this._tintSky(this.sky.geometry, top, bottom);
    this.stars.material.opacity = clamp(1 - dayness * 2.6, 0, 0.95);
    if (this.scene.fog) {
      // 雾把远处的水面边缘揉进天空色，这样看不到「世界的直边」
      this.scene.fog.color.copy(bottom).lerp(top, 0.25);
      this.scene.fog.near = 110;
      this.scene.fog.far = 380 + dayness * 420;
    }
    this.sunDisc.material.color.setHex(dayness > 0.3 ? 0xfff2c0 : 0xffb070);
  }

  _tintSky(geo, top, bottom) {
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    if (!this._skyTop) this._skyTop = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = clamp((pos.getY(i) / 600) * 0.5 + 0.5, 0, 1);
      const c = bottom.clone().lerp(top, Math.pow(t, 0.7));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  _updateWater(dt) {
    const t = this._time;
    this._ripple(this.water, this._waterBase, t, 0.26, 0.062, 0.9);
    this._ripple(this.farWater, this._farWaterBase, t, 0.05, 0.02, 0.5);
  }

  /** 给一层水面加正弦波（近处起伏大、岸边衰减） */
  _ripple(mesh, base, t, amp, freq, speed) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const z = base[i * 3 + 2];
      const r = Math.hypot(x, z);
      // 低频波，避免密网格上出现摩尔纹
      const wave = Math.sin(x * freq + t * speed) * 0.6 + Math.cos(z * freq * 0.85 + t * speed * 0.8) * 0.4;
      const damp = clamp((r - 44) / 60, 0, 1);
      pos.setY(i, wave * amp * damp);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** 玩家位置查询：地面高度 + 是否在陆地上 */
  heightAt(x, z) {
    return terrainHeight(x, z);
  }

  /** 判断某个点是否在鱼池水里 */
  isInPond(x, z) {
    return Math.hypot(x, z) < POND_RADIUS;
  }

  dispose() {
    this.scene.remove(this.root);
    this.scene.remove(this.dynamicRoot);
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose?.();
    });
  }
}

/* ------------------------------------------------------------------ *
 * 地形几何构造
 * ------------------------------------------------------------------ */

/**
 * 造一个圆形盘状地形：中心到边缘环形细分，高度由 heightFn 决定。
 * 比 PlaneGeometry 更贴合圆形海岛。
 */
function buildDiskGeometry(outerRadius, radialSegments, rings, heightFn) {
  const positions = [];
  const indices = [];
  const seg = Math.max(8, radialSegments);

  // 中心点
  positions.push(0, heightFn(0, 0), 0);

  for (let r = 1; r <= rings; r++) {
    const rr = Math.pow(r / rings, 1.35) * outerRadius;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      positions.push(x, heightFn(x, z), z);
    }
  }

  const idx = (r, s) => 1 + (r - 1) * seg + (s % seg);
  // 中心扇形
  for (let s = 0; s < seg; s++) {
    indices.push(0, idx(1, s + 1), idx(1, s));
  }
  // 环带
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = idx(r, s);
      const b = idx(r, s + 1);
      const c = idx(r + 1, s + 1);
      const d = idx(r + 1, s);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 按高度给地形刷顶点色 */
function paintByHeight(geo, heightFn) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cache = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const key = Math.round(y * 2) + ':' + Math.round(r / 3);
    let c = cache.get(key);
    if (!c) {
      c = new THREE.Color(terrainColor(y, r));
      cache.set(key, c);
    }
    // 加一点每顶点噪点，低模看起来更有手绘感
    const n = 1 + (((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) - 0.5) * 0.09;
    colors[i * 3] = clamp(c.r * n, 0, 1);
    colors[i * 3 + 1] = clamp(c.g * n, 0, 1);
    colors[i * 3 + 2] = clamp(c.b * n, 0, 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
