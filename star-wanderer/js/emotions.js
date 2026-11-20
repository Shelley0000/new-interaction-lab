/* Emotion definitions: one feeling, one weather.
   Colors are [r, g, b] so palettes can be mixed continuously. */

export const EMOTION_ORDER = ['joy', 'anger', 'delight', 'sadness', 'anxiety'];

export const EMOTIONS = {
  calm: {
    key: 'calm',
    han: '静',
    name: '静默',
    en: 'STILL',
    poem: '未起风',
    sub: '星云很轻，几乎没有被打扰。',
    colors: {
      deep:   [8, 7, 17],
      mid:    [55, 40, 80],
      core:   [150, 120, 195],
      accent: [210, 186, 244],
      star:   [243, 236, 252],
    },
  },
  joy: {
    key: 'joy',
    han: '喜',
    name: '喜悦',
    en: 'JOY',
    poem: '微光初绽',
    sub: '笑意把星云染成一层薄薄的杏色。',
    colors: {
      deep:   [38, 9, 28],
      mid:    [172, 48, 108],
      core:   [255, 126, 172],
      accent: [255, 216, 228],
      star:   [255, 240, 245],
    },
  },
  anger: {
    key: 'anger',
    han: '怒',
    name: '愤怒',
    en: 'ANGER',
    poem: '潮汐翻涌',
    sub: '有什么在发烫，颜色沉进酒红。',
    colors: {
      deep:   [26, 4, 4],
      mid:    [132, 22, 18],
      core:   [236, 58, 42],
      accent: [255, 126, 86],
      star:   [255, 206, 176],
    },
  },
  delight: {
    key: 'delight',
    han: '乐',
    name: '快乐',
    en: 'DELIGHT',
    poem: '金色迸发',
    sub: '这一刻很响，金色从中心迸开。',
    colors: {
      deep:   [30, 19, 3],
      mid:    [168, 92, 12],
      core:   [255, 184, 42],
      accent: [255, 232, 154],
      star:   [255, 248, 218],
    },
  },
  sadness: {
    key: 'sadness',
    han: '哀',
    name: '悲伤',
    en: 'GRIEF',
    poem: '深海回声',
    sub: '潮水退得很慢，蓝一直往深处走。',
    colors: {
      deep:   [4, 12, 30],
      mid:    [26, 66, 150],
      core:   [62, 154, 255],
      accent: [172, 222, 255],
      star:   [220, 240, 255],
    },
  },
  anxiety: {
    key: 'anxiety',
    han: '焦虑',
    name: '焦虑',
    en: 'ANXIETY',
    poem: '电光游移',
    sub: '光在游移，紫色像没有落点的电流。',
    colors: {
      deep:   [18, 8, 32],
      mid:    [92, 38, 138],
      core:   [178, 86, 255],
      accent: [236, 178, 255],
      star:   [248, 222, 255],
    },
  },
};

export const EMOTION_COLORS = {
  joy: '#ff7eac',
  anger: '#ec3a2a',
  delight: '#ffb82a',
  sadness: '#3e9aff',
  anxiety: '#b256ff',
  calm: '#7d6c9c',
};

const COLOR_PREF_KEY = 'star-wanderer.emotion-colors.v1';
const COLOR_KEYS = ['deep', 'mid', 'core', 'accent', 'star'];

const DEFAULT_PALETTES = Object.fromEntries(
  EMOTION_ORDER.map((k) => [k, Object.fromEntries(COLOR_KEYS.map((c) => [c, EMOTIONS[k].colors[c].slice()]))]),
);

export const DEFAULT_EMOTION_COLORS = Object.fromEntries(
  EMOTION_ORDER.map((k) => [k, rgbToHex(DEFAULT_PALETTES[k].core)]),
);

let colorOverrides = {};

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function rgbToHex(c) {
  return `#${c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s); l = clamp01(l);
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hh = h / 360;
  return [channel(hh + 1 / 3), channel(hh), channel(hh - 1 / 3)].map((v) => Math.round(v * 255));
}

/* One chosen ink becomes a whole weather: a deep night, a dense middle,
   the chosen color itself, a light breath and a near-white star. */
export function paletteFromColor(hex) {
  const base = hexToRgb(hex);
  if (!base) return null;
  const [h, s0, l0] = rgbToHsl(base);
  const s = Math.max(s0, 0.42);
  return {
    deep: hslToRgb(h, Math.min(0.9, s * 0.78), 0.065),
    mid: hslToRgb(h, Math.min(0.94, s * 0.9), clamp(0.28 + l0 * 0.16, 0.29, 0.41)),
    core: base.slice(),
    accent: hslToRgb(h, Math.min(1, s * 0.72 + 0.12), clamp(Math.max(l0, 0.68) + 0.1, 0.7, 0.88)),
    star: hslToRgb(h, Math.min(0.55, s * 0.38), 0.93),
  };
}

function readStoredColors() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLOR_PREF_KEY) || '{}');
    const out = {};
    for (const k of EMOTION_ORDER) {
      if (typeof raw[k] === 'string' && hexToRgb(raw[k])) out[k] = raw[k].toLowerCase();
    }
    return out;
  } catch (_) {
    return {};
  }
}

function writeStoredColors() {
  try {
    if (Object.keys(colorOverrides).length) {
      localStorage.setItem(COLOR_PREF_KEY, JSON.stringify(colorOverrides));
    } else {
      localStorage.removeItem(COLOR_PREF_KEY);
    }
  } catch (_) { /* private mode: keep the colors in memory */ }
}

function applyColors() {
  for (const k of EMOTION_ORDER) {
    const custom = colorOverrides[k] && paletteFromColor(colorOverrides[k]);
    EMOTIONS[k].colors = custom || Object.fromEntries(
      COLOR_KEYS.map((c) => [c, DEFAULT_PALETTES[k][c].slice()]),
    );
  }
}

export function loadEmotionColors() {
  colorOverrides = readStoredColors();
  applyColors();
  return { ...colorOverrides };
}

export function emotionColorHex(key) {
  return rgbToHex(meta(key).colors.core);
}

export function hasCustomEmotionColors() {
  return Object.keys(colorOverrides).length > 0;
}

export function isEmotionColorCustom(key) {
  return !!colorOverrides[key];
}

export function setEmotionColor(key, hex) {
  if (!EMOTION_ORDER.includes(key) || !hexToRgb(hex)) return false;
  const value = hex.toLowerCase();
  if (value === DEFAULT_EMOTION_COLORS[key]) delete colorOverrides[key];
  else colorOverrides[key] = value;
  applyColors();
  writeStoredColors();
  return true;
}

export function resetEmotionColors() {
  colorOverrides = {};
  applyColors();
  writeStoredColors();
}

export const GESTURE_MAP = {
  joy: { icon: 'i-thumb-up', how: '拇指朝上' },
  anger: { icon: 'i-thumb-down', how: '拇指朝下' },
  delight: { icon: 'i-two-fingers', how: '比耶' },
  sadness: { icon: 'i-hand-finger', how: '伸出一只手指' },
  anxiety: { icon: 'i-hand-grab', how: '握拳' },
};

export function meta(key) {
  return EMOTIONS[key] || EMOTIONS.calm;
}

export function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function mixColor(a, b, t) {
  t = clamp(t);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function rgba(c, alpha = 1) {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
}

export function rgb(c) {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

export function mixPalette(a, b, t) {
  const out = {};
  for (const k of COLOR_KEYS) out[k] = mixColor(a[k], b[k], t);
  return out;
}

export function paletteOf(key) {
  const m = meta(key);
  return {
    deep: m.colors.deep.slice(),
    mid: m.colors.mid.slice(),
    core: m.colors.core.slice(),
    accent: m.colors.accent.slice(),
    star: m.colors.star.slice(),
  };
}

export function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
