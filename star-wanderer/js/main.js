/* 星际漫游 — a small state machine around the nebula, the camera and the archive. */

import { NebulaStage } from './nebula.js';
import { Vision } from './vision.js';
import {
  EMOTIONS, EMOTION_ORDER, GESTURE_MAP, meta,
  loadEmotionColors, emotionColorHex, DEFAULT_EMOTION_COLORS,
  setEmotionColor, resetEmotionColors, isEmotionColorCustom, hasCustomEmotionColors,
} from './emotions.js';
import * as Archive from './archive.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const stageEl = $('stage');
const video = $('camera');

const stage = new NebulaStage(stageEl);
const vision = new Vision();

const DEBUG = new URLSearchParams(location.search).has('debug');
const IS_TOUCH = window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const state = {
  scene: 'intro',
  input: 'expression',
  presence: 'self',
  demo: false,
  paused: false,
  pauseAt: 0,
  switching: false,
  busy: false,
  prepareToken: 0,
  startedAt: 0,
  elapsed: 0,
  lastVision: 0,
  lastSample: 0,
  emotion: 'calm',
  intensity: 0.1,
  holdKey: null,
  holdTime: 0,
  hold: 0,
  storyKey: 'calm',
  weights: {},
  activeTime: 0,
  totalTime: 0,
  samples: [],
  modeSwitches: 0,
  hasSeg: false,
  degraded: false,
  perfChecked: false,
  demoEmotion: 'joy',
  keep: 'none',
  shotBlob: null,
  shotUrl: null,
  endAt: null,
  sessionTimer: 0,
  calWatch: 0,
  shotBusy: false,
};

let stream = null;
let sessionRaf = 0;

loadEmotionColors();

/* ───────────────────────── basics ───────────────────────── */

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function modeLabel() {
  if (state.demo) return '演示';
  if (state.modeSwitches > 0) return '表情 / 手势';
  return state.input === 'gesture' ? '手势' : '表情';
}

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('is-on'), ms);
}

function showScene(name) {
  state.scene = name;
  app.dataset.scene = name;
  $('scene-intro').classList.toggle('is-hidden', name !== 'intro');
  $('scene-prepare').classList.toggle('is-hidden', name !== 'prepare');
  $('hud').classList.toggle('is-hidden', name !== 'session');
}

function updateClock() {
  $('intro-clock').textContent = fmtClock();
}
updateClock();
setInterval(updateClock, 20000);

/* ───────────────────────── gesture guide ───────────────────────── */

function gestureChipHTML(key) {
  const g = GESTURE_MAP[key];
  const m = EMOTIONS[key];
  return `<div class="gesture-chip" data-gesture="${key}">
    <span class="g-icon-wrap"><svg class="icon" aria-hidden="true"><use href="#${g.icon}"/></svg></span>
    <span class="g-label">${m.han}</span>
    <span class="g-how">${g.how}</span>
  </div>`;
}

function buildGuides() {
  const html = EMOTION_ORDER.map(gestureChipHTML).join('');
  $('gesture-list-prepare').innerHTML = html;
  $('gesture-list-session').innerHTML = html;
}
buildGuides();

/* ───────────────────────── intro choices ───────────────────────── */

function bindChoice(container, onPick) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.choice');
    if (!btn || !container.contains(btn)) return;
    container.querySelectorAll('.choice').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('is-selected', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    onPick(btn.dataset.value);
  });
}

bindChoice($('input-choice'), (v) => { state.input = v; });
bindChoice($('presence-choice'), (v) => { state.presence = v; });

/* ───────────────────────── emotion palette ───────────────────────── */

const colorInputs = new Map();
let colorReturnFocus = null;

function buildColorControls() {
  $('color-preview').innerHTML = EMOTION_ORDER.map((k) => `<i data-emotion="${k}"></i>`).join('');
  for (const k of EMOTION_ORDER) {
    const input = $(`color-${k}`);
    if (!input) continue;
    colorInputs.set(k, input);
    input.title = `默认 ${DEFAULT_EMOTION_COLORS[k].toUpperCase()}`;
    input.addEventListener('input', () => {
      if (!setEmotionColor(k, input.value)) return;
      refreshColorPanel();
    });
    input.addEventListener('change', () => {
      setEmotionColor(k, input.value);
      refreshColorPanel();
    });
  }
}

function refreshColorPanel() {
  for (const k of EMOTION_ORDER) {
    const hex = emotionColorHex(k);
    const input = colorInputs.get(k);
    const top = input ? input.closest('.color-row') : null;
    if (input) input.value = hex;
    if (top) {
      top.style.setProperty('--c', hex);
      top.classList.toggle('is-custom', isEmotionColorCustom(k));
    }
    const hexEl = $(`hex-${k}`);
    const stateEl = $(`state-${k}`);
    if (hexEl) hexEl.textContent = hex.toUpperCase();
    if (stateEl) stateEl.textContent = isEmotionColorCustom(k) ? '已调整' : '默认';

    const preview = $('color-preview').querySelector(`[data-emotion="${k}"]`);
    if (preview) {
      preview.style.setProperty('--c', hex);
      preview.style.setProperty('--d', `rgb(${EMOTIONS[k].colors.deep.join(',')})`);
    }
  }
  $('colors-reset').disabled = !hasCustomEmotionColors();
  $('open-colors').classList.toggle('has-custom', hasCustomEmotionColors());
}

function openColors() {
  if (state.scene !== 'intro') return;
  colorReturnFocus = document.activeElement;
  refreshColorPanel();
  $('colors-overlay').classList.remove('is-hidden');
  requestAnimationFrame(() => $('colors-close').focus());
}

function closeColors() {
  $('colors-overlay').classList.add('is-hidden');
  if (colorReturnFocus && typeof colorReturnFocus.focus === 'function') colorReturnFocus.focus();
  colorReturnFocus = null;
}

buildColorControls();
refreshColorPanel();

/* ───────────────────────── camera / models ───────────────────────── */

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        // 手机使用较小的画面，手势模型可以更快出结果。
        width: { ideal: IS_TOUCH ? 640 : 1280 },
        height: { ideal: IS_TOUCH ? 480 : 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    video.srcObject = stream;
    await video.play();
    return true;
  } catch (err) {
    console.warn('[camera]', err?.name, err?.message);
    return false;
  }
}

function stopCamera() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  try { video.pause(); } catch (_) { /* noop */ }
  video.srcObject = null;
}

async function ensureVision() {
  if (vision.ready) return true;
  vision.setStatus((text) => {
    if (state.scene === 'prepare') setPrepStatus(text);
  });
  try {
    await vision.init();
    return true;
  } catch (err) {
    console.error('[vision]', err);
    return false;
  }
}

function setPrepStatus(text, dot = true) {
  $('prep-status').innerHTML = `${dot ? '<span class="status-dot"></span>' : ''}${text}`;
}

/* ───────────────────────── prepare ───────────────────────── */

function resetPrepareUI() {
  const gesture = state.input === 'gesture';
  $('prep-eyebrow').innerHTML = `<span class="rule"></span>第 01 幕 · ${gesture ? '手势' : '表情'}`;
  $('prep-title').textContent = gesture ? '让手进入星云' : '先安静三秒';
  $('prep-body').innerHTML = gesture
    ? '把一只手放进画面，让星云认出它。<br>五种手势，五场不同的天气。'
    : '放松肩膀，看向镜头，做一次中性的呼吸。<br>星云会记住这一刻的你。';
  $('prep-status').innerHTML = '<span class="status-dot"></span>正在打开镜头';
  $('prep-actions').innerHTML = '';
  $('prepare-ring').style.display = gesture ? 'none' : '';
  $('prepare-ring').classList.toggle('is-waiting', gesture);
  $('prepare-guide').hidden = !gesture;
  $('gesture-list-prepare').querySelectorAll('.gesture-chip').forEach((c) => c.classList.remove('is-active'));
  $('ring-progress').style.strokeDashoffset = '590.6';
  $('ring-label').textContent = '03';
  $('ring-label').style.fontSize = '';
}

function addSkipButton(label = '跳过，直接开始') {
  if (!state.scene || state.scene !== 'prepare') return;
  const actions = $('prep-actions');
  if (actions.querySelector('button')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'text-btn';
  b.textContent = label;
  b.addEventListener('click', () => {
    if (state.scene === 'prepare') startSession();
  });
  actions.appendChild(b);
}

async function begin() {
  if (state.busy) return;
  state.busy = true;
  state.prepareToken++;
  const token = state.prepareToken;
  state.demo = false;
  state.degraded = false;
  state.modeSwitches = 0;
  state.hasSeg = false;

  resetPrepareUI();
  showScene('prepare');
  stage.setPreview(true);
  stage.setShowPerson(true);
  stage.setWindow(0);
  stage.setPalette('calm', { immediate: true });
  stage.setIntensity(0.14);
  stage.setSustain(0);
  stage.clearStory();
  stage.setReveal(1);
  stage.setFace(null);

  const cameraOK = await openCamera();
  if (token !== state.prepareToken) { state.busy = false; return; }

  if (!cameraOK) {
    enterDemoPrepare(token, '摄像头没有打开');
    state.busy = false;
    return;
  }

  setPrepStatus('镜头已打开，正在点亮星云');
  stage.setVideo(video);

  const visionOK = await ensureVision();
  if (token !== state.prepareToken) { state.busy = false; return; }

  if (!visionOK) {
    enterDemoPrepare(token, '无法读取表情或手势');
    state.busy = false;
    return;
  }

  vision.setMode(state.input);
  // 手机端不做实时人物分割，把手势模型的算力留给手。
  vision.setSegment(!IS_TOUCH && (state.presence === 'self' || state.input === 'gesture'));
  if (state.input === 'expression') vision.startCalibration(3);
  stage.setVideo(video);
  runPrepareLoop(token);

  if (state.input === 'gesture') {
    // 独立于识别循环的兜底计时器：即使某次推理卡住，也能看到跳过按钮。
    setTimeout(() => {
      if (token === state.prepareToken && state.scene === 'prepare') {
        addSkipButton('跳过准备，直接开始');
        if (!vision.getHands().length) setPrepStatus('手势没有出现 · 可以跳过准备');
      }
    }, 3200);
  }

  state.busy = false;
}

function enterDemoPrepare(token, reason) {
  state.demo = true;
  state.hasSeg = false;
  stopCamera();
  stage.setPreview(false);
  stage.setShowPerson(false);
  stage.setWindow(0);
  $('prepare-ring').style.display = 'none';
  $('prepare-guide').hidden = true;
  $('prep-title').textContent = '以演示模式漫游';
  $('prep-body').innerHTML = '镜头没有打开。没有关系——<br>用键盘 <kbd>1</kbd>–<kbd>5</kbd>，也能看见五种天气。';
  setPrepStatus(`${reason} · 演示模式`);
  $('prep-actions').innerHTML = '<button class="primary-btn" type="button" id="demo-start"><span>进入演示</span><svg class="icon"><use href="#i-arrow"/></svg></button>';
  $('demo-start').addEventListener('click', () => {
    if (token === state.prepareToken) startSession();
  });
  setTimeout(() => {
    if (token === state.prepareToken && state.scene === 'prepare') startSession();
  }, 2600);
}

function runPrepareLoop(token) {
  let last = performance.now();
  let lastUpdate = 0;
  let busy = false;
  let seenAt = 0;
  let started = false;
  let noHandSince = performance.now();

  const step = async (now) => {
    if (token !== state.prepareToken || state.scene !== 'prepare') return;
    const dt = Math.min(0.2, Math.max(0.01, (now - last) / 1000));
    last = now;
    const updateEvery = IS_TOUCH ? 120 : 72;

    if (vision.ready && !busy && now - lastUpdate > updateEvery) {
      busy = true;
      lastUpdate = now;
      try {
        await vision.update(video, dt);
      } catch (err) {
        console.warn('[prepare] vision', err?.message || err);
      } finally {
        busy = false;
      }
      if (token !== state.prepareToken || state.scene !== 'prepare') return;
      stage.setMask(vision.getMask());
      stage.setFace(vision.getFace());
    }

    if (state.input === 'expression') {
      const cal = vision.getCalibration();
      $('ring-label').textContent = cal.done ? '✓' : String(Math.max(0, Math.ceil(cal.duration - cal.elapsed))).padStart(2, '0');
      $('ring-progress').style.strokeDashoffset = String(590.6 * (1 - cal.progress));
      if (cal.active) {
        setPrepStatus(vision.getFace() ? '正在读取你的中性表情' : '看不见你，再靠近一点');
        if (cal.elapsed > 1.4) addSkipButton();
      } else if (cal.done) {
        setPrepStatus('校准完成 · 星云记住这一刻了');
        stage.setIntensity(0.3);
        if (!started) {
          started = true;
          setTimeout(() => {
            if (token === state.prepareToken && state.scene === 'prepare') startSession();
          }, 520);
        }
      }
    } else {
      const hands = vision.getHands();
      if (hands.length) {
        noHandSince = now;
        if (!seenAt) seenAt = now;
        setPrepStatus('看见手了 · 再保持一下');
        stage.setIntensity(0.35);
        if (now - seenAt > 620 && !started) {
          started = true;
          setTimeout(() => {
            if (token === state.prepareToken && state.scene === 'prepare') startSession();
          }, 180);
        }
      } else {
        const waiting = now - noHandSince > 2600;
        setPrepStatus(waiting ? '还没看见手 · 可以跳过准备' : '把一只手放进画面');
        if (waiting) addSkipButton();
      }
    }

    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function startSession() {
  if (state.scene !== 'prepare') return;
  state.prepareToken++;
  state.demo = state.demo || !vision.ready;
  state.hasSeg = !state.demo && !!vision.getMask() && !state.degraded;

  showScene('session');
  $('mode-wash').classList.remove('is-on');
  $('calibration-toast').classList.add('is-hidden');
  stage.setPreview(false);
  stage.setShowPerson(!state.demo && state.presence === 'self');
  stage.setWindow(state.demo || state.presence !== 'self' ? 0 : state.hasSeg ? 9999 : Math.min(innerWidth, innerHeight) * 0.46);
  stage.setReveal(0.05);
  stage.setPalette('calm', { immediate: true });
  stage.setIntensity(0.1);
  requestAnimationFrame(() => stage.setReveal(1, 1.7));

  state.startedAt = performance.now();
  state.elapsed = 0;
  state.paused = false;
  state.pauseAt = 0;
  state.lastVision = 0;
  state.lastSample = 0;
  state.emotion = 'calm';
  state.intensity = 0.1;
  state.holdKey = null;
  state.holdTime = 0;
  state.hold = 0;
  state.storyKey = 'calm';
  stage.setSustain(0);
  stage.clearStory();
  state.weights = {};
  state.activeTime = 0;
  state.totalTime = 0;
  state.samples = [];
  state.perfChecked = false;
  state.demoEmotion = 'joy';
  state.modeSwitches = 0;
  state.keep = 'none';
  state.shotBlob = null;
  state.endAt = null;

  $('hud-time').textContent = '00:00';
  $('demo-tag').hidden = !state.demo;
  $('feeling-han').textContent = '静';
  $('feeling-poem').textContent = '未起风';
  $('feeling-mode').textContent = state.demo ? '演示' : state.input === 'gesture' ? '手势' : '表情';
  $('intensity-fill').style.width = '8%';
  updateSegUI();

  if (!state.demo) {
    vision.setMode(state.input);
    if (state.input === 'expression' && !vision.getCalibration().done) {
      // a skipped calibration: neutral baseline, no fake sample
      vision.skipCalibration();
    }
    if (state.input === 'gesture') showSessionGestureGuide();
    else hideSessionGestureGuide();
  } else {
    toast('演示模式 · 按 1–5 切换天气', 3200);
  }

  startSessionClock();
}

function startSessionClock() {
  clearInterval(state.sessionTimer);
  state.sessionTimer = setInterval(() => {
    if (state.scene !== 'session' || state.paused) return;
    state.elapsed = (performance.now() - state.startedAt) / 1000;
    $('hud-time').textContent = fmtTime(state.elapsed);
  }, 250);

  cancelAnimationFrame(sessionRaf);
  state.lastVision = 0;
  sessionRaf = requestAnimationFrame(sessionLoop);
}

function showSessionGestureGuide() {
  const el = $('gesture-guide-session');
  el.classList.remove('is-hidden');
  el.setAttribute('aria-hidden', 'false');
  clearTimeout(showSessionGestureGuide._t);
}

function hideSessionGestureGuide() {
  const el = $('gesture-guide-session');
  el.classList.add('is-hidden');
  el.setAttribute('aria-hidden', 'true');
  clearTimeout(showSessionGestureGuide._t);
}

/* ───────────────────────── session ───────────────────────── */

async function sessionLoop(now = performance.now()) {
  if (state.scene !== 'session' || state.paused) return;
  const dt = state.lastVision ? Math.min(0.25, Math.max(0.02, (now - state.lastVision) / 1000)) : 0.08;
  const visionEvery = IS_TOUCH ? 120 : 78;
  const shouldRun = state.demo ? now - state.lastVision > 110 : now - state.lastVision > visionEvery;

  if (shouldRun) {
    state.lastVision = now;
    if (!state.demo && vision.ready) {
      try {
        await vision.update(video, dt);
      } catch (err) {
        console.warn('[session] vision', err?.message || err);
      }
      if (state.scene !== 'session') return;

      stage.setMask(vision.getMask());
      const face = vision.getFace();
      stage.setFace(face ? { x: face.x, y: face.y, r: face.r } : null);

      if (!state.hasSeg && state.presence === 'self' && vision.getMask() && !state.degraded) {
        state.hasSeg = true;
        stage.setWindow(9999);
      }

      if (state.input === 'expression') {
        const cal = vision.getCalibration();
        if (cal.active) {
          applyEmotion('calm', 0.1, dt);
        } else {
          const e = vision.getExpression();
          applyEmotion(e.stable || e.top, e.intensity, dt);
        }
      } else {
        const g = vision.getGesture();
        applyEmotion(g.top, g.intensity, dt);
        highlightHands();
      }
    } else if (state.demo) {
      applyEmotion(state.demoEmotion, 0.66, dt);
    }

    state.elapsed = (performance.now() - state.startedAt) / 1000;
    if (!state.perfChecked && !DEBUG && state.elapsed > 5 && state.presence === 'self' && !state.demo && state.hasSeg) {
      state.perfChecked = true;
      if (stage.fps < 22) degradeToWindow();
    }
  }

  sessionRaf = requestAnimationFrame(sessionLoop);
}

function updateSegUI() {
  document.querySelectorAll('.seg-control button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === state.input);
    b.setAttribute('aria-pressed', b.dataset.mode === state.input ? 'true' : 'false');
  });
  $('feeling-mode').textContent = state.demo ? '演示' : state.input === 'gesture' ? '手势' : '表情';
}

function updateEmotionHold(key, dt) {
  if (key !== 'calm') {
    if (state.holdKey !== key) {
      state.holdKey = key;
      state.holdTime = 0;
      state.hold = 0;
    }
    state.holdTime += Math.max(0, dt);
    state.hold = 1 - Math.exp(-state.holdTime / 5.5);
  } else {
    // release quickly, so the sea settles when the hand comes down
    state.holdTime = Math.max(0, state.holdTime - Math.max(0, dt) * 6);
    state.hold = 1 - Math.exp(-state.holdTime / 5.5);
    if (state.holdTime <= 0.001) {
      state.holdTime = 0;
      state.hold = 0;
      state.holdKey = null;
    }
  }
  stage.setSustain(state.hold);
}

function applyEmotion(key, intensity, dt = 0.08) {
  if (state.scene !== 'session') return;
  if (!EMOTIONS[key]) key = 'calm';
  updateEmotionHold(key, dt);
  const base = key === 'calm' ? Math.max(0.06, intensity * 0.5) : Math.max(0.12, intensity);
  const level = key === 'calm' ? base : Math.min(1, base + state.hold * 0.2);

  if (key !== state.emotion) {
    state.emotion = key;
    stage.setPalette(key, { duration: 1.5 });
    $('feeling-han').textContent = meta(key).han;
    $('feeling-poem').textContent = meta(key).poem;
    if (key !== 'calm') {
      window.dispatchEvent(new CustomEvent('star-wanderer:emotion', {
        detail: { key, name: meta(key).name, mode: state.demo ? 'demo' : state.input },
      }));
    }
    if (key !== state.storyKey) {
      state.storyKey = key;
      stage.setStory(key);
      if (key !== 'calm') {
        window.dispatchEvent(new CustomEvent('star-wanderer:story', {
          detail: { key, name: meta(key).name },
        }));
      }
    }
  }
  state.intensity = level;
  stage.setIntensity(level);
  $('intensity-fill').style.width = `${Math.round(level * 100)}%`;

  if (dt > 0) {
    state.totalTime += dt;
    if (key !== 'calm') {
      state.activeTime += dt;
      state.weights[key] = (state.weights[key] || 0) + dt * (0.45 + 0.55 * level);
    }
    const t = performance.now();
    if (!state.lastSample || t - state.lastSample > 950) {
      state.lastSample = t;
      if (state.samples.length < 240) state.samples.push(Math.round(level * 100) / 100);
    }
  }
}

function highlightHands() {
  const hands = vision.getHands();
  const active = new Set();
  for (const h of hands) {
    if (h.label === 'Thumb_Up') active.add('joy');
    if (h.label === 'Thumb_Down') active.add('anger');
    if (h.label === 'Victory') active.add('delight');
    if (h.label === 'Pointing_Up') active.add('sadness');
    if (h.label === 'Closed_Fist') active.add('anxiety');
  }
  document.querySelectorAll('#gesture-guide-session .gesture-chip').forEach((c) => {
    c.classList.toggle('is-active', active.has(c.dataset.gesture));
  });
}

function degradeToWindow() {
  if (state.degraded) return;
  state.degraded = true;
  state.hasSeg = false;
  vision.setSegment(false);
  stage.setMask(null);
  stage.setWindow(Math.min(innerWidth, innerHeight) * 0.46, true);
  toast('设备有点吃力，改用柔边圆窗', 3600);
}

async function switchMode(next) {
  if (state.demo) {
    if (state.scene === 'session') toast('演示模式 · 按 1–5 切换天气');
    return;
  }
  if (state.switching || state.scene !== 'session' || next === state.input) return;
  state.switching = true;
  state.modeSwitches++;

  $('mode-wash').classList.add('is-on');
  stage.setPalette('calm', { duration: 0.45 });
  stage.setIntensity(0.1);
  stage.setSustain(0);
  state.holdKey = null;
  state.holdTime = 0;
  state.hold = 0;
  state.storyKey = 'calm';
  stage.clearStory();
  stage.setReveal(0.12, 0.55);
  $('calibration-toast').classList.add('is-hidden');

  await new Promise((r) => setTimeout(r, 640));
  if (state.scene !== 'session') { state.switching = false; return; }

  state.input = next;
  updateSegUI();
  vision.setMode(next);
  vision.setSegment(!IS_TOUCH && !state.degraded && (state.presence === 'self' || next === 'gesture'));
  stage.setPalette('calm', { immediate: true });
  stage.setReveal(1, 1.6);
  setTimeout(() => $('mode-wash').classList.remove('is-on'), 500);

  if (next === 'expression') {
    hideSessionGestureGuide();
    vision.startCalibration(2.4);
    $('calibration-toast').classList.remove('is-hidden');
    $('calibration-toast-text').textContent = '重新校准表情 · 请保持中性';
    clearInterval(state.calWatch);
    state.calWatch = setInterval(() => {
      if (state.scene !== 'session') { clearInterval(state.calWatch); return; }
      const cal = vision.getCalibration();
      if (cal.done) {
        clearInterval(state.calWatch);
        $('calibration-toast-text').textContent = '校准完成';
        setTimeout(() => $('calibration-toast').classList.add('is-hidden'), 900);
      }
    }, 200);
    setTimeout(() => {
      if (!vision.getCalibration().done) $('calibration-toast').classList.add('is-hidden');
    }, 9000);
  } else {
    showSessionGestureGuide();
  }

  state.switching = false;
}

/* ───────────────────────── ending ───────────────────────── */

function endSession() {
  if (state.scene !== 'session') return;
  state.scene = 'ending';
  state.prepareToken++;
  clearInterval(state.sessionTimer);
  clearInterval(state.calWatch);
  cancelAnimationFrame(sessionRaf);
  state.endAt = new Date();
  state.hold = 0;
  state.storyKey = 'calm';
  stage.setSustain(0);
  stage.clearStory();
  stage.stop();
  stopCamera();
  $('mode-wash').classList.remove('is-on');
  $('calibration-toast').classList.add('is-hidden');
  hideSessionGestureGuide();
  $('hud').classList.add('is-hidden');
  $('scene-intro').classList.add('is-hidden');
  $('scene-prepare').classList.add('is-hidden');
  app.dataset.scene = 'ending';
  $('end-overlay').classList.remove('is-hidden');
  buildCard();
}

function mainEmotion() {
  let key = 'calm', best = 0;
  for (const k of EMOTION_ORDER) {
    if ((state.weights[k] || 0) > best) { best = state.weights[k]; key = k; }
  }
  if (state.activeTime < 1.2) return 'calm';
  return key;
}

function proportions() {
  const out = {};
  const total = state.activeTime || 0;
  for (const k of EMOTION_ORDER) out[k] = total > 0 ? (state.weights[k] || 0) / total * 100 : 0;
  return out;
}

function curvePath(samples) {
  const pts = samples.length ? samples.slice() : [0.12, 0.12];
  const n = pts.length;
  return pts.map((v, i) => {
    const x = n === 1 ? 0 : (i / (n - 1)) * 480;
    const y = 86 - Math.max(0, Math.min(1, v)) * 66;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function buildCurve(samples) {
  const svg = $('curve');
  const line = curvePath(samples);
  const last = samples.length ? samples[samples.length - 1] : 0.12;
  const lastX = 480;
  const lastY = 86 - Math.max(0, Math.min(1, last)) * 66;
  svg.innerHTML = `
    <path class="grid-line" d="M0 20 H480 M0 52 H480 M0 86 H480"/>
    <path class="area" d="${line} L480 92 L0 92 Z"/>
    <path class="line" d="${line}"/>
    <circle class="last-dot" cx="${lastX}" cy="${lastY}" r="2.6"/>`;
  $('curve-peak').textContent = `峰值 ${Math.round(Math.max(...samples, 0.1) * 100)}%`;
}

function buildSpectrum(props) {
  const spectrum = $('spectrum');
  const legend = $('spectrum-legend');
  spectrum.innerHTML = '';
  legend.innerHTML = '';
  const has = Object.values(props).some((v) => v > 0.2);
  if (!has) {
    const bar = document.createElement('i');
    bar.style.width = '100%';
    bar.style.background = 'rgba(70,62,52,0.18)';
    spectrum.appendChild(bar);
  } else {
    for (const k of EMOTION_ORDER) {
      const p = Math.max(0, props[k] || 0);
      if (p < 0.4) continue;
      const bar = document.createElement('i');
      bar.style.width = `${p}%`;
      bar.style.background = EMOTIONS[k].colors.mid ? `rgb(${EMOTIONS[k].colors.core.join(',')})` : '#999';
      bar.title = `${meta(k).name} ${Math.round(p)}%`;
      spectrum.appendChild(bar);
    }
  }
  for (const k of EMOTION_ORDER) {
    const div = document.createElement('div');
    div.style.setProperty('--dot', `rgb(${EMOTIONS[k].colors.core.join(',')})`);
    const b = document.createElement('b');
    b.textContent = meta(k).han;
    const s = document.createElement('span');
    s.textContent = `${Math.round(props[k] || 0)}%`;
    div.append(b, s);
    legend.appendChild(div);
  }
}

async function buildCard() {
  const short = state.activeTime < 1.2;
  const main = short ? 'calm' : mainEmotion();
  const m = meta(main);
  const props = short ? Object.fromEntries(EMOTION_ORDER.map((k) => [k, 0])) : proportions();
  const end = state.endAt || new Date();
  const duration = Math.max(0, Math.round(state.elapsed));
  let count = 0;
  try { count = (await Archive.list()).length; } catch (_) { count = 0; }

  $('weather-no').textContent = `NO. ${String(count + 1).padStart(4, '0')}`;
  $('weather-meta').textContent = `${fmtClock(end)} · ${fmtTime(duration)} · ${state.demo ? '演示' : '本次漫游'}`;
  $('weather-date').textContent = `${MONTHS[end.getMonth()]} ${String(end.getDate()).padStart(2, '0')}, ${end.getFullYear()} / ${fmtClock(end)}`;
  $('weather-han').textContent = m.han;
  $('weather-poem').textContent = m.poem;
  $('weather-sub').textContent = main === 'calm' && state.activeTime < 1.2
    ? '这一段漫游，星云几乎一直很轻。'
    : m.sub;
  $('fact-duration').textContent = fmtTime(duration);
  $('fact-mode').textContent = modeLabel();
  $('fact-switches').textContent = `${state.modeSwitches} 次`;
  $('weather-foot-mode').textContent = `${modeLabel()}模式 / 画面只在本机计算`;

  buildSpectrum(props);
  $('spectrum-total').textContent = !short && state.activeTime > 0.5
    ? `${Math.round(state.activeTime)} 秒被着色`
    : '几乎都是静默';
  buildCurve(short ? [0.1, 0.1] : state.samples);

  const keepNote = $('keep-note');
  keepNote.hidden = !state.demo;
  document.querySelectorAll('.keep-option').forEach((b) => {
    b.classList.toggle('is-selected', b.dataset.keep === 'none');
    b.setAttribute('aria-checked', b.dataset.keep === 'none' ? 'true' : 'false');
    b.disabled = state.demo && b.dataset.keep === 'record';
  });
  state.keep = 'none';
  $('keep-btn').textContent = '离开';
  $('keep-btn').disabled = false;
  resetShot();
}

function resetShot() {
  if (state.shotUrl) { URL.revokeObjectURL(state.shotUrl); state.shotUrl = null; }
  state.shotBlob = null;
  state.shotBusy = false;
  const shot = $('shot');
  shot.dataset.state = 'locked';
  const img = $('shot-img');
  img.hidden = true;
  img.removeAttribute('src');
}

async function makeShot() {
  if (state.shotBlob || state.shotBusy) return;
  state.shotBusy = true;
  $('keep-btn').disabled = true;
  try {
    const canvas = stage.snapshot();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('empty shot');
    state.shotBlob = blob;
    state.shotUrl = URL.createObjectURL(blob);
    const img = $('shot-img');
    img.src = state.shotUrl;
    img.hidden = false;
    $('shot').dataset.state = 'ready';
  } catch (err) {
    console.warn('[shot]', err);
    toast('截图没有生成，请再试一次');
  } finally {
    state.shotBusy = false;
    $('keep-btn').disabled = false;
  }
}

function pickKeep(value) {
  if (state.demo && value === 'record') {
    toast('演示模式不写情绪记录');
    return;
  }
  state.keep = value;
  document.querySelectorAll('.keep-option').forEach((b) => {
    const on = b.dataset.keep === value;
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if (value === 'none') {
    $('keep-btn').textContent = '离开';
  } else if (value === 'record') {
    $('keep-btn').textContent = '收进档案馆';
  } else {
    $('keep-btn').textContent = state.demo ? '保存这张截图' : '收进档案馆';
    makeShot();
  }
}

function recordPayload(withShot) {
  const short = state.activeTime < 1.2;
  const main = short ? 'calm' : mainEmotion();
  const props = short ? Object.fromEntries(EMOTION_ORDER.map((k) => [k, 0])) : proportions();
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: (state.endAt || new Date()).toISOString(),
    duration: Math.max(0, Math.round(state.elapsed)),
    mode: state.demo ? 'demo' : state.input,
    modeLabel: modeLabel(),
    presence: state.presence,
    main,
    proportions: props,
    curve: state.samples.slice(),
    switches: state.modeSwitches,
    activeTime: Math.round(state.activeTime),
    demo: false,
    shot: withShot ? state.shotBlob : null,
  };
}

async function saveKeep() {
  if (state.shotBusy) return;
  const btn = $('keep-btn');
  btn.disabled = true;
  try {
    if (state.keep === 'none') {
      closeCard();
      return;
    }
    if (state.keep === 'both' && !state.shotBlob) {
      await makeShot();
      if (!state.shotBlob) { btn.disabled = false; return; }
    }
    if (state.keep === 'both' && state.demo) {
      await Archive.add({
        id: crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}`,
        createdAt: (state.endAt || new Date()).toISOString(),
        type: 'shot',
        demo: true,
        mode: 'demo',
        modeLabel: '演示',
        duration: Math.max(0, Math.round(state.elapsed)),
        main: null,
        proportions: {},
        curve: [],
        switches: state.modeSwitches,
        shot: state.shotBlob,
      });
      toast('截图已收进档案馆');
    } else {
      await Archive.add(recordPayload(state.keep === 'both'));
      toast('已收进档案馆');
    }
    closeCard();
  } catch (err) {
    console.error('[archive]', err);
    toast('档案馆暂时写不进去，请稍后再试');
    btn.disabled = false;
  }
}

function closeCard() {
  $('end-overlay').classList.add('is-hidden');
  resetShot();
  state.scene = 'intro';
  state.elapsed = 0;
  showScene('intro');
  stage.setPreview(false);
  stage.setShowPerson(false);
  stage.setWindow(0);
  stage.setPalette('calm', { immediate: true });
  stage.setIntensity(0.1);
  stage.setSustain(0);
  stage.clearStory();
  stage.setReveal(1);
  stage.setFace(null);
  if (!stage.running) stage.start();
  stopCamera();
  state.shotBlob = null;
  updateArchiveHint();
}

/* ───────────────────────── archive ───────────────────────── */

let archiveUrls = [];

async function updateArchiveHint() {
  try {
    const rows = await Archive.list();
    $('archive-count').textContent = `${rows.length} 份记录`;
  } catch (_) { /* noop */ }
}

async function renderArchive() {
  const grid = $('archive-grid');
  const empty = $('archive-empty');
  grid.innerHTML = '';
  archiveUrls.forEach((u) => URL.revokeObjectURL(u));
  archiveUrls = [];
  let rows = [];
  try { rows = await Archive.list(); } catch (err) {
    console.warn('[archive]', err);
    toast('档案馆暂时打不开');
  }

  $('archive-title').textContent = '档案馆';
  $('archive-count').textContent = `${rows.length} 份记录`;
  $('archive-clear').hidden = rows.length === 0;
  empty.hidden = rows.length > 0;

  for (const row of rows) {
    const card = document.createElement('article');
    card.className = 'archive-card';

    const thumb = document.createElement('div');
    thumb.className = 'archive-thumb';
    const main = row.main ? meta(row.main) : null;
    if (main) {
      thumb.style.setProperty('--c1', `rgb(${main.colors.mid.join(',')})`);
      thumb.style.setProperty('--c2', `rgb(${main.colors.deep.join(',')})`);
    }
    if (row.shot) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(row.shot);
      archiveUrls.push(url);
      img.src = url;
      img.alt = main ? `${main.name}的星云截图` : '演示截图';
      thumb.appendChild(img);
    } else {
      const no = document.createElement('span');
      no.className = 'no-shot';
      no.textContent = main ? main.han : '·';
      thumb.appendChild(no);
    }

    const body = document.createElement('div');
    body.className = 'archive-card-body';
    const top = document.createElement('div');
    top.className = 'archive-card-top';
    const b = document.createElement('b');
    b.textContent = main ? main.han : '截图';
    const date = document.createElement('span');
    const d = new Date(row.createdAt);
    date.textContent = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} · ${fmtClock(d)}`;
    top.append(b, date);

    const metaRow = document.createElement('div');
    metaRow.className = 'archive-card-meta';
    const dur = document.createElement('span');
    dur.textContent = fmtTime(row.duration || 0);
    const sep = document.createElement('i');
    sep.textContent = '/';
    const mode = document.createElement('span');
    mode.textContent = row.modeLabel || (row.demo ? '演示' : '表情');
    metaRow.append(dur, sep, mode);

    body.append(top, metaRow);
    if (row.proportions && Object.keys(row.proportions).length) {
      const bar = document.createElement('div');
      bar.className = 'archive-mini-bar';
      for (const k of EMOTION_ORDER) {
        const p = row.proportions[k] || 0;
        if (p < 0.5) continue;
        const i = document.createElement('i');
        i.style.width = `${p}%`;
        i.style.background = `rgb(${EMOTIONS[k].colors.core.join(',')})`;
        bar.appendChild(i);
      }
      body.appendChild(bar);
    }
    const badge = document.createElement('span');
    badge.className = 'archive-badge';
    badge.textContent = row.demo ? '演示截图 · 仅画面' : row.shot ? '情绪记录 + 截图' : '情绪记录';
    body.appendChild(badge);

    card.append(thumb, body);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'archive-del';
    del.setAttribute('aria-label', '删除这份记录');
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('删除这份记录？')) return;
      try {
        await Archive.remove(row.id);
        await renderArchive();
        await updateArchiveHint();
      } catch (err) { toast('删除没有成功'); }
    });
    card.appendChild(del);
    grid.appendChild(card);
  }
}

$('open-archive').addEventListener('click', () => {
  if (state.scene !== 'intro') return;
  $('archive-overlay').classList.remove('is-hidden');
  renderArchive();
});
$('archive-close').addEventListener('click', () => $('archive-overlay').classList.add('is-hidden'));
$('archive-clear').addEventListener('click', async () => {
  if (!confirm('清空档案馆？这会删除所有记录与截图。')) return;
  try {
    await Archive.clear();
    await renderArchive();
    await updateArchiveHint();
  } catch (_) { toast('清空没有成功'); }
});

/* ───────────────────────── events ───────────────────────── */

$('open-colors').addEventListener('click', openColors);
$('colors-close').addEventListener('click', closeColors);
$('colors-done').addEventListener('click', closeColors);
$('colors-overlay').addEventListener('click', (e) => {
  if (e.target === $('colors-overlay')) closeColors();
});
$('colors-reset').addEventListener('click', () => {
  resetEmotionColors();
  refreshColorPanel();
  toast('已恢复默认情绪颜色');
});

$('start-btn').addEventListener('click', begin);
$('prep-back').addEventListener('click', backToIntro);

function backToIntro() {
  if (state.scene !== 'prepare' && state.scene !== 'session') return;
  state.prepareToken++;
  state.busy = false;
  state.paused = false;
  state.pauseAt = 0;
  clearInterval(state.sessionTimer);
  cancelAnimationFrame(sessionRaf);
  stopCamera();
  stage.setPreview(false);
  stage.setShowPerson(false);
  stage.setWindow(0);
  stage.setPalette('calm', { immediate: true });
  stage.setIntensity(0.2);
  stage.setSustain(0);
  stage.clearStory();
  stage.setReveal(1);
  stage.setFace(null);
  showScene('intro');
  if (!stage.running) stage.start();
}

$('end-btn').addEventListener('click', endSession);
$('keep-btn').addEventListener('click', saveKeep);

document.querySelectorAll('.keep-option').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    pickKeep(b.dataset.keep);
  });
});

document.querySelectorAll('.seg-control button').forEach((b) => {
  b.addEventListener('click', () => switchMode(b.dataset.mode));
});

$('pause-end').addEventListener('click', () => {
  $('pause-overlay').classList.add('is-hidden');
  if (state.scene === 'session') endSession();
  else backToIntro();
});

$('resume-btn').addEventListener('click', async () => {
  $('pause-overlay').classList.add('is-hidden');
  state.paused = false;
  if (state.scene === 'session') {
    const ok = await openCamera();
    if (state.scene !== 'session') return;
    if (ok) {
      state.demo = false;
      stage.setVideo(video);
      stage.start();
    } else {
      state.demo = true;
      stage.setMask(null);
      stage.setShowPerson(false);
      stage.setWindow(0);
      stopCamera();
      $('demo-tag').hidden = false;
      toast('镜头没有打开，继续用演示模式');
    }
    if (state.pauseAt) {
      state.startedAt += performance.now() - state.pauseAt;
      state.pauseAt = 0;
    }
    startSessionClock();
  } else {
    backToIntro();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('colors-overlay').classList.contains('is-hidden')) {
      closeColors();
      return;
    }
    if (!$('archive-overlay').classList.contains('is-hidden')) {
      $('archive-overlay').classList.add('is-hidden');
      return;
    }
    if (!$('end-overlay').classList.contains('is-hidden')) {
      closeCard();
      return;
    }
    if (state.scene === 'session') endSession();
    else if (state.scene === 'prepare') backToIntro();
    return;
  }
  if (e.key.toLowerCase() === 'm' && state.scene === 'session' && !state.demo) {
    switchMode(state.input === 'expression' ? 'gesture' : 'expression');
    return;
  }
  if (state.scene === 'session' && state.demo && /^[1-5]$/.test(e.key)) {
    state.demoEmotion = EMOTION_ORDER[Number(e.key) - 1];
    toast(`${meta(state.demoEmotion).han} · 演示`);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state.scene === 'session') {
      state.paused = true;
      state.pauseAt = performance.now();
      clearInterval(state.sessionTimer);
      cancelAnimationFrame(sessionRaf);
      stage.stop();
      stopCamera();
    } else if (state.scene === 'prepare') {
      // leaving during preparation closes the lens and abandons the attempt
      state.prepareToken++;
      state.busy = false;
      stopCamera();
      stage.stop();
      showScene('intro');
      stage.setPreview(false);
      stage.setShowPerson(false);
      stage.setPalette('calm', { immediate: true });
      stage.setSustain(0);
      stage.clearStory();
      stage.setReveal(1);
      stage.setFace(null);
      if (!stage.running) stage.start();
    }
  } else if (state.paused) {
    $('pause-title').textContent = '镜头已关闭';
    $('pause-overlay').classList.remove('is-hidden');
  }
});

window.addEventListener('resize', () => {
  stage.resize();
});

/* first frame */
if (DEBUG) window.__sw = { state, stage, vision };
stage.setPalette('calm', { immediate: true });
stage.setIntensity(0.2);
stage.setReveal(1);
stage.start();
updateArchiveHint();
