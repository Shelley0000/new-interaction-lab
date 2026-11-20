/* The stage: a slow, luminous weather system made of fog, dust and a person.
   Everything is drawn locally on a 2D canvas. No frames leave the machine. */

import {
  clamp, smoothstep, mixColor, mixPalette, paletteOf, rgba, rgb, meta,
} from './emotions.js';
import { StoryLayer } from './story.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function noise2(x, y, period, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = (n) => ((n % period) + period) % period;
  const xa = w(x0), xb = w(x0 + 1), ya = w(y0), yb = w(y0 + 1);
  const a = hash2(xa, ya, seed), b = hash2(xb, ya, seed);
  const c = hash2(xa, yb, seed), d = hash2(xb, yb, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

function fbm(x, y, seed) {
  let amp = 0.54, sum = 0, norm = 0, f = 4;
  for (let o = 0; o < 5; o++) {
    sum += amp * noise2(x * f, y * f, f, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function makeNoise(size, seed, ridged = false) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = fbm(x / size, y / size, seed);
      if (ridged) n = 1 - Math.abs(n * 2 - 1);
      const a = (ridged ? smoothstep(0.46, 0.92, n) ** 2.3 : smoothstep(0.28, 0.82, n) ** 1.75);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 250; d[i + 2] = 240;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tintTexture(tex, color, out) {
  const ctx = out.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, out.width, out.height);
  ctx.drawImage(tex, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = rgb(color);
  ctx.fillRect(0, 0, out.width, out.height);
}

function glow(ctx, x, y, r, color, alpha) {
  if (alpha <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.32, rgba(color, alpha * 0.64));
  g.addColorStop(0.68, rgba(color, alpha * 0.22));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function saturateColor(c, amount = 1) {
  const mean = (c[0] + c[1] + c[2]) / 3;
  return [
    clamp(mean + (c[0] - mean) * amount, 0, 255),
    clamp(mean + (c[1] - mean) * amount, 0, 255),
    clamp(mean + (c[2] - mean) * amount, 0, 255),
  ];
}

const NOISE_SIZE = 320;

export class NebulaStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.W = 0; this.H = 0; this.dpr = 1;
    this.time = 0;
    this.last = 0;
    this.running = false;
    this.raf = 0;
    this.fps = 60;
    this._fpsFrames = 0;
    this._fpsAt = performance.now();

    this.current = paletteOf('calm');
    this.from = paletteOf('calm');
    this.target = paletteOf('calm');
    this.paletteT = 1;
    this.paletteDuration = 1.5;

    this.intensity = 0.12;
    this.intensityTarget = 0.12;
    this.sustain = 0;
    this.sustainTarget = 0;
    this.reveal = 1;
    this.revealTarget = 1;
    this.revealRate = 1;

    this.showPerson = false;
    this.personOpacity = 0;
    this.personOpacityTarget = 0;
    this.preview = false;
    this.windowR = 0;
    this.windowRTarget = 0;

    this.video = null;
    this.mask = null;
    this.personCanvas = document.createElement('canvas');
    this.personCtx = this.personCanvas.getContext('2d');
    this.waveLayer = document.createElement('canvas');
    this.waveCtx = this.waveLayer.getContext('2d');

    this.face = null;
    this.faceSmooth = { x: 0.5, y: 0.4, r: 0.12, a: 0 };

    this.particles = [];
    this.waves = [];
    this.dust = [];
    this.brightStars = [];
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.story = new StoryLayer();
    this.initParticles();
    this.resize();
  }

  initParticles() {
    const rand = mulberry32(90731);
    const t2 = Math.PI * 2;

    // Several loose ribbons of dust. Each ribbon is a slow wave; the dots
    // riding it are what actually gets drawn, so the "cloud" is made of grain.
    for (let i = 0; i < 8; i++) {
      const dots = [];
      const count = 460 + Math.floor(rand() * 180);
      for (let j = 0; j < count; j++) {
        dots.push({
          u: rand(),
          jitter: (rand() + rand() + rand() - 1.5) * 0.062,
          size: 0.62 + rand() * 1.75,
          phase: rand() * t2,
          twinkle: 0.4 + rand() * 1.6,
          warm: rand(),
          bright: rand() > 0.86,
          // These grains sleep in the dust until a feeling is held for a while.
          latent: rand() < 0.34,
          wake: rand(),
        });
      }
      this.waves.push({
        base: 0.15 + i * 0.1 + (rand() - 0.5) * 0.08,
        tilt: (rand() - 0.5) * 0.14,
        amp: 0.024 + rand() * 0.05,
        amp2: 0.008 + rand() * 0.022,
        k: 0.9 + rand() * 1.9,
        k2: 3.4 + rand() * 4.6,
        speed: 0.045 + rand() * 0.09,
        speed2: 0.08 + rand() * 0.15,
        phase: rand() * t2,
        depth: 0.3 + rand() * 0.7,
        hue: rand(),
        width: 0.8 + rand() * 1.6,
        offset: rand(),
        dots,
      });
    }

    // Free dust between the ribbons, so it still feels like a volume.
    for (let i = 0; i < 1050; i++) {
      this.dust.push({
        x: rand(), y: rand(),
        z: 0.22 + rand() * 0.78,
        size: 0.42 + rand() * 1.45,
        phase: rand() * t2,
        speed: 0.35 + rand() * 1.0,
        warm: rand(),
        twinkle: 0.5 + rand() * 2.4,
        latent: rand() < 0.4,
        wake: rand(),
      });
    }

    for (let i = 0; i < 26; i++) {
      this.brightStars.push({
        x: 0.04 + rand() * 0.92,
        y: 0.04 + rand() * 0.7,
        s: 0.78 + rand() * 1.65,
        phase: rand() * t2,
        rate: 0.35 + rand() * 0.8,
        warm: rand(),
      });
    }
  }

  initTextures() {
    this.noiseA = makeNoise(NOISE_SIZE, 17, false);
    this.noiseB = makeNoise(NOISE_SIZE, 43, true);
    this.noiseC = makeNoise(NOISE_SIZE, 91, true);
    this.noiseD = makeNoise(640, 137, true);
    this.tintCore = document.createElement('canvas');
    this.tintAccent = document.createElement('canvas');
    this.tintCore.width = this.tintAccent.width = NOISE_SIZE;
    this.tintCore.height = this.tintAccent.height = NOISE_SIZE;
    this.tintMid = document.createElement('canvas');
    this.tintMid.width = NOISE_SIZE; this.tintMid.height = NOISE_SIZE;
    this.tintFine = document.createElement('canvas');
    this.tintFine.width = NOISE_SIZE; this.tintFine.height = NOISE_SIZE;
    this.tintFilament = document.createElement('canvas');
    this.tintFilament.width = 640; this.tintFilament.height = 640;
    this.lastTint = -1;
    this.lastTintColors = null;

    this.fog = document.createElement('canvas');
    this.fogCtx = this.fog.getContext('2d');
    this.resizeFog();
  }

  resizeFog() {
    const scale = this.W < 700 ? 0.5 : 0.34;
    const w = Math.max(300, Math.min(620, Math.round(this.W * scale)));
    const h = Math.max(190, Math.round(w * (this.H / Math.max(1, this.W))));
    if (this.fog.width !== w || this.fog.height !== h) {
      this.fog.width = w; this.fog.height = h;
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.W = Math.max(320, Math.round(rect.width));
    this.H = Math.max(240, Math.round(rect.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.story?.setViewport(this.W, this.H, this.reduced);
    if (this.waveLayer.width !== this.W || this.waveLayer.height !== this.H) {
      this.waveLayer.width = this.W;
      this.waveLayer.height = this.H;
    }
    this.lastTint = -1;
  }

  setPalette(key, { immediate = false, duration = 1.5 } = {}) {
    if (key === this.paletteKey && !immediate) return;
    this.paletteKey = key;
    const p = paletteOf(key);
    if (immediate) {
      this.from = p; this.target = p; this.current = p; this.paletteT = 1;
    } else {
      this.from = { ...this.current };
      this.target = p;
      this.paletteT = 0;
      this.paletteDuration = duration;
    }
    this.lastTint = -1;
  }

  setIntensity(v) {
    this.intensityTarget = clamp(v, 0.06, 1);
  }

  setSustain(v) {
    this.sustainTarget = clamp(v);
  }

  /* How saturated the weather looks right now. A long-held gesture does not
     just brighten the nebula: its ink gets deeper and the stars drink more color. */
  renderPalette() {
    const c = this.current;
    const boost = 1 + this.sustain * 0.55 + this.intensity * 0.1;
    return {
      deep: saturateColor(c.deep, 1 + this.sustain * 0.4),
      mid: saturateColor(c.mid, boost),
      core: saturateColor(c.core, boost),
      accent: saturateColor(c.accent, 1 + this.sustain * 0.3),
      star: saturateColor(c.star, 1 + this.sustain * 0.12),
    };
  }

  setReveal(value, duration = 0) {
    this.revealTarget = clamp(value);
    this.revealRate = duration > 0 ? Math.abs(this.revealTarget - this.reveal) / duration : 999;
    if (duration <= 0) this.reveal = this.revealTarget;
  }

  setShowPerson(on) {
    this.showPerson = !!on;
    this.personOpacityTarget = on ? 1 : 0;
  }

  setPreview(on) {
    this.preview = !!on;
  }

  setStory(key) {
    this.story.setEmotion(key);
  }

  clearStory(immediate = true) {
    this.story.clear(immediate);
  }

  setVideo(video) {
    this.video = video;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const pw = 960;
    const ph = Math.round(pw * (vh / Math.max(1, vw)));
    if (this.personCanvas.width !== pw || this.personCanvas.height !== ph) {
      this.personCanvas.width = pw;
      this.personCanvas.height = Math.round(ph);
    }
  }

  setMask(canvas) {
    this.mask = canvas;
  }

  setFace(face) {
    // face = { x, y, r } normalized to the (unmirrored) camera frame
    if (!face) { this.face = null; return; }
    this.face = face;
  }

  setWindow(radius, immediate = false) {
    this.windowRTarget = Math.max(0, radius);
    if (immediate) this.windowR = this.windowRTarget;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
      this.last = now;
      this.update(dt);
      this.draw();
      if (this.running) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  update(dt) {
    this.time += dt;

    this._fpsFrames++;
    const now = performance.now();
    if (now - this._fpsAt > 1000) {
      this.fps = Math.round((this._fpsFrames * 1000) / (now - this._fpsAt));
      this._fpsFrames = 0;
      this._fpsAt = now;
    }

    if (this.paletteT < 1) {
      this.paletteT = Math.min(1, this.paletteT + dt / this.paletteDuration);
      const t = smoothstep(0, 1, this.paletteT);
      this.current = mixPalette(this.from, this.target, t);
    }

    this.intensity += (this.intensityTarget - this.intensity) * Math.min(1, dt * 2.2);
    const sustainRate = this.sustainTarget > this.sustain ? 1.9 : 1.15;
    this.sustain += (this.sustainTarget - this.sustain) * Math.min(1, dt * sustainRate);
    if (Math.abs(this.sustain - this.sustainTarget) < 0.0005) this.sustain = this.sustainTarget;

    const rv = this.revealTarget - this.reveal;
    if (Math.abs(rv) > 0.001) {
      const step = Math.sign(rv) * Math.min(Math.abs(rv), this.revealRate * dt);
      this.reveal = clamp(this.reveal + step);
    } else {
      this.reveal = this.revealTarget;
    }

    this.personOpacity += (this.personOpacityTarget - this.personOpacity) * Math.min(1, dt * 3.2);
    this.windowR += (this.windowRTarget - this.windowR) * Math.min(1, dt * 2.8);

    const targetFace = this.face || { x: 0.5, y: 0.4, r: 0.13 };
    const fs = this.faceSmooth;
    const follow = this.face ? Math.min(1, dt * 3.4) : Math.min(1, dt * 0.9);
    fs.x += (targetFace.x - fs.x) * follow;
    fs.y += (targetFace.y - fs.y) * follow;
    fs.r += (targetFace.r - fs.r) * follow;
    fs.a += ((this.face ? 1 : 0) - fs.a) * Math.min(1, dt * 1.8);

    this.story.setContext(this.faceScreen(), this.showPerson);
    this.story.update(dt);
  }

  coverRect() {
    const vw = this.video?.videoWidth || 16;
    const vh = this.video?.videoHeight || 9;
    const s = Math.max(this.W / vw, this.H / vh);
    const dw = vw * s, dh = vh * s;
    return { dx: (this.W - dw) / 2, dy: (this.H - dh) / 2, dw, dh, s };
  }

  faceScreen() {
    const { dx, dy, dw, dh } = this.coverRect();
    const f = this.faceSmooth;
    const x = dx + (1 - f.x) * dw;
    const y = dy + f.y * dh;
    const r = Math.max(46, f.r * dh);
    return { x, y, r, a: f.a };
  }

  drawBackground(ctx, c = this.current) {
    const top = mixColor(c.deep, c.mid, 0.25);
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, rgb(mixColor(top, [2, 3, 7], 0.28)));
    g.addColorStop(0.52, rgb(c.deep));
    g.addColorStop(1, rgb(mixColor(c.deep, [2, 2, 5], 0.62)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const dim = 1 - (this.story?.ambientDim || 0) * 0.5;
    glow(ctx, this.W * 0.68, this.H * 0.24, Math.max(this.W, this.H) * 0.52, c.mid,
      (0.2 + this.sustain * 0.06) * dim);
    glow(ctx, this.W * 0.26, this.H * 0.72, Math.max(this.W, this.H) * 0.44, c.deep,
      (0.3 + this.sustain * 0.04) * dim);
    glow(ctx, this.W * 0.54, this.H * 0.44, Math.max(this.W, this.H) * 0.5, c.core,
      (0.045 + this.intensity * 0.07 + this.sustain * 0.055) * dim);
    ctx.restore();
  }

  refreshTints() {
    const now = this.time;
    if (this.lastTint >= 0 && now - this.lastTint < 0.11 && this.lastTintColors) return;
    const c = this.current;
    const prev = this.lastTintColors;
    if (prev && !this.paletteKeyChanged && Math.abs(prev[0] - c.core[0]) + Math.abs(prev[1] - c.core[1]) < 1.6) {
      this.lastTint = now;
      return;
    }
    tintTexture(this.noiseA, c.core, this.tintCore);
    tintTexture(this.noiseB, c.accent, this.tintAccent);
    tintTexture(this.noiseA, c.mid, this.tintMid);
    tintTexture(this.noiseC, c.accent, this.tintFine);
    tintTexture(this.noiseD, c.accent, this.tintFilament);
    this.lastTint = now;
    this.lastTintColors = c.core.slice();
  }

  drawFog() {
    const ctx = this.fogCtx;
    const w = this.fog.width, h = this.fog.height;
    ctx.clearRect(0, 0, w, h);
    this.refreshTints();
    const c = this.current;
    const inten = this.intensity;
    const t = this.time;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    glow(ctx, w * 0.53, h * 0.44, Math.max(w, h) * 0.62, c.core, 0.075 + inten * 0.12);
    glow(ctx, w * 0.31, h * 0.68, Math.max(w, h) * 0.46, c.accent, 0.04 + inten * 0.07);
    glow(ctx, w * 0.76, h * 0.30, Math.max(w, h) * 0.40, c.mid, 0.055 + inten * 0.07);
    glow(ctx, w * 0.5, h * 0.45, Math.max(w, h) * 0.3, c.accent, 0.035 + inten * 0.07);
    glow(ctx, w * 0.5, h * 0.45, Math.max(w, h) * 0.16, c.core, 0.04 + inten * 0.1);

    const drawTex = (tex, angle, scale, ox, oy, alpha) => {
      const size = Math.max(w, h) * scale;
      ctx.save();
      ctx.translate(w * 0.5 + ox, h * 0.5 + oy);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      ctx.drawImage(tex, -size / 2, -size / 2, size, size);
      ctx.restore();
    };

    const drift = this.reduced ? 0 : 1;
    drawTex(this.tintMid, 0.22 + Math.sin(t * 0.018) * 0.1 * drift,
      2.3, Math.sin(t * 0.035) * w * 0.05 * drift, Math.cos(t * 0.028) * h * 0.04 * drift,
      0.17 + inten * 0.16);
    drawTex(this.tintCore, -0.32 + Math.cos(t * 0.013) * 0.14 * drift,
      1.75, Math.cos(t * 0.024) * w * 0.09 * drift, Math.sin(t * 0.021) * h * 0.07 * drift,
      0.22 + inten * 0.22);
    drawTex(this.tintAccent, 1.1 + Math.sin(t * 0.016) * 0.2 * drift,
      2.8, Math.sin(t * 0.019 + 2) * w * 0.08 * drift, Math.cos(t * 0.017 + 2) * h * 0.06 * drift,
      0.11 + inten * 0.14);
    drawTex(this.tintFine, -0.7 + Math.sin(t * 0.021) * 0.24 * drift,
      1.15, Math.sin(t * 0.027 + 1.4) * w * 0.12 * drift, Math.cos(t * 0.023 + 1.2) * h * 0.09 * drift,
      0.13 + inten * 0.16);
    drawTex(this.tintFilament, 0.4 + Math.cos(t * 0.018 + 1) * 0.16 * drift,
      1.0, Math.cos(t * 0.022 + 1.7) * w * 0.06 * drift, Math.sin(t * 0.02 + 1.1) * h * 0.05 * drift,
      0.1 + inten * 0.15);

    ctx.restore();

    // dark dust lanes keep the weather from becoming a flat wash
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const lanes = [
      [0.38, 0.36, 0.5, 0.24 + inten * 0.16],
      [0.63, 0.7, 0.62, 0.2 + inten * 0.14],
    ];
    for (const [lx, ly, lr, la] of lanes) {
      const g = ctx.createRadialGradient(
        w * lx + Math.sin(t * 0.03) * w * 0.03,
        h * ly + Math.cos(t * 0.026) * h * 0.02,
        0,
        w * lx, h * ly, Math.max(w, h) * lr,
      );
      g.addColorStop(0, `rgba(0,0,0,${la})`);
      g.addColorStop(0.55, `rgba(0,0,0,${la * 0.55})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // soft horizon haze
    const hz = ctx.createLinearGradient(0, h * 0.55, 0, h);
    hz.addColorStop(0, rgba(c.accent, 0));
    hz.addColorStop(0.78, rgba(c.accent, 0.022 + inten * 0.02));
    hz.addColorStop(1, rgba(c.mid, 0.08 + inten * 0.05));
    ctx.fillStyle = hz;
    ctx.fillRect(0, h * 0.55, w, h * 0.45);

    // a hole to breathe: the brightest fog avoids the face
    const fs = this.faceSmooth;
    const fx = fs.x * w;
    const fy = (fs.y) * h;
    const fr = Math.max(0.05, fs.r) * h * 1.55;
    const holeAlpha = (this.showPerson ? 0.88 : 0.46) * fs.a;
    if (holeAlpha > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const hg = ctx.createRadialGradient(fx, fy, fr * 0.35, fx, fy, fr);
      hg.addColorStop(0, `rgba(0,0,0,${holeAlpha})`);
      hg.addColorStop(0.55, `rgba(0,0,0,${holeAlpha * 0.9})`);
      hg.addColorStop(0.82, `rgba(0,0,0,${holeAlpha * 0.38})`);
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = hg;
      ctx.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
      ctx.restore();
    }

    // grow the weather from a quiet center
    if (this.reveal < 0.999) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      const cx = w * 0.5, cy = h * 0.47;
      const rr = Math.max(w, h) * (0.08 + 0.95 * this.reveal);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.66, 'rgba(0,0,0,0.96)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  drawFogToStage(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.96;
    ctx.drawImage(this.fog, 0, 0, this.W, this.H);
    ctx.restore();
  }

  drawBrightStars(ctx, c = this.current) {
    const t = this.time;
    const dim = this.story?.ambientDim || 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.brightStars) {
      const x = s.x * this.W;
      const y = s.y * this.H;
      const tw = 0.55 + 0.45 * Math.sin(t * s.rate + s.phase);
      const fade = this.faceFade(x, y) * this.revealFade(x, y);
      const a = (0.4 + 0.36 * tw) * (0.52 + this.intensity * 0.48)
        * (0.8 + this.sustain * 0.2) * (1 - dim * 0.6) * fade;
      if (a < 0.012) continue;
      const col = mixColor(c.star, c.accent, 0.12 + s.warm * 0.58);
      const r = s.s * (1.5 + this.intensity * 1.25 + this.sustain * 0.9);
      const halo = r * (4.2 + this.sustain * 1.6);
      const g = ctx.createRadialGradient(x, y, 0, x, y, halo);
      g.addColorStop(0, rgba(col, a * 0.78));
      g.addColorStop(0.2, rgba(col, a * 0.32));
      g.addColorStop(0.55, rgba(col, a * 0.08));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - halo, y - halo, halo * 2, halo * 2);

      ctx.strokeStyle = rgba(col, a * 0.4);
      ctx.lineWidth = 0.75;
      const len = r * (6 + (s.warm > 0.6 ? 5 : 0));
      ctx.beginPath();
      ctx.moveTo(x - len, y); ctx.lineTo(x + len, y);
      ctx.moveTo(x, y - len); ctx.lineTo(x, y + len);
      ctx.stroke();

      ctx.fillStyle = rgba(col, a * 0.98);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.85, s.s * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  waveY(w, u, t) {
    const drift = this.reduced ? 0.55 : 0.55 + this.intensity * 0.9 + this.sustain * 2.35;
    return this.H * (
      w.base
      + (u - 0.5) * w.tilt
      + Math.sin(u * Math.PI * 2 * w.k + t * w.speed * (1 + this.sustain * 0.4) + w.phase)
        * w.amp * drift
      + Math.sin(u * Math.PI * 2 * w.k2 - t * w.speed2 * (1 + this.sustain * 0.5) + w.phase * 1.7)
        * w.amp2 * drift
    );
  }

  faceFade(x, y) {
    const fs = this.faceScreen();
    if (fs.a < 0.06) return 1;
    const dx = (x - fs.x) / (fs.r * 1.65);
    const dy = (y - fs.y) / (fs.r * 2.05);
    return smoothstep(0.92, 1.38, Math.hypot(dx, dy));
  }

  revealFade(x, y) {
    if (this.reveal >= 0.999) return 1;
    const r = Math.max(this.W, this.H) * (0.12 + 0.92 * this.reveal);
    const d = Math.hypot(x - this.W * 0.5, y - this.H * 0.47);
    return 1 - smoothstep(r * 0.72, r, d);
  }

  strokeWave(ctx, w, width, color, alpha) {
    const seg = 36;
    const t = this.time;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    for (let i = 0; i < seg; i++) {
      const u0 = i / seg, u1 = (i + 1) / seg;
      const x0 = u0 * this.W, x1 = u1 * this.W;
      const y0 = this.waveY(w, u0, t), y1 = this.waveY(w, u1, t);
      const mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5;
      const a = this.faceFade(mx, my) * this.revealFade(mx, my) * alpha;
      if (a <= 0.006) continue;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1 + 0.6, y1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawParticleWaves(ctx, c = this.current) {
    const t = this.time;
    const inten = this.intensity;
    const hold = this.sustain;
    const W = this.W, H = this.H;
    const g = this.waveCtx;
    const storyDim = this.story?.ambientDim || 0;
    const wakeOf = (d) => (d.latent ? smoothstep(d.wake * 0.88, d.wake * 0.88 + 0.14, hold) : 1);

    // Pre-roll the palette into a handful of ink-and-alpha strings, so the
    // thousands of grains per frame never allocate colors one by one.
    const TONES = 6;
    const ALPHAS = 8;
    const tones = [];
    for (let i = 0; i < TONES; i++) {
      const white = (0.12 + ((i + 0.5) / TONES) * 0.48) * (1 - hold * 0.3);
      const col = mixColor(c.core, c.star, white);
      const row = [];
      for (let j = 0; j < ALPHAS; j++) row.push(rgba(col, (j + 1) / ALPHAS));
      tones.push(row);
    }
    const toneIndex = (warm) => Math.min(TONES - 1, Math.floor(warm * TONES));
    const alphaIndex = (a) => Math.min(ALPHAS - 1, Math.floor(a * ALPHAS));
    const crossStyle = rgba(c.star, 0.24);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter';

    for (const w of this.waves) {
      const n = 90;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const x = u * W;
        const y = this.waveY(w, u, t);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineCap = 'round';
      g.lineJoin = 'round';

      // A breath of mist under the grains. Kept quiet so the stars stay legible.
      g.strokeStyle = rgba(mixColor(c.mid, c.core, 0.55), 0.5);
      g.globalAlpha = Math.min(0.11, 0.026 + inten * 0.028 + hold * 0.036);
      g.lineWidth = 24 + inten * 30 + hold * 24;
      g.stroke();

      g.globalAlpha = 1;
      for (const d of w.dots) {
        if (storyDim > 0.45 && d.latent) continue;
        const wake = wakeOf(d);
        if (wake <= 0.004) continue;
        const u = ((d.u + t * (0.004 + w.speed * 0.009)) % 1 + 1) % 1;
        const x = u * W;
        const y = this.waveY(w, u, t)
          + d.jitter * H * (0.55 + inten * 0.8 + hold * 0.35)
          + Math.sin(t * 0.3 * d.twinkle + d.phase) * H * 0.004;
        const a = (0.55 + 0.45 * Math.sin(t * d.twinkle + d.phase))
          * (0.68 + inten * 0.32) * (0.82 + hold * 0.18) * wake;
        if (a <= 0.008) continue;
        // Held feelings leave less white in each grain: the color gets denser.
        const size = Math.max(0.82, d.size * (0.82 + inten * 0.62 + hold * 0.66));
        const cx = x + size * 0.5;
        const cy = y + size * 0.5;

        g.fillStyle = tones[toneIndex(d.warm)][alphaIndex(a)];
        if (size > 1.45) {
          g.beginPath();
          g.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
          g.fill();
        } else {
          g.fillRect(x, y, size, size);
        }

        if (d.bright) {
          const len = size * 2.6;
          g.fillStyle = crossStyle;
          g.fillRect(cx - 0.3, cy - len * 0.5, 0.6, len);
        }
      }
    }

    for (const p of this.dust) {
      if (storyDim > 0.45 && p.latent) continue;
      const wake = wakeOf(p);
      if (wake <= 0.004) continue;
      const x = ((p.x + Math.sin(t * 0.025 * p.speed + p.phase) * 0.012 * p.z + t * 0.0014) % 1 + 1) % 1 * W;
      const y = ((p.y + Math.cos(t * 0.021 * p.speed + p.phase * 1.7) * 0.01 * p.z) % 1 + 1) % 1 * H;
      const a = (0.3 + p.z * 0.5) * (0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase))
        * (0.62 + inten * 0.38) * (0.82 + hold * 0.18) * wake;
      if (a <= 0.008) continue;
      const size = Math.max(0.55, p.size * (0.7 + inten * 0.5 + hold * 0.48));
      g.fillStyle = tones[toneIndex(p.warm)][alphaIndex(a)];
      if (size > 1.45) {
        g.beginPath();
        g.arc(x + size * 0.5, y + size * 0.5, size * 0.5, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillRect(x, y, size, size);
      }
    }

    // a soft hole at the face, so the weather leaves you some air
    const fs = this.faceScreen();
    if (fs.a > 0.05) {
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = 1;
      const fr = fs.r * 1.7;
      const hole = g.createRadialGradient(fs.x, fs.y, fr * 0.45, fs.x, fs.y, fr);
      hole.addColorStop(0, 'rgba(0,0,0,0.92)');
      hole.addColorStop(0.62, 'rgba(0,0,0,0.86)');
      hole.addColorStop(0.86, 'rgba(0,0,0,0.35)');
      hole.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = hole;
      g.fillRect(fs.x - fr, fs.y - fr, fr * 2, fr * 2);
    }

    // growth from a quiet center
    if (this.reveal < 0.999) {
      g.globalCompositeOperation = 'destination-in';
      const rr = Math.max(W, H) * (0.12 + 0.92 * this.reveal);
      const grow = g.createRadialGradient(W * 0.5, H * 0.47, 0, W * 0.5, H * 0.47, rr);
      grow.addColorStop(0, 'rgba(0,0,0,1)');
      grow.addColorStop(0.7, 'rgba(0,0,0,1)');
      grow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grow;
      g.fillRect(0, 0, W, H);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const dim = this.story?.ambientDim || 0;
    ctx.globalAlpha = 0.94 * (1 - dim * 0.68);
    ctx.drawImage(this.waveLayer, 0, 0, W, H);
    ctx.restore();
  }

  drawFaceRing(ctx) {
    const fs = this.faceScreen();
    if (fs.a < 0.05) return;
    const c = this.current;
    const r = fs.r * 1.02;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const g = ctx.createRadialGradient(fs.x, fs.y, r * 0.72, fs.x, fs.y, r * 1.74);
    g.addColorStop(0, rgba(c.accent, 0));
    g.addColorStop(0.34, rgba(c.accent, 0.035 * fs.a));
    g.addColorStop(0.55, rgba(c.accent, 0.075 * fs.a));
    g.addColorStop(1, rgba(c.accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(fs.x - r * 1.8, fs.y - r * 1.8, r * 3.6, r * 3.6);
    ctx.restore();
  }

  drawPerson(ctx) {
    if (!this.video || this.personOpacity < 0.01) return;
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return;

    this.setVideo(v);
    const pc = this.personCanvas;
    const pctx = this.personCtx;
    const pw = pc.width, ph = pc.height;

    pctx.clearRect(0, 0, pw, ph);
    pctx.globalCompositeOperation = 'source-over';
    pctx.save();
    pctx.translate(pw, 0);
    pctx.scale(-1, 1);
    pctx.drawImage(v, 0, 0, pw, ph);
    pctx.restore();

    if (this.mask) {
      pctx.globalCompositeOperation = 'destination-in';
      pctx.save();
      pctx.translate(pw, 0);
      pctx.scale(-1, 1);
      pctx.drawImage(this.mask, 0, 0, pw, ph);
      pctx.restore();
    }

    // oval window (preparation, low-performance fallback, or transition)
    const { dx, dy, dw, dh } = this.coverRect();
    const scale = dw / pw;
    const fs = this.faceScreen();
    const centerX = this.preview ? this.W * 0.5 : fs.x;
    const centerY = this.preview ? this.H * 0.47 : fs.y;
    let rScreen = this.windowR;
    if (this.preview) rScreen = Math.min(this.W, this.H) * 0.305;
    if (rScreen > 0 && rScreen < Math.hypot(this.W, this.H) * 0.9) {
      const cx = (centerX - dx) / scale;
      const cy = (centerY - dy) / scale;
      const rr = rScreen / scale;
      const feather = 1;
      pctx.save();
      pctx.globalCompositeOperation = 'destination-in';
      pctx.translate(cx, cy);
      pctx.scale(rr, rr * feather);
      const g = pctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.78, 'rgba(0,0,0,1)');
      g.addColorStop(0.94, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      pctx.fillStyle = g;
      pctx.fillRect(-1, -1, 2, 2);
      pctx.restore();
    }

    // color grade the person into the weather
    const c = this.current;
    pctx.save();
    pctx.globalCompositeOperation = 'source-atop';
    const grade = pctx.createLinearGradient(0, 0, 0, ph);
    grade.addColorStop(0, rgba(c.accent, 0.05));
    grade.addColorStop(0.55, rgba(c.core, 0.035));
    grade.addColorStop(1, rgba(c.deep, 0.16));
    pctx.fillStyle = grade;
    pctx.fillRect(0, 0, pw, ph);
    if (!this.mask) {
      pctx.fillStyle = rgba(c.deep, 0.2);
      pctx.fillRect(0, 0, pw, ph);
    }
    pctx.restore();

    ctx.save();
    if (this.showPerson) {
      // a soft bloom, as if the body is lit from inside the fog
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = this.personOpacity * 0.15;
      ctx.filter = 'blur(34px)';
      ctx.drawImage(pc, dx, dy, dw, dh);
      ctx.filter = 'none';
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.personOpacity * 0.985;
    ctx.drawImage(pc, dx, dy, dw, dh);
    ctx.restore();
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const colors = this.renderPalette();
    this.drawBackground(ctx, colors);
    this.drawParticleWaves(ctx, colors);
    this.drawBrightStars(ctx, colors);
    this.drawFaceRing(ctx);
    this.drawPerson(ctx);
    this.story.draw(ctx, colors);
    this.drawVignette(ctx);
  }

  drawVignette(ctx) {
    const g = ctx.createRadialGradient(
      this.W * 0.5, this.H * 0.46, Math.min(this.W, this.H) * 0.2,
      this.W * 0.5, this.H * 0.46, Math.max(this.W, this.H) * 0.78,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
  }

  snapshot() {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    const x = c.getContext('2d');
    x.drawImage(this.canvas, 0, 0, this.W, this.H);
    return c;
  }
}
