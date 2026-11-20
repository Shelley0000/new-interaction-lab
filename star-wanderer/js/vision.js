/* MediaPipe wrappers. Everything happens on this device; results are numbers,
   landmarks and a soft mask. Nothing is recorded unless the visitor asks. */

import {
  FilesetResolver, FaceLandmarker, GestureRecognizer, ImageSegmenter,
} from '../vendor/vision_bundle.mjs';
import { clamp, EMOTION_ORDER } from './emotions.js';

const WASM_PATH = new URL('../vendor/wasm', import.meta.url).href;
const FACE_MODEL = new URL('../vendor/models/face_landmarker.task', import.meta.url).href;
const HAND_MODEL = new URL('../vendor/models/gesture_recognizer.task', import.meta.url).href;
const SEG_MODEL = new URL('../vendor/models/selfie_segmenter.tflite', import.meta.url).href;

const FACE_KEYS = [
  'mouthSmileLeft', 'mouthSmileRight', 'cheekSquintLeft', 'cheekSquintRight',
  'jawOpen', 'mouthFrownLeft', 'mouthFrownRight', 'browDownLeft', 'browDownRight',
  'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'noseSneerLeft', 'noseSneerRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft',
  'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
];

const GESTURE_TO_EMOTION = {
  Thumb_Up: 'joy',
  Thumb_Down: 'anger',
  Victory: 'delight',
  Pointing_Up: 'sadness',
  Closed_Fist: 'anxiety',
};

function median(values) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bbox(points) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, top: y0, bottom: y1 };
}

function fingerState(lm) {
  // A small geometric fallback when the classifier sees no named gesture.
  const wrist = lm[0];
  const index = dist(wrist, lm[8]) > dist(wrist, lm[6]) * 1.16;
  const middle = dist(wrist, lm[12]) > dist(wrist, lm[10]) * 1.16;
  const ring = dist(wrist, lm[16]) > dist(wrist, lm[14]) * 1.16;
  const pinky = dist(wrist, lm[20]) > dist(wrist, lm[18]) * 1.16;
  const thumb = dist(lm[4], lm[17]) > dist(lm[2], lm[17]) * 1.1;
  return { index, middle, ring, pinky, thumb, count: [index, middle, ring, pinky, thumb].filter(Boolean).length };
}

class HandTrack {
  constructor(id, hand) {
    this.id = id;
    this.x = hand.x; this.y = hand.y;
    this.prevX = hand.x; this.prevY = hand.y;
    this.vx = 0; this.vy = 0;
    this.label = null;
    this.candidate = null;
    this.since = 0;
    this.lastSeen = performance.now();
    this.score = 0;
  }
}

export class Vision {
  constructor() {
    this.fileset = null;
    this.face = null;
    this.hand = null;
    this.segmenter = null;
    this.ready = false;
    this.mode = 'expression';
    this.video = null;
    this.ts = 0;

    this.faceInfo = null;
    this.blend = {};
    this.baseline = {};
    this.calibration = { active: false, duration: 3, elapsed: 0, progress: 0, done: false };
    this.calSamples = [];
    this.onCalibrated = null;

    this.expression = { top: 'calm', scores: {}, intensity: 0.08, stable: 'calm' };
    this.candidate = 'calm';
    this.candidateSince = 0;
    this.smoothScores = {};

    this.hands = [];
    this.tracks = new Map();
    this.nextTrack = 1;
    this.gesture = { top: 'calm', intensity: 0.08, label: null };
    this.anxietyLevel = 0;

    this.mask = document.createElement('canvas');
    this.mask.width = 320; this.mask.height = 180;
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true });
    this.fullMask = document.createElement('canvas');
    this.fullMaskCtx = this.fullMask.getContext('2d');
    this.maskImage = null;
    this.maskReady = false;
    this.lastMaskAt = 0;

    this.buffer = [];
    this.noFace = 99;
    this.lastSegmentAt = 0;
    this.segmentEnabled = true;
  }

  setStatus(fn) { this.statusFn = fn; }
  note(text) { this.statusFn?.(text); }

  async init() {
    if (this.ready) return;
    this.note('正在点亮星云');
    this.fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

    const IS_TOUCH = window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;

    const build = async (name, factory, opts, delegates = ['GPU', 'CPU']) => {
      for (const delegate of delegates) {
        try {
          const o = { ...opts, baseOptions: { ...opts.baseOptions, delegate } };
          const model = await factory(this.fileset, o);
          console.info(`[vision] ${name}: ${delegate}`);
          return model;
        } catch (err) {
          console.warn(`[vision] ${name} ${delegate} failed`, err?.message || err);
        }
      }
      throw new Error(`${name} 无法启动`);
    };

    this.face = await build('face', (fs, o) => FaceLandmarker.createFromOptions(fs, o), {
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
      baseOptions: { modelAssetPath: FACE_MODEL },
    });

    // 手机端优先用 CPU 跑手势，GPU 在部分移动浏览器上会静默失败；
    // 单手已经足够，减少一半跟踪开销。
    this.hand = await build('hand', (fs, o) => GestureRecognizer.createFromOptions(fs, o), {
      runningMode: 'VIDEO', numHands: 1,
      baseOptions: { modelAssetPath: HAND_MODEL },
    }, IS_TOUCH ? ['CPU', 'GPU'] : ['GPU', 'CPU']);

    if (IS_TOUCH) {
      // 手机不做实时人物分割，把算力留给手势识别，舞台改用柔边圆窗。
      this.segmenter = null;
      this.segmentEnabled = false;
    } else {
      try {
        this.segmenter = await build('segmenter', (fs, o) => ImageSegmenter.createFromOptions(fs, o), {
          runningMode: 'VIDEO', outputCategoryMask: true, outputConfidenceMasks: false,
          baseOptions: { modelAssetPath: SEG_MODEL },
        });
      } catch (err) {
        // face and hand still work; the stage will fall back to a soft window
        console.warn('[vision] segmenter unavailable', err?.message || err);
        this.segmenter = null;
        this.segmentEnabled = false;
      }
    }

    this.ready = true;
    this.note('星云已就绪');
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.hands = [];
    this.tracks.clear();
    this.faceInfo = null;
    this.blend = {};
    this.gesture = { top: 'calm', intensity: 0.08, label: null };
    this.buffer = [];
    this.candidate = 'calm';
    this.expression.stable = 'calm';
    this.expression.top = 'calm';
  }

  startCalibration(seconds = 3) {
    this.calibration = { active: true, duration: seconds, elapsed: 0, progress: 0, done: false, startedAt: performance.now() };
    this.calSamples = [];
    this.baseline = {};
  }

  skipCalibration() {
    this.calibration = { active: false, duration: 0, elapsed: 0, progress: 1, done: true };
    this.calSamples = [];
    this.baseline = {};
    this.smoothScores = {};
    this.candidate = 'calm';
    this.expression.top = 'calm';
    this.expression.stable = 'calm';
  }

  finishCalibration() {
    if (!this.calSamples.length) {
      this.calibration.active = false;
      this.calibration.done = true;
      this.calibration.progress = 1;
      return;
    }
    const base = {};
    for (const k of FACE_KEYS) base[k] = median(this.calSamples.map((s) => s[k] || 0));
    this.baseline = base;
    this.calibration.active = false;
    this.calibration.done = true;
    this.calibration.progress = 1;
    this.smoothScores = {};
    this.candidate = 'calm';
    this.expression.stable = 'calm';
    this.onCalibrated?.();
  }

  faceGeometry(lm) {
    const nose = lm[1];
    const top = lm[10];
    const chin = lm[152];
    const left = lm[33];
    const right = lm[263];
    const eye = Math.max(0.001, dist(left, right));
    const height = Math.max(0.001, dist(top, chin));
    const centerY = (top.y + chin.y) / 2;
    return {
      x: nose.x,
      y: centerY,
      r: clamp(height * 0.68, 0.08, 0.5),
      eye,
      yaw: (nose.x - (left.x + right.x) / 2) / eye,
      pitch: (nose.y - (top.y + chin.y) / 2) / height,
    };
  }

  updateFace(video, ts, dt) {
    if (!this.face) return;
    let res;
    try {
      res = this.face.detectForVideo(video, ts);
    } catch (err) {
      console.warn('[vision] face', err?.message || err);
      return;
    }
    const lm = res.faceLandmarks?.[0];
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (!lm || !cats) {
      this.faceInfo = null;
      this.noFace += dt;
      if (this.noFace > 0.5) {
        this.expression.top = 'calm';
        this.expression.stable = 'calm';
        this.expression.intensity = 0.08;
        this.candidate = 'calm';
      }
      res.close?.();
      return;
    }

    this.noFace = 0;
    this.faceInfo = this.faceGeometry(lm);
    const blend = {};
    for (const c of cats) blend[c.categoryName] = c.score;
    this.blend = blend;

    if (this.calibration.active) {
      this.calSamples.push({ ...blend });
      this.calibration.elapsed = Math.min(
        this.calibration.duration,
        (performance.now() - this.calibration.startedAt) / 1000,
      );
      this.calibration.progress = this.calibration.elapsed / this.calibration.duration;
      if (this.calibration.elapsed >= this.calibration.duration) this.finishCalibration();
    }

    this.computeExpression(dt);
    res.close?.();
  }

  deltas() {
    const out = {};
    const b = this.baseline;
    for (const k of FACE_KEYS) out[k] = Math.max(0, (this.blend[k] || 0) - (b[k] || 0) - 0.025);
    return out;
  }

  computeExpression(dt) {
    const d = this.deltas();
    const smile = (d.mouthSmileLeft + d.mouthSmileRight) / 2;
    const cheek = (d.cheekSquintLeft + d.cheekSquintRight) / 2;
    const jaw = d.jawOpen;
    const frown = (d.mouthFrownLeft + d.mouthFrownRight) / 2;
    const browDown = (d.browDownLeft + d.browDownRight) / 2;
    const browInner = d.browInnerUp;
    const browOuter = (d.browOuterUpLeft + d.browOuterUpRight) / 2;
    const press = (d.mouthPressLeft + d.mouthPressRight) / 2;
    const sneer = (d.noseSneerLeft + d.noseSneerRight) / 2;
    const squint = (d.eyeSquintLeft + d.eyeSquintRight) / 2;
    const wide = (d.eyeWideLeft + d.eyeWideRight) / 2;
    const pucker = d.mouthPucker;

    const absSmile = ((this.blend.mouthSmileLeft || 0) + (this.blend.mouthSmileRight || 0)) / 2;
    const absJaw = this.blend.jawOpen || 0;

    let joy = 0.64 * smile + 0.2 * cheek + 0.12 * squint - 0.28 * Math.max(0, jaw - 0.32);
    let delight = 0.56 * jaw + 0.28 * smile + 0.22 * cheek + 0.08 * wide;
    // a clear smile is a mood even when it was already there during calibration
    joy += 0.42 * absSmile;
    delight += 0.2 * absSmile + 0.16 * absJaw;
    let anger = 0.4 * browDown + 0.24 * press + 0.22 * sneer + 0.16 * browInner - 0.35 * smile;
    let sadness = 0.46 * frown + 0.34 * browInner + 0.12 * browOuter + 0.1 * pucker - 0.3 * smile - 0.25 * jaw;
    let anxiousFace = 0.34 * browInner + 0.24 * browDown + 0.24 * press + 0.12 * wide + 0.1 * sneer;

    // a five second window, so a blink or a single frame does not become a mood
    const gazeX = (d.eyeLookOutLeft + d.eyeLookInRight) - (d.eyeLookInLeft + d.eyeLookOutRight);
    const gazeY = (d.eyeLookUpLeft + d.eyeLookUpRight) - (d.eyeLookDownLeft + d.eyeLookDownRight);
    const browTension = 0.6 * browDown + 0.4 * browInner;
    const now = performance.now();
    this.buffer.push({
      t: now, bx: this.faceInfo?.x || 0.5, by: this.faceInfo?.y || 0.4,
      gx: gazeX, gy: gazeY, bt: browTension,
    });
    while (this.buffer.length && now - this.buffer[0].t > 5000) this.buffer.shift();

    let temporal = 0;
    if (this.buffer.length > 8 && now - this.buffer[0].t > 2200) {
      const n = this.buffer.length;
      let mx = 0, my = 0, gx = 0, gy = 0, bt = 0;
      for (const s of this.buffer) { mx += s.bx; my += s.by; gx += s.gx; gy += s.gy; bt += s.bt; }
      mx /= n; my /= n; gx /= n; gy /= n; bt /= n;
      let vx = 0, vy = 0, vg = 0;
      for (const s of this.buffer) {
        vx += (s.bx - mx) ** 2; vy += (s.by - my) ** 2;
        vg += (s.gx - gx) ** 2 + (s.gy - gy) ** 2;
      }
      const headStd = Math.sqrt(vx / n + vy / n);
      const gazeStd = Math.sqrt(vg / n);
      temporal = 0.5 * clamp((bt - 0.1) * 2.4) + 0.28 * clamp(gazeStd * 7) + 0.22 * clamp(headStd * 90);
    }
    this.anxietyLevel = temporal;

    const scores = {
      joy: clamp((joy - 0.1) / 0.64),
      anger: clamp((anger - 0.12) / 0.6),
      delight: clamp((delight - 0.14) / 0.62),
      sadness: clamp((sadness - 0.13) / 0.58),
      anxiety: clamp((Math.max(anxiousFace, temporal) - 0.13) / 0.58),
    };

    const smooth = this.smoothScores;
    for (const k of EMOTION_ORDER) smooth[k] = (smooth[k] ?? 0) + (scores[k] - (smooth[k] ?? 0)) * Math.min(1, dt * 4.5);

    let top = 'calm', best = 0.17;
    for (const k of EMOTION_ORDER) if (smooth[k] > best) { best = smooth[k]; top = k; }

    const t = performance.now();
    if (top !== this.candidate) { this.candidate = top; this.candidateSince = t; }
    if (t - this.candidateSince > 380) this.expression.stable = top;
    this.expression.top = top;
    this.expression.scores = smooth;
    this.expression.intensity = top === 'calm' ? 0.1 : clamp(0.2 + best * 0.8);
    this.expression.best = best;
  }

  updateHands(video, ts, dt) {
    if (!this.hand) return;
    let res;
    try {
      res = this.hand.recognizeForVideo(video, ts);
    } catch (err) {
      console.warn('[vision] hand', err?.message || err);
      return;
    }
    const now = performance.now();
    const seen = new Set();
    const hands = [];

    for (let i = 0; i < res.landmarks.length; i++) {
      const lm = res.landmarks[i];
      const g = res.gestures[i]?.[0];
      const box = bbox(lm);
      let track = null, best = 0.22;
      for (const t of this.tracks.values()) {
        if (seen.has(t.id)) continue;
        const dd = Math.hypot(t.x - box.x, t.y - box.y);
        if (dd < best) { best = dd; track = t; }
      }
      if (!track) {
        track = new HandTrack(this.nextTrack++, box);
        this.tracks.set(track.id, track);
      }
      seen.add(track.id);

      const vx = (box.x - track.prevX) / Math.max(0.016, dt);
      const vy = (box.y - track.prevY) / Math.max(0.016, dt);
      track.vx = track.vx * 0.6 + vx * 0.4;
      track.vy = track.vy * 0.6 + vy * 0.4;
      track.prevX = track.x; track.prevY = track.y;
      track.x = box.x; track.y = box.y;
      track.lastSeen = now;
      track.score = g?.score || 0;
      track.landmarks = lm;

      let label = g?.categoryName && g.categoryName !== 'None' ? g.categoryName : null;
      let conf = g?.score || 0;
      if (!label) {
        const f = fingerState(lm);
        if (f.count >= 4) { label = 'Open_Palm'; conf = 0.5; }
        else if (f.index && !f.middle && !f.ring && !f.pinky && !f.thumb) {
          label = 'Pointing_Up'; conf = 0.55;
        } else if (f.count <= 1) { label = 'Closed_Fist'; conf = 0.5; }
      }

      if (label && label !== track.candidate) { track.candidate = label; track.since = now; }
      if (track.candidate && now - track.since > 260) {
        if (track.label !== track.candidate) track.label = track.candidate;
      }

      hands.push({
        id: track.id, x: box.x, y: box.y, w: box.w, h: box.h,
        label: track.label, candidate: track.candidate, score: conf,
        vx: track.vx, landmarks: lm,
      });
    }

    for (const [id, t] of this.tracks) {
      if (now - t.lastSeen > 420) this.tracks.delete(id);
    }

    this.hands = hands;
    this.gesture = this.resolveGesture(hands);
    res.close?.();
  }

  resolveGesture(hands) {
    let chosen = null;
    for (const h of hands) {
      if (!h.label || !GESTURE_TO_EMOTION[h.label]) continue;
      if (!chosen || h.score > chosen.score) chosen = h;
    }
    if (!chosen) return { top: 'calm', intensity: 0.1, label: null };
    return {
      top: GESTURE_TO_EMOTION[chosen.label],
      intensity: clamp(0.35 + chosen.score * 0.6),
      label: chosen.label,
    };
  }

  updateMask(video, ts) {
    if (!this.segmenter) return;
    let res;
    try {
      res = this.segmenter.segmentForVideo(video, ts);
    } catch (err) {
      console.warn('[vision] segment', err?.message || err);
      return;
    }
    const cat = res.categoryMask;
    if (!cat) { res.close?.(); return; }
    const w = cat.width, h = cat.height;
    if (this.fullMask.width !== w || this.fullMask.height !== h) {
      this.fullMask.width = w; this.fullMask.height = h;
      this.maskImage = null;
    }
    if (!this.maskImage) this.maskImage = new ImageData(w, h);
    const arr = cat.getAsUint8Array();
    const img = this.maskImage;
    const data = img.data;
    for (let i = 0; i < arr.length; i++) {
      // Selfie Segmenter's category 0 is the person, 255 is the background.
      const a = arr[i] ? 0 : 255;
      const j = i * 4;
      data[j] = 255; data[j + 1] = 255; data[j + 2] = 255; data[j + 3] = a;
    }
    this.fullMaskCtx.putImageData(img, 0, 0);

    this.maskCtx.clearRect(0, 0, this.mask.width, this.mask.height);
    this.maskCtx.imageSmoothingEnabled = true;
    this.maskCtx.filter = 'blur(1.3px)';
    this.maskCtx.drawImage(this.fullMask, 0, 0, this.mask.width, this.mask.height);
    this.maskCtx.filter = 'none';
    this.maskReady = true;
    this.lastMaskAt = performance.now();
    res.close?.();
  }

  async update(video, dt = 0.07) {
    if (!this.ready || !video || video.readyState < 2) return;
    this.video = video;
    const now = performance.now();
    this.ts = Math.max(this.ts + 1, now);
    const ts = this.ts;

    if (this.mode === 'expression') {
      this.updateFace(video, ts, dt);
    } else {
      this.updateHands(video, ts, dt);
    }

    if (this.segmentEnabled && now - this.lastSegmentAt > 110) {
      this.lastSegmentAt = now;
      this.updateMask(video, ts);
    }
  }

  setSegment(on) {
    this.segmentEnabled = !!on;
    if (!on) this.maskReady = false;
  }

  getCalibration() { return this.calibration; }
  getExpression() { return this.expression; }
  getGesture() { return this.gesture; }
  getMask() { return this.maskReady ? this.mask : null; }
  getFace() { return this.faceInfo; }
  getHands() { return this.hands; }

  close() {
    this.face?.close?.();
    this.hand?.close?.();
    this.segmenter?.close?.();
    this.face = this.hand = this.segmenter = null;
    this.ready = false;
  }
}
