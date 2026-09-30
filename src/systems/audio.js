/**
 * 音效：全部用 WebAudio 现场合成，不加载任何音频文件。
 * 好处：零资源、零体积、不会被浏览器自动播放策略以外的因素卡住。
 *
 * 使用方式：game.audio.play('catch')
 */

export const SOUNDS = {
  uiClick: [{ type: 'square', freq: 620, dur: 0.05, gain: 0.12 }],
  uiOpen: [{ type: 'sine', freq: 420, to: 720, dur: 0.14, gain: 0.14 }],
  uiClose: [{ type: 'sine', freq: 620, to: 300, dur: 0.12, gain: 0.12 }],
  pickup: [{ type: 'triangle', freq: 560, to: 980, dur: 0.12, gain: 0.16 }],
  coin: [
    { type: 'triangle', freq: 880, dur: 0.07, gain: 0.16 },
    { type: 'triangle', freq: 1320, dur: 0.1, gain: 0.14, delay: 0.06 },
  ],
  cast: [{ type: 'sine', freq: 260, to: 90, dur: 0.32, gain: 0.16, noise: 0.25 }],
  splash: [{ type: 'sine', freq: 180, to: 60, dur: 0.35, gain: 0.22, noise: 0.7 }],
  bite: [
    { type: 'square', freq: 300, to: 520, dur: 0.07, gain: 0.12 },
    { type: 'square', freq: 300, to: 520, dur: 0.07, gain: 0.12, delay: 0.1 },
  ],
  catch: [
    { type: 'triangle', freq: 520, to: 780, dur: 0.12, gain: 0.2 },
    { type: 'triangle', freq: 780, to: 1180, dur: 0.18, gain: 0.18, delay: 0.1 },
  ],
  special: [
    { type: 'triangle', freq: 440, dur: 0.12, gain: 0.2 },
    { type: 'triangle', freq: 660, dur: 0.12, gain: 0.2, delay: 0.12 },
    { type: 'triangle', freq: 880, dur: 0.12, gain: 0.2, delay: 0.24 },
    { type: 'triangle', freq: 1320, dur: 0.4, gain: 0.22, delay: 0.36 },
  ],
  fail: [{ type: 'sawtooth', freq: 320, to: 90, dur: 0.4, gain: 0.16 }],
  lineBreak: [
    { type: 'square', freq: 900, to: 120, dur: 0.18, gain: 0.2 },
    { type: 'sine', freq: 120, dur: 0.25, gain: 0.12, noise: 0.4, delay: 0.12 },
  ],
  eat: [{ type: 'sine', freq: 220, to: 140, dur: 0.22, gain: 0.14, noise: 0.3 }],
  fire: [{ type: 'sine', freq: 90, dur: 0.5, gain: 0.2, noise: 0.9 }],
  sizzle: [{ type: 'sine', freq: 120, dur: 0.3, gain: 0.1, noise: 0.8 }],
  step: [{ type: 'sine', freq: 140, to: 90, dur: 0.08, gain: 0.07, noise: 0.6 }],
  levelUp: [
    { type: 'triangle', freq: 660, dur: 0.1, gain: 0.18 },
    { type: 'triangle', freq: 880, dur: 0.1, gain: 0.18, delay: 0.1 },
    { type: 'triangle', freq: 1100, dur: 0.24, gain: 0.2, delay: 0.2 },
  ],
};

export class AudioSystem {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.ambienceGain = null;
    this.enabled = true;
    this._ambienceNodes = null;
    this._lastStep = 0;
  }

  /** 必须由用户手势触发一次（浏览器自动播放策略） */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) {
      this.enabled = false;
      return;
    }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings.get('masterVolume');
      this.master.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.settings.get('sfxVolume');
      this.sfxGain.connect(this.master);
      this.ambienceGain = this.ctx.createGain();
      this.ambienceGain.gain.value = 0;
      this.ambienceGain.connect(this.master);
    } catch (err) {
      console.warn('[audio] 初始化失败', err);
      this.enabled = false;
    }
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.settings.get('masterVolume');
    this.sfxGain.gain.value = this.settings.get('sfxVolume');
    if (this._ambienceNodes) {
      this.ambienceGain.gain.value = this.settings.get('ambienceVolume') * 0.5;
    }
  }

  /**
   * 播放一个音效。
   * @param {string} id SOUNDS 里的键
   * @param {object} [opts] { detune, gain }
   */
  play(id, opts = {}) {
    if (!this.enabled) return;
    if (!this.ctx) this.unlock();
    if (!this.ctx) return;
    const recipe = SOUNDS[id];
    if (!recipe) return;
    const sv = this.settings.get('sfxVolume');
    if (sv <= 0) return;
    const t0 = this.ctx.currentTime;
    const detune = opts.detune || 0;
    for (const part of recipe) {
      this._tone(part, t0, detune, opts.gain ?? 1);
    }
  }

  _tone(part, t0, detune, gainScale) {
    const ctx = this.ctx;
    const start = t0 + (part.delay || 0);
    const dur = part.dur || 0.2;
    const osc = ctx.createOscillator();
    osc.type = part.type || 'sine';
    const f0 = (part.freq || 440) * Math.pow(2, detune / 12);
    osc.frequency.setValueAtTime(f0, start);
    if (part.to) {
      const f1 = part.to * Math.pow(2, detune / 12);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), start + dur);
    }
    const g = ctx.createGain();
    const peak = (part.gain || 0.15) * gainScale;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(start);
    osc.stop(start + dur + 0.02);

    if (part.noise) {
      this._noise(start, dur, peak * part.noise);
    }
  }

  _noise(start, dur, gain) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = 1 - i / len;
      data[i] = (Math.random() * 2 - 1) * env * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2200;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(start);
  }

  /** 环境音：海浪 + 风，用两段滤波噪声模拟 */
  startAmbience() {
    if (!this.enabled) return;
    if (!this.ctx) this.unlock();
    if (!this.ctx || this._ambienceNodes) return;
    const ctx = this.ctx;
    const waves = this._loopingNoise(0.32, 420, 'lowpass');
    const wind = this._loopingNoise(0.16, 900, 'bandpass');
    // 让海浪有起伏
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.12;
    lfo.connect(lfoGain);
    lfoGain.connect(waves.gain.gain);
    lfo.start();
    waves.gain.connect(this.ambienceGain);
    wind.gain.connect(this.ambienceGain);
    this._ambienceNodes = { waves, wind, lfo };
    this.ambienceGain.gain.value = this.settings.get('ambienceVolume') * 0.5;
  }

  _loopingNoise(baseGain, cutoff, filterType) {
    const ctx = this.ctx;
    const dur = 3;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
      // 首尾交叉淡化，循环不爆音
      const fade = Math.min(1, Math.min(i, len - i) / 2000);
      d[i] *= fade;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.value = baseGain;
    src.connect(filter);
    filter.connect(gain);
    src.start();
    return { src, filter, gain };
  }

  stopAmbience() {
    if (!this._ambienceNodes) return;
    const { waves, wind, lfo } = this._ambienceNodes;
    try {
      waves.src.stop();
      wind.src.stop();
      lfo.stop();
    } catch {
      /* ignore */
    }
    this._ambienceNodes = null;
  }

  /** 脚步（带节流，避免每帧都响） */
  step(strength = 1, now = 0) {
    if (now - this._lastStep < 0.32) return;
    this._lastStep = now;
    this.play('step', { gain: 0.6 + 0.4 * strength, detune: Math.round((Math.random() - 0.5) * 3) });
  }
}
