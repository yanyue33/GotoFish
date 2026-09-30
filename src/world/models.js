/**
 * 低多边形模型工厂。
 *
 * 性能策略（对应策划里「3D 画面一定要流畅」）：
 *  1. 几何体全部合并 + 顶点色，所有场景物件共用一套 flat-shaded 材质，
 *     因此一整个房子 / 一棵树只有 1 次 drawcall 级别的基础开销。
 *  2. 几何体按「参数签名」缓存，重复的模型（几十条鱼、几十棵树）共享同一份 buffer。
 *  3. 只有顶点色，不用贴图，避免纹理上传与带宽。
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 材质
 * ------------------------------------------------------------------ */

export const MAT = {
  solid: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  /** 双面（叶片、鳍、玻璃等） */
  double: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }),
  /** 微微自发光（火、灯泡） */
  glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
  /** 半透明（水、玻璃） */
  water: new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, transparent: true, opacity: 0.78,
  }),
  glass: new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, transparent: true, opacity: 0.42,
  }),
};

/* ------------------------------------------------------------------ *
 * 基础几何构造（带颜色属性）
 * ------------------------------------------------------------------ */

const geoCache = new Map();

/** 给几何体刷上统一颜色 */
export function paint(geo, color) {
  const c = new THREE.Color(color);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * 合并一组「已经应用过变换且带颜色」的几何体。
 * 只保留 position / normal / color，不需要 uv。
 */
export function mergeGeometries(geos) {
  const list = geos.filter((g) => g && g.attributes.position);
  if (list.length === 0) return new THREE.BufferGeometry();
  if (list.length === 1) return list[0].clone();

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const pos = new Float32Array(vertexCount * 3);
  const nrm = new Float32Array(vertexCount * 3);
  const col = new Float32Array(vertexCount * 3);
  const idx = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const c = g.attributes.color;
    const vc = p.count;
    pos.set(p.array.subarray(0, vc * 3), vo * 3);
    if (n) nrm.set(n.array.subarray(0, vc * 3), vo * 3);
    if (c) col.set(c.array.subarray(0, vc * 3), vo * 3);
    else col.fill(1, vo * 3, vo * 3 + vc * 3);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < vc; i++) idx[io + i] = vo + i;
      io += vc;
    }
    vo += vc;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * 取一个基础形状（带缓存）。返回的几何体是「模板」，
 * 需要 copy 之后再做变换，避免污染缓存。
 */
export function shape(kind, params = {}) {
  const key = kind + JSON.stringify(params);
  let g = geoCache.get(key);
  if (g) return g;
  switch (kind) {
    case 'box': {
      const { w = 1, h = 1, d = 1 } = params;
      g = new THREE.BoxGeometry(w, h, d);
      break;
    }
    case 'sphere': {
      const { r = 1, seg = 8, rings = 6 } = params;
      g = new THREE.SphereGeometry(r, seg, rings);
      break;
    }
    case 'ico': {
      const { r = 1, detail = 0 } = params;
      g = new THREE.IcosahedronGeometry(r, detail);
      break;
    }
    case 'cone': {
      const { r = 1, h = 1, seg = 6 } = params;
      g = new THREE.ConeGeometry(r, h, seg);
      break;
    }
    case 'cyl': {
      const { rt = 1, rb = 1, h = 1, seg = 8 } = params;
      g = new THREE.CylinderGeometry(rt, rb, h, seg);
      break;
    }
    case 'torus': {
      const { r = 1, tube = 0.2, rseg = 8, tseg = 6 } = params;
      g = new THREE.TorusGeometry(r, tube, rseg, tseg);
      break;
    }
    case 'plane': {
      const { w = 1, h = 1, ws = 1, hs = 1 } = params;
      g = new THREE.PlaneGeometry(w, h, ws, hs);
      break;
    }
    case 'circle': {
      const { r = 1, seg = 12 } = params;
      g = new THREE.CircleGeometry(r, seg);
      break;
    }
    default:
      g = new THREE.BoxGeometry(1, 1, 1);
  }
  geoCache.set(key, g);
  return g;
}

/** 造一个带变换+颜色的部件 */
export function part(kind, params, color, transform = {}) {
  const g = shape(kind, params).clone();
  applyTransform(g, transform);
  paint(g, color);
  return g;
}

export function applyTransform(g, t = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(t.rx || 0, t.ry || 0, t.rz || 0, 'YXZ');
  q.setFromEuler(e);
  m.compose(
    new THREE.Vector3(t.x || 0, t.y || 0, t.z || 0),
    q,
    new THREE.Vector3(t.sx ?? t.s ?? 1, t.sy ?? t.s ?? 1, t.sz ?? t.s ?? 1)
  );
  g.applyMatrix4(m);
  return g;
}

/** 由部件列表直接造 Mesh */
export function meshFromParts(parts, material = MAT.solid) {
  const geo = mergeGeometries(parts);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ------------------------------------------------------------------ *
 * 角色
 * ------------------------------------------------------------------ */

/**
 * 玩家角色（第三 / 第一人称都用它）。
 * 原点在脚底，朝向 +Z。
 */
export function buildPlayer(colors = {}) {
  const skin = colors.skin || '#e8b98c';
  const shirt = colors.shirt || '#3f7fd6';
  const pants = colors.pants || '#3b4252';
  const hat = colors.hat || '#e8d9a0';
  const boot = colors.boot || '#4a3a2c';

  const parts = [
    // 腿
    part('box', { w: 0.17, h: 0.62, d: 0.19 }, pants, { x: -0.12, y: 0.31 }),
    part('box', { w: 0.17, h: 0.62, d: 0.19 }, pants, { x: 0.12, y: 0.31 }),
    // 鞋
    part('box', { w: 0.19, h: 0.1, d: 0.28 }, boot, { x: -0.12, y: 0.05, z: 0.03 }),
    part('box', { w: 0.19, h: 0.1, d: 0.28 }, boot, { x: 0.12, y: 0.05, z: 0.03 }),
    // 躯干
    part('box', { w: 0.42, h: 0.56, d: 0.26 }, shirt, { y: 0.9 }),
    // 手臂
    part('box', { w: 0.13, h: 0.5, d: 0.15 }, shirt, { x: -0.27, y: 0.9 }),
    part('box', { w: 0.13, h: 0.5, d: 0.15 }, shirt, { x: 0.27, y: 0.9 }),
    // 手
    part('box', { w: 0.12, h: 0.12, d: 0.14 }, skin, { x: -0.27, y: 0.63 }),
    part('box', { w: 0.12, h: 0.12, d: 0.14 }, skin, { x: 0.27, y: 0.63 }),
    // 脖子
    part('box', { w: 0.14, h: 0.08, d: 0.14 }, skin, { y: 1.2 }),
    // 头
    part('box', { w: 0.32, h: 0.32, d: 0.3 }, skin, { y: 1.4 }),
    // 草帽
    part('cyl', { rt: 0.3, rb: 0.32, h: 0.04, seg: 10 }, hat, { y: 1.56 }),
    part('cyl', { rt: 0.14, rb: 0.17, h: 0.14, seg: 10 }, hat, { y: 1.64 }),
  ];
  const group = new THREE.Group();
  const body = meshFromParts(parts);
  group.add(body);
  group.userData.body = body;
  return group;
}

/** NPC：结构与玩家类似，但换个颜色和配饰 */
export function buildNPC(opts = {}) {
  const colors = {
    skin: opts.skin || '#d9a577',
    shirt: opts.shirt || '#c86a4a',
    pants: opts.pants || '#4a4438',
    hat: opts.hat || '#8a6a3a',
    boot: '#3a3128',
  };
  const g = buildPlayer(colors);
  // 胡子 / 围裙之类的小配件
  if (opts.apron) {
    g.add(meshFromParts([
      part('box', { w: 0.36, h: 0.5, d: 0.04 }, opts.apron, { y: 0.88, z: 0.14 }),
    ]));
  }
  if (opts.beard) {
    g.add(meshFromParts([
      part('box', { w: 0.22, h: 0.16, d: 0.1 }, opts.beard, { y: 1.3, z: 0.14 }),
    ]));
  }
  return g;
}

/* ------------------------------------------------------------------ *
 * 鱼
 * ------------------------------------------------------------------ */

/**
 * 建一条低模鱼。朝向 +Z（头在 +Z）。
 * @param {{rod:string,color:string,special?:boolean,size?:number}} opts
 */
export function buildFish(opts = {}) {
  const kind = opts.rod || 'rod';
  const color = opts.color || '#9fb6c9';
  const belly = opts.belly || lighten(color, 0.28);
  const fin = opts.fin || darken(color, 0.22);
  const accent = opts.special ? '#ffd24a' : fin;
  const geos = [];

  const commonFin = (y, z, h, w) => [
    part('cone', { r: w, h, seg: 4 }, fin, { y, z, rx: Math.PI / 2.4 }),
  ];

  switch (kind) {
    case 'crab': {
      // 螃蟹：圆壳 + 两只钳子 + 八条腿
      geos.push(part('sphere', { r: 0.34, seg: 8, rings: 5 }, color, { sy: 0.62 }));
      geos.push(part('box', { w: 0.5, h: 0.12, d: 0.3 }, belly, { y: -0.05 }));
      for (const s of [-1, 1]) {
        geos.push(part('box', { w: 0.16, h: 0.1, d: 0.2 }, accent, { x: s * 0.42, y: 0.02, z: 0.28, rz: s * 0.5 }));
        geos.push(part('box', { w: 0.1, h: 0.08, d: 0.14 }, accent, { x: s * 0.55, y: 0.02, z: 0.4, rz: -s * 0.6 }));
        for (let i = 0; i < 4; i++) {
          geos.push(part('box', { w: 0.26, h: 0.05, d: 0.05 }, fin, { x: s * 0.34, y: -0.1, z: 0.14 - i * 0.14, rz: s * 0.35 }));
        }
        geos.push(part('box', { w: 0.09, h: 0.09, d: 0.09 }, '#1b1b1b', { x: s * 0.14, y: 0.16, z: 0.24 }));
      }
      break;
    }
    case 'shrimp': {
      geos.push(part('sphere', { r: 0.16, seg: 7, rings: 5 }, color, { z: 0.2, sy: 0.9 }));
      for (let i = 0; i < 4; i++) {
        geos.push(part('sphere', { r: 0.15 - i * 0.02, seg: 7, rings: 5 }, i % 2 ? belly : color, { z: -0.05 - i * 0.2, y: -i * 0.02 }));
      }
      geos.push(part('cone', { r: 0.16, h: 0.24, seg: 5 }, fin, { z: -0.95, rx: -Math.PI / 2 }));
      geos.push(part('cone', { r: 0.06, h: 0.2, seg: 4 }, accent, { z: 0.36, rx: Math.PI / 2 }));
      for (const s of [-1, 1]) {
        geos.push(part('box', { w: 0.03, h: 0.03, d: 0.3 }, accent, { x: s * 0.12, y: 0.08, z: 0.34, ry: s * 0.4, rx: -0.5 }));
      }
      break;
    }
    case 'squid': {
      geos.push(part('cone', { r: 0.24, h: 0.6, seg: 7 }, color, { z: -0.2, rx: -Math.PI / 2, sz: 1.3 }));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        geos.push(part('cyl', { rt: 0.03, rb: 0.015, h: 0.5, seg: 4 }, belly, {
          x: Math.cos(a) * 0.08, y: Math.sin(a) * 0.08, z: 0.42, rx: Math.PI / 2,
        }));
      }
      for (const s of [-1, 1]) {
        geos.push(part('box', { w: 0.05, h: 0.05, d: 0.05 }, '#1b1b1b', { x: s * 0.15, y: 0.05, z: -0.05 }));
        geos.push(part('cone', { r: 0.16, h: 0.22, seg: 4 }, accent, { x: s * 0.2, z: -0.4, rz: s * 1.2 }));
      }
      break;
    }
    case 'flat': {
      geos.push(part('sphere', { r: 0.42, seg: 8, rings: 5 }, color, { sy: 0.34, sz: 1.25 }));
      geos.push(part('sphere', { r: 0.36, seg: 8, rings: 5 }, belly, { y: -0.06, sy: 0.14, sz: 1.2 }));
      geos.push(...commonFin(0.02, -0.55, 0.34, 0.28));
      for (const s of [-1, 1]) {
        geos.push(part('cone', { r: 0.16, h: 0.3, seg: 4 }, fin, { x: s * 0.4, y: -0.02, rz: s * 1.2 }));
        geos.push(part('box', { w: 0.07, h: 0.07, d: 0.07 }, '#1b1b1b', { x: s * 0.14, y: 0.14, z: 0.32 }));
      }
      break;
    }
    case 'eel': {
      geos.push(part('sphere', { r: 0.2, seg: 7, rings: 5 }, color, { z: 0.45, sy: 0.85 }));
      for (let i = 0; i < 8; i++) {
        const r = 0.19 - i * 0.014;
        geos.push(part('sphere', { r, seg: 6, rings: 4 }, i % 2 ? color : belly, {
          z: 0.2 - i * 0.24, y: Math.sin(i * 0.9) * 0.07, sy: 0.8,
        }));
      }
      geos.push(part('cone', { r: 0.13, h: 0.4, seg: 4 }, fin, { z: -1.85, rx: -Math.PI / 2, sy: 1.6 }));
      geos.push(part('cone', { r: 0.35, h: 0.5, seg: 4 }, accent, { z: -1.2, y: 0.22, rx: 0.35, sy: 0.16 }));
      for (const s of [-1, 1]) geos.push(part('box', { w: 0.06, h: 0.06, d: 0.06 }, '#120f0f', { x: s * 0.11, y: 0.06, z: 0.56 }));
      break;
    }
    case 'bill': {
      geos.push(part('sphere', { r: 0.3, seg: 8, rings: 5 }, color, { sz: 1.9 }));
      geos.push(part('sphere', { r: 0.26, seg: 8, rings: 5 }, belly, { y: -0.1, sy: 0.5, sz: 1.8 }));
      geos.push(part('cone', { r: 0.06, h: 1.2, seg: 5 }, fin, { z: 1.0, rx: Math.PI / 2 }));
      geos.push(part('cone', { r: 0.4, h: 0.8, seg: 4 }, accent, { z: -0.7, y: 0.36, rx: 0.25, sy: 0.25 }));
      geos.push(...commonFin(-0.28, -0.5, 0.5, 0.4));
      for (const s of [-1, 1]) {
        geos.push(part('cone', { r: 0.22, h: 0.5, seg: 4 }, fin, { x: s * 0.32, y: -0.05, z: -0.1, rz: s * 1.25, sy: 0.4 }));
        geos.push(part('box', { w: 0.07, h: 0.07, d: 0.07 }, '#1b1b1b', { x: s * 0.13, y: 0.1, z: 0.5 }));
      }
      break;
    }
    case 'body':
    default: {
      // 通用「有肉」的鱼
      geos.push(part('sphere', { r: 0.34, seg: 8, rings: 5 }, color, { sz: 1.8, sy: 0.78 }));
      geos.push(part('sphere', { r: 0.3, seg: 8, rings: 5 }, belly, { y: -0.1, sy: 0.32, sz: 1.6 }));
      geos.push(part('cone', { r: 0.34, h: 0.44, seg: 5 }, fin, { z: -0.72, rx: -Math.PI / 2, sy: 1.25 }));
      geos.push(...commonFin(0.24, -0.3, 0.4, 0.32));
      if (kind === 'body') geos.push(part('cone', { r: 0.14, h: 0.26, seg: 4 }, accent, { y: -0.3, z: 0.1, rx: 0.6 }));
      for (const s of [-1, 1]) {
        geos.push(part('cone', { r: 0.16, h: 0.28, seg: 4 }, fin, { x: s * 0.3, y: -0.05, z: -0.12, rz: s * 1.2 }));
        geos.push(part('box', { w: 0.08, h: 0.08, d: 0.08 }, '#12100f', { x: s * 0.15, y: 0.08, z: 0.42 }));
      }
      if (opts.special) {
        // 特殊鱼加个光环 + 高鳍，让人一眼看出值钱
        geos.push(part('torus', { r: 0.5, tube: 0.03, rseg: 6, tseg: 10 }, '#ffe98a', { z: -0.1, ry: Math.PI / 2 }));
      }
      break;
    }
  }

  const geo = mergeGeometries(geos);
  const mesh = new THREE.Mesh(geo, MAT.solid);
  mesh.castShadow = true;
  if (opts.size) mesh.scale.setScalar(opts.size);
  return mesh;
}

/* ------------------------------------------------------------------ *
 * 海产品
 * ------------------------------------------------------------------ */

export function buildSeaProduct(opts = {}) {
  const shapeKind = opts.shape || 'shell';
  const color = opts.color || '#d9cdb4';
  const g = [];
  switch (shapeKind) {
    case 'strand': {
      for (let i = 0; i < 4; i++) {
        g.push(part('box', { w: 0.1, h: 0.02, d: 0.7 }, i % 2 ? color : darken(color, 0.2), {
          x: (i - 1.5) * 0.11, y: 0.01, rz: (i - 1.5) * 0.12, ry: (i % 2) * 0.3,
        }));
      }
      break;
    }
    case 'conch': {
      g.push(part('cone', { r: 0.22, h: 0.5, seg: 10 }, color, { rx: Math.PI / 2.3, sz: 0.9 }));
      g.push(part('sphere', { r: 0.19, seg: 8, rings: 6 }, lighten(color, 0.15), { z: -0.24, sy: 0.9 }));
      g.push(part('cone', { r: 0.08, h: 0.2, seg: 6 }, darken(color, 0.3), { z: 0.3, rx: Math.PI / 2 }));
      break;
    }
    case 'crab': {
      g.push(part('sphere', { r: 0.3, seg: 8, rings: 5 }, color, { sy: 0.5 }));
      for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
        g.push(part('box', { w: 0.24, h: 0.04, d: 0.04 }, darken(color, 0.2), { x: s * 0.3, y: -0.06, z: 0.12 - i * 0.12, rz: s * 0.4 }));
      }
      break;
    }
    case 'coral': {
      for (let i = 0; i < 5; i++) {
        const a = i * 1.3;
        g.push(part('cyl', { rt: 0.03, rb: 0.06, h: 0.5 + i * 0.08, seg: 5 }, i % 2 ? color : darken(color, 0.18), {
          x: Math.cos(a) * 0.12, z: Math.sin(a) * 0.12, y: 0.25 + i * 0.04, rz: Math.cos(a) * 0.4, rx: Math.sin(a) * 0.4,
        }));
      }
      break;
    }
    case 'seahorse': {
      g.push(part('cyl', { rt: 0.06, rb: 0.04, h: 0.4, seg: 6 }, color, { y: 0.2, rz: 0.1 }));
      g.push(part('sphere', { r: 0.1, seg: 7, rings: 5 }, lighten(color, 0.15), { y: 0.44, z: 0.04 }));
      g.push(part('cone', { r: 0.05, h: 0.16, seg: 5 }, color, { y: 0.44, z: 0.16, rx: Math.PI / 2 }));
      g.push(part('sphere', { r: 0.06, seg: 6, rings: 4 }, color, { y: 0.02, z: -0.08, sy: 1.4 }));
      break;
    }
    case 'pearl': {
      g.push(part('sphere', { r: 0.16, seg: 12, rings: 9 }, color));
      break;
    }
    case 'shell':
    default: {
      g.push(part('sphere', { r: 0.24, seg: 9, rings: 5 }, color, { sy: 0.42, sz: 0.86 }));
      g.push(part('sphere', { r: 0.2, seg: 9, rings: 5 }, lighten(color, 0.2), { y: 0.05, sy: 0.3, sz: 0.8 }));
      for (let i = -2; i <= 2; i++) {
        g.push(part('box', { w: 0.02, h: 0.03, d: 0.4 }, darken(color, 0.18), { x: i * 0.08, y: 0.06, ry: i * 0.18, rz: 0.06 }));
      }
      break;
    }
  }
  const mesh = new THREE.Mesh(mergeGeometries(g), MAT.solid);
  mesh.castShadow = true;
  return mesh;
}

/* ------------------------------------------------------------------ *
 * 场景道具
 * ------------------------------------------------------------------ */

export function buildPalmTree(height = 6, seed = 0) {
  const rnd = mulberry(seed);
  const trunkColor = '#8a6a44';
  const leafColor = '#4f8f3f';
  const parts = [];
  const segs = 6;
  let x = 0;
  let z = 0;
  const lean = (rnd() - 0.5) * 1.6;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const r = 0.28 * (1 - t * 0.55);
    x += lean * 0.12;
    z += (rnd() - 0.5) * 0.1;
    parts.push(part('cyl', { rt: r * 0.92, rb: r, h: height / segs + 0.05, seg: 7 }, i % 2 ? trunkColor : darken(trunkColor, 0.12), {
      x, z, y: (i + 0.5) * (height / segs), rz: lean * 0.05,
    }));
  }
  const topY = height;
  // 椰子
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2;
    parts.push(part('sphere', { r: 0.14, seg: 7, rings: 5 }, '#6b4a2a', {
      x: x + Math.cos(a) * 0.24, y: topY - 0.2, z: z + Math.sin(a) * 0.24,
    }));
  }
  // 叶片
  const leaves = 7;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2 + rnd() * 0.4;
    const len = 2.2 + rnd() * 1.6;
    const droop = 0.5 + rnd() * 0.5;
    parts.push(part('box', { w: len, h: 0.06, d: 0.55 }, i % 2 ? leafColor : darken(leafColor, 0.16), {
      x: x + Math.cos(a) * len * 0.45,
      z: z + Math.sin(a) * len * 0.45,
      y: topY + 0.3 - droop * 0.35,
      ry: -a, rz: -droop * 0.5,
    }));
    parts.push(part('box', { w: len * 0.6, h: 0.05, d: 0.34 }, darken(leafColor, 0.1), {
      x: x + Math.cos(a) * len * 0.75,
      z: z + Math.sin(a) * len * 0.75,
      y: topY + 0.1 - droop * 0.7,
      ry: -a, rz: -droop * 0.85,
    }));
  }
  return meshFromParts(parts);
}

export function buildRock(size = 1, seed = 0) {
  const rnd = mulberry(seed);
  const parts = [];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = size * (0.35 + rnd() * 0.4);
    parts.push(part('ico', { r, detail: 0 }, rnd() > 0.5 ? '#7d7f85' : '#6a6c72', {
      x: (rnd() - 0.5) * size * 1.1,
      y: r * (0.4 + rnd() * 0.3),
      z: (rnd() - 0.5) * size * 1.1,
      ry: rnd() * 3, s: 1,
    }));
  }
  return meshFromParts(parts);
}

export function buildBush(size = 1, seed = 0, color = '#4f8f3f') {
  const rnd = mulberry(seed);
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(part('ico', { r: size * (0.35 + rnd() * 0.25), detail: 0 }, i % 2 ? color : darken(color, 0.15), {
      x: (rnd() - 0.5) * size * 0.6,
      y: size * (0.3 + rnd() * 0.2),
      z: (rnd() - 0.5) * size * 0.6,
    }));
  }
  return meshFromParts(parts);
}

export function buildGrassTuft(seed = 0) {
  const rnd = mulberry(seed);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const h = 0.3 + rnd() * 0.4;
    parts.push(part('cone', { r: 0.05, h, seg: 3 }, i % 2 ? '#5d9b45' : '#4c8a3a', {
      x: (rnd() - 0.5) * 0.3, z: (rnd() - 0.5) * 0.3, y: h / 2,
      rz: (rnd() - 0.5) * 0.5, rx: (rnd() - 0.5) * 0.5,
    }));
  }
  return meshFromParts(parts);
}

/** 小木屋（商店） */
export function buildShopHouse(colors = {}) {
  const wall = colors.wall || '#d8b98a';
  const roof = colors.roof || '#a8452f';
  const wood = colors.wood || '#8a6640';
  const parts = [
    part('box', { w: 7, h: 3.4, d: 5.4 }, wall, { y: 1.7 }),
    part('box', { w: 7.4, h: 0.3, d: 5.8 }, wood, { y: 3.5 }),
    // 屋顶（两层斜坡）
    part('box', { w: 7.8, h: 0.3, d: 3.4 }, roof, { y: 4.2, z: -1.2, rx: -0.5 }),
    part('box', { w: 7.8, h: 0.3, d: 3.4 }, roof, { y: 4.2, z: 1.2, rx: 0.5 }),
    // 门
    part('box', { w: 1.4, h: 2.2, d: 0.15 }, wood, { y: 1.1, z: 2.72 }),
    // 窗
    part('box', { w: 1.2, h: 1.0, d: 0.12 }, '#8fd4e8', { x: -2.2, y: 2.0, z: 2.72 }),
    part('box', { w: 1.2, h: 1.0, d: 0.12 }, '#8fd4e8', { x: 2.2, y: 2.0, z: 2.72 }),
  ];
  return meshFromParts(parts);
}

/** 商店柜台 + 货架 + 招牌（商品摆在室外，对应策划） */
export function buildShopCounter() {
  const wood = '#9c7648';
  const dark = '#6f5230';
  const parts = [
    part('box', { w: 5.4, h: 1.0, d: 1.2 }, wood, { y: 0.5 }),
    part('box', { w: 5.6, h: 0.12, d: 1.4 }, dark, { y: 1.05 }),
    // 遮阳棚
    part('box', { w: 5.6, h: 0.1, d: 2.6 }, '#e8e0d0', { y: 2.8, z: 1.0, rx: 0.18 }),
    part('cyl', { rt: 0.08, rb: 0.08, h: 2.8, seg: 6 }, dark, { x: -2.7, y: 1.4, z: 2.1 }),
    part('cyl', { rt: 0.08, rb: 0.08, h: 2.8, seg: 6 }, dark, { x: 2.7, y: 1.4, z: 2.1 }),
    // 红白条纹棚边
    ...Array.from({ length: 9 }, (_, i) =>
      part('box', { w: 0.6, h: 0.06, d: 0.1 }, i % 2 ? '#d9534f' : '#f5f0e6', { x: -2.4 + i * 0.6, y: 2.7, z: 2.28 })
    ),
  ];
  return meshFromParts(parts);
}

/** 简易货架，用来摆鱼饵罐之类 */
export function buildShelf() {
  const wood = '#8a6640';
  const parts = [
    part('box', { w: 2.6, h: 0.12, d: 0.6 }, wood, { y: 0.9 }),
    part('box', { w: 2.6, h: 0.12, d: 0.6 }, wood, { y: 1.7 }),
    part('box', { w: 0.12, h: 2.0, d: 0.6 }, darken(wood, 0.15), { x: -1.24, y: 1.0 }),
    part('box', { w: 0.12, h: 2.0, d: 0.6 }, darken(wood, 0.15), { x: 1.24, y: 1.0 }),
  ];
  return meshFromParts(parts);
}

/** 烧烤架 */
export function buildGrill() {
  const metal = '#4a4f56';
  const stone = '#8b8378';
  const parts = [
    // 石台
    part('cyl', { rt: 1.0, rb: 1.15, h: 0.9, seg: 10 }, stone, { y: 0.45 }),
    part('cyl', { rt: 1.05, rb: 1.05, h: 0.12, seg: 10 }, darken(stone, 0.2), { y: 0.94 }),
    // 烤网
    part('cyl', { rt: 0.85, rb: 0.85, h: 0.06, seg: 12 }, metal, { y: 0.98 }),
    ...Array.from({ length: 5 }, (_, i) =>
      part('box', { w: 1.7, h: 0.03, d: 0.05 }, darken(metal, 0.25), { y: 1.02, ry: (i / 5) * Math.PI })
    ),
    // 炭火（初始熄灭）
    part('cyl', { rt: 0.7, rb: 0.7, h: 0.12, seg: 10 }, '#2a2622', { y: 0.86 }),
    // 烟囱
    part('box', { w: 0.5, h: 1.6, d: 0.5 }, stone, { x: 0.95, y: 1.7, z: -0.5 }),
  ];
  const mesh = meshFromParts(parts);
  return mesh;
}

/** 火苗（独立 mesh，方便动画/开关） */
export function buildFlame() {
  const parts = [
    part('cone', { r: 0.55, h: 1.2, seg: 5 }, '#ff8a2b', { y: 0.6 }),
    part('cone', { r: 0.34, h: 0.85, seg: 5 }, '#ffd24a', { y: 0.5 }),
    part('cone', { r: 0.16, h: 0.5, seg: 4 }, '#fff3c4', { y: 0.38 }),
  ];
  const mesh = meshFromParts(parts, MAT.double);
  mesh.castShadow = false;
  return mesh;
}

/** 木栈桥的一段 */
export function buildPierSegment(length = 4, width = 3.2) {
  const wood = '#9c7648';
  const dark = '#6f5230';
  const parts = [
    ...Array.from({ length: Math.round(length / 0.5) }, (_, i) =>
      part('box', { w: width, h: 0.12, d: 0.42 }, i % 2 ? wood : darken(wood, 0.08), { z: i * 0.5 })
    ),
    part('box', { w: 0.24, h: 0.24, d: length }, dark, { x: -width / 2 + 0.2, y: -0.16 }),
    part('box', { w: 0.24, h: 0.24, d: length }, dark, { x: width / 2 - 0.2, y: -0.16 }),
  ];
  return meshFromParts(parts);
}

/** 鱼池围栏 / 装饰石头圈 */
export function buildPondRim(radius = 11, count = 18, seed = 7) {
  const rnd = mulberry(seed);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = radius + (rnd() - 0.5) * 0.6;
    const s = 0.6 + rnd() * 0.5;
    parts.push(part('ico', { r: s, detail: 0 }, i % 2 ? '#8a8d94' : '#767a80', {
      x: Math.cos(a) * r, z: Math.sin(a) * r, y: s * 0.4, ry: rnd() * 3,
    }));
  }
  return meshFromParts(parts);
}

/** 码头 / 栈桥支柱 */
export function buildPiling(height = 2.2) {
  return meshFromParts([
    part('cyl', { rt: 0.16, rb: 0.18, h: height, seg: 6 }, '#6f5230', { y: height / 2 }),
    part('cyl', { rt: 0.2, rb: 0.2, h: 0.1, seg: 6 }, '#4d3620', { y: height - 0.1 }),
  ]);
}

/** 小木船（可解锁，开到外海） */
export function buildBoat() {
  const hull = '#8a6640';
  const parts = [
    part('box', { w: 1.8, h: 0.5, d: 4.4 }, hull, { y: 0.2 }),
    part('box', { w: 2.0, h: 0.16, d: 4.6 }, darken(hull, 0.2), { y: 0.44 }),
    part('box', { w: 1.4, h: 0.1, d: 3.2 }, '#c9a978', { y: 0.3, z: 0.2 }),
    part('box', { w: 0.9, h: 0.5, d: 0.3 }, '#7a5a3a', { y: 0.62, z: -1.9 }),
    part('box', { w: 0.9, h: 0.5, d: 0.3 }, '#7a5a3a', { y: 0.62, z: 1.9 }),
  ];
  return meshFromParts(parts);
}

/** 路灯 / 火把 */
export function buildLamp() {
  return meshFromParts([
    part('cyl', { rt: 0.07, rb: 0.1, h: 2.6, seg: 6 }, '#5a4a3a', { y: 1.3 }),
    part('box', { w: 0.36, h: 0.4, d: 0.36 }, '#ffd98a', { y: 2.8 }),
    part('box', { w: 0.46, h: 0.08, d: 0.46 }, '#4a3a2a', { y: 3.02 }),
  ]);
}

/** 海鸥 */
export function buildSeagull() {
  return meshFromParts([
    part('sphere', { r: 0.22, seg: 7, rings: 5 }, '#f4f4f4', { sz: 1.5 }),
    part('cone', { r: 0.06, h: 0.18, seg: 4 }, '#f0b030', { z: 0.36, rx: Math.PI / 2 }),
    part('box', { w: 1.1, h: 0.05, d: 0.3 }, '#e8e8e8', { y: 0.08, rz: 0.16 }),
    part('box', { w: 1.1, h: 0.05, d: 0.3 }, '#dcdcdc', { y: 0.08, rz: -0.16, x: -0.9 }),
  ]);
}

/** 云 */
export function buildCloud(seed = 0) {
  const rnd = mulberry(seed);
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(part('ico', { r: 1 + rnd() * 0.8, detail: 0 }, '#ffffff', {
      x: (rnd() - 0.5) * 4, y: (rnd() - 0.5) * 0.6, z: (rnd() - 0.5) * 3,
    }));
  }
  return meshFromParts(parts, MAT.solid);
}

/* ------------------------------------------------------------------ *
 * 物品图标 / 手持模型
 * ------------------------------------------------------------------ */

/**
 * 给 UI（背包格、检视面板）与手持渲染用的「物品小模型」。
 * 返回一个新的 Object3D，调用方负责挂到场景里。
 */
export function buildItemModel(item, opts = {}) {
  const kind = item.kind === 'cooked' ? 'fish' : item.kind;
  const sp = opts.species || null;
  const rod = sp ? sp.rod : 'rod';
  const color = sp ? sp.color : '#9fb6c9';
  const special = !!(sp && sp.special);
  const scale = opts.scale ?? 1;

  let obj;
  if (kind === 'rod') {
    obj = buildHandRod(opts.rodDef);
  } else if (kind === 'bait') {
    obj = buildBaitBlob(sp);
  } else if (kind === 'sea') {
    obj = buildSeaProduct({ shape: sp ? sp.shape : 'shell', color });
  } else {
    obj = buildFish({ rod, color, special, belly: lighten(color, 0.3), fin: darken(color, 0.25) });
  }
  obj.scale.multiplyScalar(scale);
  return obj;
}

/** 手持钓竿：原点在握把，竿身向 +Z 延伸 */
export function buildHandRod(rodDef) {
  const color = rodDef ? rodDef.color : '#c8a24a';
  const accent = rodDef ? rodDef.accent : '#7a5a24';
  const tier = rodDef ? rodDef.tier : 1;
  const len = 2.2 + tier * 0.12;
  const parts = [
    // 握把
    part('cyl', { rt: 0.05, rb: 0.055, h: 0.34, seg: 8 }, '#3a2f28', { z: 0.0 }),
    // 卷线器
    part('cyl', { rt: 0.09, rb: 0.09, h: 0.1, seg: 10 }, accent, { z: 0.16, rx: Math.PI / 2 }),
    part('box', { w: 0.04, h: 0.16, d: 0.04 }, accent, { z: 0.16, y: -0.12 }),
    // 竿身（分段渐细）
    part('cyl', { rt: 0.035, rb: 0.05, h: len * 0.5, seg: 7 }, color, { z: 0.3 + len * 0.25, rx: Math.PI / 2 }),
    part('cyl', { rt: 0.02, rb: 0.035, h: len * 0.5, seg: 7 }, color, { z: 0.3 + len * 0.75, rx: Math.PI / 2 }),
  ];
  // 导环
  const rings = 3 + tier;
  for (let i = 0; i < rings; i++) {
    parts.push(part('torus', { r: 0.06, tube: 0.012, rseg: 5, tseg: 6 }, accent, {
      z: 0.45 + (i / rings) * len, y: 0.07,
    }));
  }
  return meshFromParts(parts);
}

/** 鱼饵：罐子 / 假饵 */
export function buildBaitBlob(baitDef) {
  const color = baitDef ? baitDef.color : '#d08a6a';
  const tier = baitDef ? baitDef.tier : 1;
  if (tier >= 4) {
    // 亮片 / 路亚
    return meshFromParts([
      part('sphere', { r: 0.12, seg: 8, rings: 6 }, color, { sz: 1.6 }),
      part('cone', { r: 0.1, h: 0.2, seg: 5 }, color, { z: -0.2, rx: -Math.PI / 2 }),
      part('box', { w: 0.02, h: 0.16, d: 0.02 }, '#c8ccd4', { y: 0.2 }),
      part('box', { w: 0.1, h: 0.03, d: 0.03 }, '#c8ccd4', { y: 0.28 }),
    ]);
  }
  return meshFromParts([
    part('cyl', { rt: 0.16, rb: 0.14, h: 0.4, seg: 10 }, '#c8bfa8', {}),
    part('cyl', { rt: 0.17, rb: 0.17, h: 0.06, seg: 10 }, '#8a7a5a', { y: 0.22 }),
    part('sphere', { r: 0.13, seg: 8, rings: 6 }, color, { y: 0.26, sy: 0.7 }),
  ]);
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lighten(hex, amount) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color('#ffffff'), amount);
  return '#' + c.getHexString();
}

export function darken(hex, amount) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color('#000000'), amount);
  return '#' + c.getHexString();
}

/** 释放几何体缓存（切画质档时用不到，但留个口子） */
export function disposeGeometryCache() {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

export { THREE };
