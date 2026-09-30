/**
 * 3D 图标渲染器。
 *
 * 目的：让背包格、检视面板、统计面板里显示的东西**真的是那件东西的模型**
 * （鱼的形状随鱼种变化），而不是一张通用贴图。
 * 做法：一个独立的离屏 WebGL 渲染器按需渲染，再取 dataURL 缓存起来。
 * 这样只在物品第一次出现时渲染一次，运行时零开销。
 */

import * as THREE from 'three';
import { MAT, buildItemModel, buildFish, buildHandRod, buildSeaProduct, buildBaitBlob } from '../world/models.js';
import { speciesOf, kindOf, ROD_BY_ID, BAIT_BY_ID } from '../data/items.js';

export class IconRenderer {
  constructor() {
    this.size = 128;
    this.cache = new Map();
    this.supported = true;
    try {
      this.renderer = new THREE.WebGLRenderer({
        alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power',
      });
      this.renderer.setSize(this.size, this.size, false);
      this.renderer.setClearColor(0x000000, 0);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      this.scene.add(new THREE.HemisphereLight('#ffffff', '#8899aa', 1.15));
      const key = new THREE.DirectionalLight('#fff4d8', 1.35);
      key.position.set(3, 5, 4);
      this.scene.add(key);
      const rim = new THREE.DirectionalLight('#8fc8ff', 0.75);
      rim.position.set(-4, 2, -3);
      this.scene.add(rim);
      this.pivot = new THREE.Group();
      this.scene.add(this.pivot);
    } catch (err) {
      console.warn('[icons] 无法创建离屏渲染器，图标将退化为文字', err);
      this.supported = false;
    }
  }

  /**
   * 取一个物品的图标 dataURL。
   * @param {object} item
   * @param {number} [angle] 旋转角度（弧度），用于不同朝向
   */
  get(item, angle = Math.PI * 0.75) {
    const key = `${item.kind}:${item.speciesId}:${item.cookStage || ''}:${Math.round(angle * 100)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.supported) return '';
    let url = '';
    try {
      url = this._render(item, angle);
    } catch (err) {
      console.warn('[icons] 渲染失败', err);
      url = '';
    }
    this.cache.set(key, url);
    return url;
  }

  _render(item, angle) {
    const kind = kindOf(item);
    const sp = speciesOf(kind, item.speciesId);
    // 清空
    while (this.pivot.children.length) {
      const c = this.pivot.children.pop();
      c.traverse?.((o) => o.geometry?.dispose?.());
      this.pivot.remove(c);
    }

    let model;
    if (kind === 'rod') {
      const def = ROD_BY_ID.get(item.speciesId);
      model = buildHandRod(def);
      // 竿比较长，斜着放好看
      model.rotation.set(0.2, angle, 1.1);
      model.position.set(0, 0, 0);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3()).length();
      model.scale.setScalar(2.6 / Math.max(1, size));
    } else if (kind === 'sea') {
      model = buildSeaProduct({ shape: sp?.shape, color: sp?.color });
      model.rotation.y = angle;
      model.rotation.x = -0.2;
      fitModel(model, 1.5);
    } else if (kind === 'bait') {
      model = buildBaitBlob(sp);
      model.rotation.y = angle;
      fitModel(model, 1.5);
    } else {
      const cooked = kind === 'cooked';
      model = buildFish({
        rod: sp?.rod,
        color: cooked ? '#b98a52' : sp?.color,
        belly: cooked ? '#e0b478' : undefined,
        special: sp?.special,
        fin: cooked ? '#7a5a34' : undefined,
      });
      model.rotation.y = angle;
      model.rotation.z = 0.08;
      // 烤糊了变黑
      if (cooked) {
        const burn = Math.max(0, Math.min(1, ((item.cookT || 0) - 48) / 45));
        model.traverse((o) => {
          if (o.isMesh) {
            o.material = MAT.solid.clone();
            o.material.vertexColors = true;
            o.material.color.setRGB(1 - burn * 0.8, 1 - burn * 0.82, 1 - burn * 0.85);
          }
        });
      }
      fitModel(model, Math.max(1.6, Math.min(2.3, 0.9 + (sp?.avgCm || 40) / 90)));
    }
    this.pivot.add(model);

    this.camera.position.set(0, 0.6, 3.4);
    this.camera.lookAt(0, 0.1, 0);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

function fitModel(model, target) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = target / maxDim;
  model.scale.multiplyScalar(s);
  const box2 = new THREE.Box3().setFromObject(model);
  const center = box2.getCenter(new THREE.Vector3());
  model.position.sub(center);
}

/** 全局单例（懒初始化） */
let _icons = null;
export function icons() {
  if (!_icons) {
    try {
      _icons = new IconRenderer();
    } catch {
      _icons = { supported: false, get: () => '' };
    }
  }
  return _icons;
}
