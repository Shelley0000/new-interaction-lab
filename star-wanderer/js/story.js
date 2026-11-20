/* Small particle stories inside the nebula.
   Joy / delight gather the sky into fireworks. Grief / anxiety build a little
   person who packs the bad feeling and throws it away. Anger builds a little
   person who pats you, gently, until the weather clears. */

import { clamp, smoothstep, mixColor, rgba } from './emotions.js';

const TAU = Math.PI * 2;

const FIRE_GATHER = 1.3;
const FIRE_SHOW = 5.0;
const FIRE_REST = 1.2;
const FIRE_CYCLE = FIRE_GATHER + FIRE_SHOW + FIRE_REST;

const RELEASE_GATHER = 0.9;
const RELEASE_END = 5.8;
const COMFORT_GATHER = 0.9;
const COMFORT_END = 5.2;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function bezier(a, b, c, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
  };
}

function glow(ctx, x, y, r, color, alpha) {
  if (alpha <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.35, rgba(color, alpha * 0.5));
  g.addColorStop(0.72, rgba(color, alpha * 0.12));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function storyKind(key) {
  if (key === 'joy' || key === 'delight') return 'fireworks';
  if (key === 'sadness' || key === 'anxiety') return 'release';
  if (key === 'anger') return 'comfort';
  return null;
}

function makeParticles(count, seed) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    angle0: rand() * TAU,
    spin: (rand() < 0.5 ? -1 : 1) * (1.1 + rand() * 1.9),
    r0: 0.32 + rand() * 1.0,
    finalR: 2 + rand() * 22,
    delay: rand() * 0.55,
    size: 0.62 + rand() * 1.85,
    warm: rand(),
    phase: rand() * TAU,
    twinkle: 0.7 + rand() * 1.9,
    x: 0,
    y: 0,
  }));
}

function buildSpec(count, seed) {
  const rand = mulberry32(seed);
  const spec = [];
  const nHead = Math.round(count * 0.19);
  const nTorso = Math.round(count * 0.27);
  const nLegs = Math.round(count * 0.2);
  const rest = count - nHead - nTorso - nLegs;
  const nArmL = Math.floor(rest * 0.5);
  const nArmR = rest - nArmL;

  for (let i = 0; i < nHead; i++) {
    const a = rand() * TAU;
    const rr = Math.sqrt(rand()) * 0.098;
    spec.push({ role: 'head', x: Math.cos(a) * rr, y: -0.36 + Math.sin(a) * rr * 1.08 });
  }
  for (let i = 0; i < nTorso; i++) {
    const a = rand() * TAU;
    const rr = Math.sqrt(rand());
    spec.push({
      role: 'torso',
      x: Math.cos(a) * rr * 0.1,
      y: -0.075 + Math.sin(a) * rr * 0.17,
    });
  }
  for (let i = 0; i < nLegs; i++) {
    const side = i % 2 ? 1 : -1;
    const t = rand();
    spec.push({
      role: 'leg',
      x: side * (0.034 + t * 0.055) + (rand() - 0.5) * 0.022,
      y: 0.035 + t * 0.4,
    });
  }
  const arm = (side, n) => {
    for (let i = 0; i < n; i++) {
      spec.push({
        role: 'arm',
        side,
        t: rand(),
        jitter: (rand() - 0.5) * 0.026,
      });
    }
  };
  arm(-1, nArmL);
  arm(1, nArmR);
  return spec;
}

export class StoryLayer {
  constructor() {
    this.W = 0;
    this.H = 0;
    this.face = { x: 0, y: 0, r: 0, a: 0 };
    this.showPerson = false;
    this.reduced = false;
    this.active = null;
    this.ambientDim = 0;
    this.ambientTarget = 0;
    this.flecks = [];
    this.flashes = [];
    this.rings = [];
    this.motes = [];
    this.time = 0;
  }

  setViewport(W, H, reduced = false) {
    this.W = W;
    this.H = H;
    this.reduced = reduced;
    if (this.active?.kind === 'fireworks') this.active.spots = this.fireworkSpots();
  }

  setContext(face, showPerson) {
    if (face) this.face = face;
    this.showPerson = !!showPerson;
  }

  setEmotion(key) {
    const kind = storyKind(key);
    if (!kind) {
      this.stop();
      return;
    }
    if (this.active && !this.active.ending && this.active.kind === kind) {
      this.active.key = key;
      return;
    }
    this.start(kind, key);
  }

  stop() {
    if (!this.active || this.active.ending) return;
    this.active.ending = true;
    this.active.endTimer = 0;
    this.ambientTarget = 0;
  }

  clear(immediate = false) {
    this.active = null;
    this.flecks = [];
    this.flashes = [];
    this.rings = [];
    this.motes = [];
    this.ambientTarget = 0;
    if (immediate) this.ambientDim = 0;
  }

  start(kind, key) {
    const seed = (Date.now() & 0xffffff) + Math.floor(Math.random() * 9999);
    const count = kind === 'fireworks' ? 720 : 1020;
    const particles = makeParticles(count, seed);
    const anchor = this.anchor();
    const active = {
      kind,
      key,
      time: 0,
      ending: false,
      endTimer: 0,
      particles,
      spec: kind === 'fireworks' ? null : buildSpec(count, seed + 3),
      phase: 'gather',
      cycle: -1,
      cycleT: 0,
      spawned: [],
      gatherAlpha: 0,
      figureAlpha: 0,
      pose: null,
      anchor,
      orb: null,
      patSpawned: [],
      ringSpawned: [],
    };
    this.active = active;
    this.flecks = [];
    this.flashes = [];
    this.rings = [];
    this.motes = [];
    this.ambientTarget = 0.5;
  }

  anchor() {
    const W = this.W, H = this.H;
    const face = this.face;
    const fh = clamp(Math.min(H * 0.34, W * 0.56), 160, 330);
    const hasFace = this.showPerson && face.a > 0.22 && face.r > 0.02;
    let side = 1;
    let x = W * 0.5;
    let y = H * 0.58;

    if (hasFace) {
      side = face.x < W * 0.5 ? 1 : -1;
      const offset = clamp(face.r * 1.05 + fh * 0.105, W * 0.16, W * 0.38);
      x = clamp(face.x + side * offset, W * 0.14, W * 0.86);
      y = clamp(face.y + face.r * 0.9, H * 0.42, H * 0.73);
    }
    return { x, y, fh, side, hasFace };
  }

  contactFor(anchor) {
    const face = this.face;
    if (anchor.hasFace) {
      return {
        x: face.x + anchor.side * face.r * 0.82,
        y: face.y + face.r * 0.4,
      };
    }
    return {
      x: anchor.x - anchor.side * anchor.fh * 0.42,
      y: anchor.y - anchor.fh * 0.2,
    };
  }

  update(dt) {
    this.time += dt;
    const active = this.active;

    if (active) {
      const anchor = this.anchor();
      active.anchor = anchor;

      if (!active.ending) {
        active.time += dt;
        if (active.kind === 'fireworks') this.updateFireworks(active, dt);
        else this.updatePerson(active, dt);
      } else {
        active.endTimer += dt;
        if (active.endTimer > 0.65) this.active = null;
        this.ambientTarget = 0;
      }
    } else {
      this.ambientTarget = 0;
    }

    this.updateExtras(dt);
    this.ambientDim += (this.ambientTarget - this.ambientDim) * Math.min(1, dt * 2.8);
    if (this.ambientDim < 0.001) this.ambientDim = 0;
  }

  updateExtras(dt) {
    for (const f of this.flecks) {
      f.age += dt;
      f.px = f.x; f.py = f.y;
      f.vx *= Math.pow(0.982, dt * 60);
      f.vy = f.vy * Math.pow(0.982, dt * 60) + 26 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }
    this.flecks = this.flecks.filter((f) => f.age < f.life);

    for (const fl of this.flashes) {
      fl.age += dt;
      fl.px = fl.x; fl.py = fl.y;
      fl.x += fl.vx * dt;
      fl.y += fl.vy * dt;
    }
    this.flashes = this.flashes.filter((f) => f.age < f.life);

    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < r.life);

    for (const m of this.motes) {
      m.age += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.vy -= 8 * dt;
    }
    this.motes = this.motes.filter((m) => m.age < m.life);
  }

  updateFireworks(active, dt) {
    const cycle = Math.floor(active.time / FIRE_CYCLE);
    const cycleT = active.time - cycle * FIRE_CYCLE;
    active.cycleT = cycleT;

    if (cycle !== active.cycle) {
      active.cycle = cycle;
      active.spawned = [];
      this.flecks = [];
      this.flashes = [];
      for (const p of active.particles) {
        p.angle0 = Math.random() * TAU;
        p.spin = (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.9);
        p.r0 = 0.32 + Math.random() * 1.0;
        p.finalR = 2 + Math.random() * 22;
        p.delay = Math.random() * 0.55;
      }
      active.spots = this.fireworkSpots();
    }

    active.phase = cycleT < FIRE_GATHER ? 'gather' : cycleT < FIRE_GATHER + FIRE_SHOW ? 'show' : 'rest';

    if (active.phase === 'rest') {
      this.ambientTarget = 0;
      active.gatherAlpha = 0;
      return;
    }

    if (active.phase === 'gather') {
      this.ambientTarget = 0.55;
      active.gatherAlpha = smoothstep(0, 0.45, cycleT);
      this.layoutGather(active, cycleT / FIRE_GATHER, 'fireworks');
      return;
    }

    // fireworks
    const showT = cycleT - FIRE_GATHER;
    this.ambientTarget = 0.78;
    active.gatherAlpha = 1 - smoothstep(0, 0.9, showT);
    this.layoutGather(active, 1, 'fireworks', showT);

    const schedule = [0.55, 1.8, 3.05, 4.3];
    for (let i = 0; i < schedule.length; i++) {
      if (showT >= schedule[i] && !active.spawned[i]) {
        active.spawned[i] = true;
        const spot = active.spots[i % active.spots.length];
        this.spawnBurst(spot.x, spot.y, i);
      }
    }
  }

  fireworkSpots() {
    const W = this.W, H = this.H;
    const mobile = W < 620;
    return [
      { x: W * (mobile ? 0.26 : 0.27), y: H * 0.23 },
      { x: W * (mobile ? 0.74 : 0.73), y: H * 0.18 },
      { x: W * 0.51, y: H * (mobile ? 0.3 : 0.29) },
      { x: W * (mobile ? 0.35 : 0.38), y: H * 0.38 },
    ];
  }

  layoutGather(active, progress, kind, showT = 0) {
    const p = clamp(progress);
    const ease = smoothstep(0, 1, p);
    const anchor = active.anchor;
    const maxR = Math.hypot(this.W, this.H) * 0.58;
    const center = kind === 'fireworks'
      ? { x: this.W * 0.5, y: this.H * 0.52 }
      : { x: anchor.x, y: anchor.y - anchor.fh * 0.06 };

    active.core = center;
    for (const q of active.particles) {
      const delay = q.delay * 0.38;
      const t = smoothstep(0, 1, clamp((p - delay) / Math.max(0.001, 1 - delay)));
      const r = q.r0 * maxR * Math.pow(1 - t, 1.35) + q.finalR * (0.45 + 0.55 * t);
      const ang = q.angle0 + q.spin * t * (kind === 'fireworks' ? 1.2 : 0.8);
      q.x = center.x + Math.cos(ang) * r;
      q.y = center.y + Math.sin(ang) * r * 0.74;
      q.alpha = smoothstep(0, 0.32, t) * (kind === 'fireworks' ? 1 - showT * 0.4 : 1);
    }
  }

  spawnBurst(x, y, index) {
    const count = 260;
    const rand = mulberry32((Date.now() & 0xffffff) + index * 7919);
    for (let i = 0; i < count; i++) {
      const a = rand() * TAU;
      const speed = 105 + Math.pow(rand(), 0.5) * 375;
      this.flecks.push({
        x, y, px: x, py: y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 16,
        age: 0,
        life: 1.25 + rand() * 1.1,
        size: 0.95 + rand() * 2.1,
        warm: rand(),
        twinkle: 1.2 + rand() * 2.8,
        phase: rand() * TAU,
      });
    }
    this.flashes.push({ x, y, px: x, py: y, vx: 0, vy: 0, age: 0, life: 0.95, warm: index / 4 });
  }

  updatePerson(active, dt) {
    const anchor = active.anchor;
    const isRelease = active.kind === 'release';
    const gather = isRelease ? RELEASE_GATHER : COMFORT_GATHER;
    const end = isRelease ? RELEASE_END : COMFORT_END;

    if (active.time > end) {
      this.stop();
      return;
    }

    const t = active.time;
    const phase = t < gather ? 'gather' : 'figure';
    active.phase = phase;
    const fadeStart = end - 1.0;
    this.ambientTarget = (t < gather ? 0.52 : 0.58) * (1 - smoothstep(fadeStart, end, t));

    if (phase === 'gather') {
      active.gatherAlpha = smoothstep(0, 0.35, t);
      this.layoutGather(active, t / gather, 'figure');
      active.figureAlpha = smoothstep(0, 0.35, t);
      active.pose = this.restPose(anchor);
      return;
    }

    active.gatherAlpha = 0;
    const actionT = t - gather;
    active.figureAlpha = smoothstep(0, 0.5, t) * (1 - smoothstep(end - 1.0, end, t));
    active.pose = isRelease
      ? this.releasePose(active, anchor, actionT)
      : this.comfortPose(active, anchor, actionT);

    const follow = 1 - Math.exp(-dt * (actionT < 0.6 ? 11 : 7));
    const pose = active.pose;
    for (let i = 0; i < active.particles.length; i++) {
      const q = active.particles[i];
      const s = active.spec[i];
      if (!s) continue;
      let target;
      if (s.role === 'head' || s.role === 'torso' || s.role === 'leg') {
        target = {
          x: anchor.x + (s.x + pose.leanX) * anchor.fh + Math.sin(this.time * 1.4 + q.phase) * 1.1,
          y: anchor.y + (s.y + pose.leanY) * anchor.fh + Math.cos(this.time * 1.3 + q.phase) * 1.0,
        };
      } else {
        const arm = s.side < 0 ? pose.armL : pose.armR;
        const point = bezier(arm.shoulder, arm.elbow, arm.hand, s.t);
        const dx = arm.hand.x - arm.shoulder.x;
        const dy = arm.hand.y - arm.shoulder.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        target = {
          x: point.x + (-dy / len) * s.jitter * anchor.fh,
          y: point.y + (dx / len) * s.jitter * anchor.fh,
        };
      }
      q.x += (target.x - q.x) * follow;
      q.y += (target.y - q.y) * follow;
      q.alpha = 1;
    }

    if (isRelease) this.updateReleaseAction(active, actionT, anchor, dt);
    else this.updateComfortAction(active, actionT, anchor);
  }

  restPose(anchor) {
    const fh = anchor.fh;
    const bx = anchor.x;
    const by = anchor.y;
    const shoulderL = { x: bx - 0.105 * fh, y: by - 0.21 * fh };
    const shoulderR = { x: bx + 0.105 * fh, y: by - 0.21 * fh };
    const restL = { x: bx - 0.255 * fh, y: by + 0.075 * fh };
    const restR = { x: bx + 0.255 * fh, y: by + 0.075 * fh };
    return this.makePose(bx, by, 0, 0, shoulderL, restL, shoulderR, restR);
  }

  makePose(bx, by, leanX, leanY, shoulderL, handL, shoulderR, handR) {
    const fh = this.active?.anchor?.fh || 200;
    const elbow = (s, h, side) => ({
      x: (s.x + h.x) * 0.5 + side * 0.035 * fh,
      y: (s.y + h.y) * 0.5 + 0.045 * fh,
    });
    return {
      leanX, leanY,
      armL: { shoulder: shoulderL, elbow: elbow(shoulderL, handL, -1), hand: handL },
      armR: { shoulder: shoulderR, elbow: elbow(shoulderR, handR, 1), hand: handR },
    };
  }

  releasePose(active, anchor, t) {
    const fh = anchor.fh;
    const bx = anchor.x;
    const by = anchor.y;
    const shoulderL = { x: bx - 0.105 * fh, y: by - 0.21 * fh };
    const shoulderR = { x: bx + 0.105 * fh, y: by - 0.21 * fh };
    const restL = { x: bx - 0.255 * fh, y: by + 0.075 * fh };
    const restR = { x: bx + 0.255 * fh, y: by + 0.075 * fh };
    const holdL = { x: bx - 0.095 * fh, y: by - 0.005 * fh };
    const holdR = { x: bx + 0.095 * fh, y: by - 0.005 * fh };
    let leanX = 0, leanY = 0;
    let handL = restL, handR = restR;

    if (t < 0.55) {
      const f = smoothstep(0, 1, t / 0.55);
      handL = { x: lerp(restL.x, holdL.x, f), y: lerp(restL.y, holdL.y, f) };
      handR = { x: lerp(restR.x, holdR.x, f), y: lerp(restR.y, holdR.y, f) };
    } else if (t < 1.0) {
      const f = Math.sin(this.time * 4.2) * 1.5;
      handL = { x: holdL.x + f, y: holdL.y };
      handR = { x: holdR.x - f, y: holdR.y };
    } else if (t < 2.2) {
      const f = smoothstep(0, 1, (t - 1.0) / 1.2);
      const r = (0.105 - 0.002 * f) * fh;
      handL = { x: bx - r, y: by + 0.006 * fh };
      handR = { x: bx + r, y: by + 0.006 * fh };
      leanY = 0.009 * f;
    } else if (t < 2.55) {
      const f = smoothstep(0, 1, (t - 2.2) / 0.35);
      handL = { x: holdL.x, y: holdL.y };
      handR = {
        x: lerp(holdR.x, bx + 0.25 * fh, f),
        y: lerp(holdR.y, by - 0.78 * fh, f),
      };
      leanX = -0.014 * f;
      leanY = -0.007 * f;
    } else if (t < 3.2) {
      const f = smoothstep(0, 1, (t - 2.55) / 0.65);
      handL = { x: holdL.x, y: holdL.y };
      handR = {
        x: lerp(bx + 0.25 * fh, bx + 0.38 * fh, f),
        y: lerp(by - 0.78 * fh, by - 0.18 * fh, f),
      };
      leanX = lerp(-0.014, 0.017, f);
      leanY = lerp(-0.007, 0.007, f);
    } else {
      const f = smoothstep(0, 1, (t - 3.2) / 1.4);
      handL = { x: lerp(holdL.x, restL.x, f), y: lerp(holdL.y, restL.y, f) };
      handR = { x: lerp(bx + 0.38 * fh, restR.x, f), y: lerp(by - 0.18 * fh, restR.y, f) };
      leanX = lerp(0.017, 0, f);
      leanY = lerp(0.007, 0, f);
    }

    return this.makePose(bx, by, leanX, leanY, shoulderL, handL, shoulderR, handR);
  }

  updateReleaseAction(active, t, anchor, dt) {
    const fh = anchor.fh;
    const bx = anchor.x;
    const by = anchor.y;
    const focus = {
      x: bx,
      y: by - 0.01 * fh,
    };

    if (t >= 1.0 && t < 2.55) {
      const pack = smoothstep(0, 1, (t - 1.0) / 1.2);
      const r = lerp(4, 0.095 * fh, pack);
      const shake = Math.sin(this.time * 11) * 1.2 * (1 - pack);
      active.orb = {
        x: focus.x + shake,
        y: focus.y,
        r,
        alpha: smoothstep(0, 0.16, t - 1.0),
        state: 'pack',
        vx: 0,
        vy: 0,
        trail: [],
      };
      if (!active.ringSpawned[0] && t > 1.0) {
        active.ringSpawned[0] = true;
        this.rings.push({ x: focus.x, y: focus.y, age: 0, life: 1.7, big: 1, kind: 'pack' });
      }
    }

    if (t >= 2.2 && t < 2.55 && active.orb) {
      const f = smoothstep(0, 1, (t - 2.2) / 0.35);
      active.orb.x = focus.x + f * 0.25 * fh;
      active.orb.y = focus.y - f * 0.77 * fh;
      active.orb.r = lerp(0.095 * fh, 0.115 * fh, f);
    }

    if (t >= 2.55 && active.orb && active.orb.state === 'pack') {
      const toRight = bx < this.W * 0.5;
      const dir = toRight ? 1 : -1;
      active.orb.state = 'throw';
      active.orb.vx = dir * (this.W * 0.58);
      active.orb.vy = -this.H * 0.62;
      active.orb.trail = [];
    }

    if (active.orb && active.orb.state === 'throw') {
      const step = Math.min(0.04, Math.max(0.001, dt));
      const orb = active.orb;
      orb.x += orb.vx * step;
      orb.y += orb.vy * step;
      orb.vx *= Math.pow(0.985, step * 60);
      orb.vy = orb.vy * Math.pow(0.985, step * 60) - 18 * step;
      orb.alpha = Math.max(0, 1 - smoothstep(2.55, 4.25, t));
      orb.r *= Math.pow(0.994, step * 60);
      orb.trail.push({ x: orb.x, y: orb.y, age: 0 });
      if (orb.trail.length > 26) orb.trail.shift();
      for (const tr of orb.trail) tr.age += step;
      if (orb.alpha <= 0.005) active.orb = null;
    }
  }

  comfortPose(active, anchor, t) {
    const fh = anchor.fh;
    const bx = anchor.x;
    const by = anchor.y;
    const contact = this.contactFor(anchor);
    const near = anchor.side > 0 ? 'L' : 'R';
    const shoulderL = { x: bx - 0.105 * fh, y: by - 0.21 * fh };
    const shoulderR = { x: bx + 0.105 * fh, y: by - 0.21 * fh };
    const restL = { x: bx - 0.255 * fh, y: by + 0.075 * fh };
    const restR = { x: bx + 0.255 * fh, y: by + 0.075 * fh };
    let handL = restL;
    let handR = restR;
    let leanX = 0;
    let leanY = 0;

    if (t > 0.35 && t < 1.0) {
      const f = smoothstep(0, 1, (t - 0.35) / 0.65);
      leanX = (contact.x < bx ? -1 : 1) * 0.018 * f;
      leanY = 0.004 * f;
    }

    if (t >= 0.5 && t < 1.0) {
      const f = smoothstep(0, 1, (t - 0.5) / 0.5);
      const start = near === 'L' ? restL : restR;
      const h = { x: lerp(start.x, contact.x, f), y: lerp(start.y, contact.y, f) };
      if (near === 'L') handL = h; else handR = h;
    } else if (t >= 1.0 && t < 2.5) {
      const patT = (t - 1.0) % 0.5;
      const press = 0.5 - 0.5 * Math.cos((patT / 0.5) * TAU);
      const pull = 12 - press * 6.5;
      const dx = contact.x - bx;
      const dy = contact.y - by;
      const len = Math.max(1, Math.hypot(dx, dy));
      const h = {
        x: contact.x + (dx / len) * pull,
        y: contact.y + (dy / len) * pull,
      };
      if (near === 'L') handL = h; else handR = h;
      const idx = Math.floor((t - 1.0) / 0.5);
      if (idx >= 0 && idx < 3 && !active.ringSpawned[idx + 1] && press > 0.82) {
        active.ringSpawned[idx + 1] = true;
        this.spawnPat(contact);
      }
    } else if (t >= 2.5) {
      const f = smoothstep(0, 1, (t - 2.5) / 0.6);
      if (near === 'L') {
        handL = { x: lerp(contact.x, restL.x, f), y: lerp(contact.y, restL.y, f) };
      } else {
        handR = { x: lerp(contact.x, restR.x, f), y: lerp(contact.y, restR.y, f) };
      }
      leanX = 0;
    }

    return this.makePose(bx, by, leanX, leanY, shoulderL, handL, shoulderR, handR);
  }

  spawnPat(contact) {
    this.rings.push({ x: contact.x, y: contact.y, age: 0, life: 0.95, big: 1, kind: 'pat' });
    for (let i = 0; i < 5; i++) {
      const a = (Math.random() - 0.5) * 1.1;
      this.motes.push({
        x: contact.x + (Math.random() - 0.5) * 10,
        y: contact.y + (Math.random() - 0.5) * 8,
        vx: Math.sin(a) * 15,
        vy: -22 - Math.random() * 22,
        age: 0,
        life: 0.9 + Math.random() * 0.7,
        size: 1 + Math.random() * 1.6,
        warm: Math.random(),
      });
    }
  }

  updateComfortAction(active, t, anchor) {
    if (t > 0.5) active.contact = this.contactFor(anchor);
  }

  draw(ctx, palette) {
    const active = this.active;
    if (!active) return;

    const fade = active.ending ? 1 - clamp(active.endTimer / 0.65) : 1;
    const c = palette;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    if (active.kind === 'fireworks') {
      this.drawFireworks(ctx, active, c, fade);
    } else {
      this.drawFigure(ctx, active, c, fade);
    }
    this.drawExtras(ctx, c, fade, active);
    ctx.restore();
  }

  drawFireworks(ctx, active, c, fade) {
    const t = active.cycleT;
    const gatherAlpha = active.gatherAlpha * fade;
    const center = active.core || { x: this.W * 0.5, y: this.H * 0.52 };

    if (gatherAlpha > 0.01) {
      const gatherProgress = clamp((active.phase === 'gather' ? t : FIRE_GATHER) / FIRE_GATHER);
      glow(ctx, center.x, center.y, 80 + gatherProgress * 90, c.accent,
        (0.05 + gatherProgress * 0.1) * gatherAlpha);
      for (const q of active.particles) {
        const a = (0.35 + 0.45 * Math.sin(this.time * q.twinkle + q.phase))
          * (q.alpha ?? 1) * gatherAlpha;
        if (a < 0.01) continue;
        const col = mixColor(c.core, c.star, 0.12 + q.warm * 0.58);
        ctx.fillStyle = rgba(col, a);
        const size = q.size * (0.65 + gatherProgress * 0.55);
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(0.35, size * 0.5), 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = rgba(c.star, gatherAlpha * 0.75);
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(1, 2.2 + gatherProgress * 2.2), 0, TAU);
      ctx.fill();

      // three quiet spiral arms, so the sky visibly turns before it gathers
      ctx.strokeStyle = rgba(c.accent, gatherAlpha * 0.17);
      ctx.lineWidth = 0.7;
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 34; i++) {
          const ang = this.time * (0.6 + arm * 0.14) + (arm / 3) * TAU + i * 0.19;
          const rr = (7 + i * 2.5) * (0.45 + gatherProgress * 0.85);
          const px = center.x + Math.cos(ang) * rr;
          const py = center.y + Math.sin(ang) * rr * 0.74;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    if (active.phase === 'show' && active.cycleT >= FIRE_GATHER && active.cycleT < FIRE_GATHER + 0.62) {
      const p = smoothstep(0, 1, (active.cycleT - FIRE_GATHER) / 0.55);
      const spot = active.spots?.[0] || { x: this.W * 0.5, y: this.H * 0.24 };
      const x = lerp(center.x, spot.x, p);
      const y = lerp(center.y, spot.y, p);
      const tail = Math.min(0.22, p * 0.18);
      const tx = lerp(center.x, spot.x, Math.max(0, p - tail));
      const ty = lerp(center.y, spot.y, Math.max(0, p - tail));
      ctx.strokeStyle = rgba(c.accent, 0.45 * (1 - p));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      glow(ctx, x, y, 22, c.core, 0.3 * (1 - p));
    }
  }

  drawFigure(ctx, active, c, fade) {
    const alpha = active.figureAlpha * fade;
    if (alpha <= 0.005) return;
    const anchor = active.anchor;
    const pose = active.pose || this.restPose(anchor);
    const headY = anchor.y + (pose.leanY - 0.36) * anchor.fh;
    const headX = anchor.x + pose.leanX * anchor.fh;
    const formed = active.phase === 'figure' ? 1 : 0;

    glow(ctx, headX, headY, anchor.fh * 0.28, c.accent, 0.055 * alpha * formed);
    glow(ctx, anchor.x + pose.leanX * anchor.fh, anchor.y + pose.leanY * anchor.fh,
      anchor.fh * 0.32, c.core, 0.035 * alpha * formed);
    if (!formed) {
      const gx = anchor.x;
      const gy = anchor.y - anchor.fh * 0.06;
      glow(ctx, gx, gy, anchor.fh * 0.38, c.accent, 0.07 * alpha);
      ctx.fillStyle = rgba(c.star, alpha * 0.6);
      ctx.beginPath();
      ctx.arc(gx, gy, 2, 0, TAU);
      ctx.fill();
    }

    for (const q of active.particles) {
      const a = (0.38 + 0.52 * Math.sin(this.time * q.twinkle + q.phase)) * alpha;
      if (a < 0.008) continue;
      const col = mixColor(c.accent, c.star, 0.18 + q.warm * 0.5);
      const size = q.size * 0.95;
      ctx.fillStyle = rgba(col, a);
      ctx.beginPath();
      ctx.arc(q.x, q.y, Math.max(0.35, size * 0.5), 0, TAU);
      ctx.fill();
    }

    if (active.kind === 'release') {
      this.drawBadOrb(ctx, active, c, alpha);
    } else {
      this.drawContact(ctx, active, c, alpha);
    }
  }

  drawBadOrb(ctx, active, c, alpha) {
    const orb = active.orb;
    if (!orb) return;
    const rgbDark = [12, 6, 18];

    if (orb.trail?.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < orb.trail.length; i++) {
        const t = orb.trail[i];
        const a = (i / orb.trail.length) * 0.22 * orb.alpha;
        ctx.fillStyle = rgba(mixColor(rgbDark, c.accent, 0.45), a);
        const r = Math.max(0.4, orb.r * (i / orb.trail.length) * 0.55);
        ctx.beginPath();
        ctx.arc(t.x, t.y, r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha * orb.alpha;
    const g = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, Math.max(1, orb.r));
    g.addColorStop(0, 'rgba(11,5,16,0.98)');
    g.addColorStop(0.58, 'rgba(30,10,35,0.9)');
    g.addColorStop(0.86, 'rgba(55,20,64,0.38)');
    g.addColorStop(1, 'rgba(20,8,26,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, Math.max(1, orb.r), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = alpha * orb.alpha * 0.5;
    ctx.strokeStyle = rgba(c.accent, 0.6);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, Math.max(1, orb.r * 0.72), 0, TAU);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, orb.x, orb.y, orb.r * 2.6, c.accent, 0.1 * orb.alpha * alpha);
    const n = 18;
    for (let i = 0; i < n; i++) {
      const ang = this.time * (1.3 + (i % 3) * 0.25) + (i / n) * TAU;
      const rr = orb.r * (1.15 + 0.18 * Math.sin(this.time * 2 + i));
      ctx.fillStyle = rgba(i % 2 ? c.accent : c.core, 0.34 * orb.alpha * alpha);
      ctx.beginPath();
      ctx.arc(orb.x + Math.cos(ang) * rr, orb.y + Math.sin(ang) * rr, 0.7 + (i % 3) * 0.35, 0, TAU);
      ctx.fill();
    }
    if (orb.state === 'pack') {
      for (let i = 0; i < 15; i++) {
        const phase = (this.time * 0.42 + i / 15) % 1;
        const rr = orb.r * (2.55 - 1.55 * phase);
        const ang = (i / 15) * TAU + this.time * 0.85 + phase * 1.6;
        ctx.fillStyle = rgba(mixColor(c.core, c.accent, 0.45 * phase), 0.34 * (1 - phase) * alpha);
        ctx.beginPath();
        ctx.arc(orb.x + Math.cos(ang) * rr, orb.y + Math.sin(ang) * rr * 0.82, 0.65, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawContact(ctx, active, c, alpha) {
    const anchor = active.anchor;
    const contact = active.contact || this.contactFor(anchor);
    const t = active.time - COMFORT_GATHER;
    if (t < 0.7) return;
    const activeGlow = 0.07 + 0.05 * Math.sin(this.time * 3.4);
    glow(ctx, contact.x, contact.y, anchor.fh * 0.32, c.accent, activeGlow * alpha);
    ctx.strokeStyle = rgba(c.star, alpha * 0.09);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(contact.x, contact.y, anchor.fh * 0.11 + Math.sin(this.time * 2.5) * 2.5, 0, TAU);
    ctx.stroke();
  }

  drawExtras(ctx, c, fade, active) {
    // expanding soft rings (packing and pats)
    for (const r of this.rings) {
      const p = clamp(r.age / r.life);
      const a = (1 - p) * (r.kind === 'pat' ? 0.5 : 0.24) * fade;
      const rad = r.kind === 'pat'
        ? 8 + p * (r.big || 1) * 62
        : 78 - p * (r.big || 1) * 62;
      ctx.strokeStyle = rgba(c.accent, a);
      ctx.lineWidth = r.kind === 'pat' ? 1 : 0.8;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, TAU);
      ctx.stroke();
    }

    // gentle motes rising from a pat
    for (const m of this.motes) {
      const p = clamp(m.age / m.life);
      const a = (1 - p) * 0.5 * fade;
      ctx.fillStyle = rgba(mixColor(c.accent, c.star, m.warm * 0.6), a);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.size * (1 - p * 0.4), 0, TAU);
      ctx.fill();
    }

    // firework flashes and sparks
    for (const fl of this.flashes) {
      const p = clamp(fl.age / fl.life);
      const a = (1 - p) * fade;
      glow(ctx, fl.x, fl.y, 44 + p * 150, c.star, 0.32 * a);
      glow(ctx, fl.x, fl.y, 95 + p * 130, c.accent, 0.1 * a);
      if (p < 0.16) {
        ctx.fillStyle = rgba(c.star, (1 - p / 0.16) * 0.9);
        ctx.beginPath();
        ctx.arc(fl.x, fl.y, 5 + (1 - p / 0.16) * 8, 0, TAU);
        ctx.fill();
      }
    }

    for (const f of this.flecks) {
      const p = f.age / f.life;
      const a = Math.pow(1 - p, 1.2) * (0.72 + 0.28 * Math.sin(this.time * f.twinkle + f.phase)) * fade;
      if (a < 0.01) continue;
      const col = f.warm < 0.3
        ? mixColor(c.mid, c.accent, 0.5)
        : mixColor(c.accent, c.star, 0.18 + f.warm * 0.66);
      const tx = f.x - f.vx * 0.055;
      const ty = f.y - f.vy * 0.055;
      ctx.strokeStyle = rgba(col, a * 0.85);
      ctx.lineWidth = Math.max(0.55, f.size * 0.6);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      ctx.fillStyle = rgba(col, Math.min(1, a * 1.25));
      ctx.beginPath();
      ctx.arc(f.x, f.y, Math.max(0.45, f.size * 0.52), 0, TAU);
      ctx.fill();
      if (f.warm > 0.87) {
        ctx.strokeStyle = rgba(c.star, a * 0.42);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(f.x - f.size * 2.4, f.y);
        ctx.lineTo(f.x + f.size * 2.4, f.y);
        ctx.moveTo(f.x, f.y - f.size * 2.4);
        ctx.lineTo(f.x, f.y + f.size * 2.4);
        ctx.stroke();
      }
    }
  }
}
