/**
 * 设置：鼠标灵敏度、视野、画质档位、音量、准星、画面特效。
 * 独立存储键，和存档分开（换存档不该丢设置）。
 */

import { clamp } from '../core/rng.js';

export const SETTINGS_KEY = 'gotofish.settings.v1';

export const QUALITY_PRESETS = {
  low: {
    label: '流畅',
    pixelRatio: 0.85,
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    waterDetail: 32,
    grassCount: 120,
    treeCount: 14,
    fishDetail: 6,
    particleCount: 60,
    drawDistance: 260,
    environmentProps: 40,
  },
  medium: {
    label: '均衡',
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    antialias: true,
    waterDetail: 48,
    grassCount: 320,
    treeCount: 22,
    fishDetail: 10,
    particleCount: 140,
    drawDistance: 380,
    environmentProps: 90,
  },
  high: {
    label: '精细',
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    waterDetail: 72,
    grassCount: 620,
    treeCount: 30,
    fishDetail: 16,
    particleCount: 240,
    drawDistance: 520,
    environmentProps: 150,
  },
};

export const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  invertY: false,
  fov: 72,
  quality: 'medium',
  masterVolume: 0.7,
  sfxVolume: 0.8,
  ambienceVolume: 0.5,
  crosshair: true,
  screenShake: true,
  headBob: true,
  showFps: false,
  autoRun: false,
  /** 张力条显示数值（关闭则只能靠颜色判断，更有挑战） */
  showTensionNumbers: true,
  /** 抛竿辅助线 */
  castAssist: true,
};

export class Settings {
  constructor(storage, onChange) {
    this.storage = storage;
    this.onChange = onChange || (() => {});
    this.values = { ...DEFAULT_SETTINGS };
    this.load();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    this.values[key] = value;
    this.save();
    this.onChange(key, value);
  }

  patch(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (k in DEFAULT_SETTINGS) this.values[k] = v;
    }
    this.save();
    this.onChange('*', this.values);
  }

  reset() {
    this.values = { ...DEFAULT_SETTINGS };
    this.save();
    this.onChange('*', this.values);
  }

  get preset() {
    return QUALITY_PRESETS[this.values.quality] || QUALITY_PRESETS.medium;
  }

  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k in data) this.values[k] = data[k];
      }
      this.values.sensitivity = clamp(Number(this.values.sensitivity) || 1, 0.1, 5);
      this.values.fov = clamp(Number(this.values.fov) || 72, 50, 110);
      if (!QUALITY_PRESETS[this.values.quality]) this.values.quality = 'medium';
    } catch (err) {
      console.warn('[settings] 读取失败，用默认值', err);
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(this.values));
    } catch {
      /* 忽略：隐私模式下写不了 */
    }
  }
}
