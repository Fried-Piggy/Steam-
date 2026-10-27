const SILVER = Object.freeze({
  primary: Object.freeze([174, 185, 198]),
  secondary: Object.freeze([219, 225, 232]),
  highlight: Object.freeze([243, 246, 250]),
});
const CACHE_KEY = 'steam_cover_palettes_v1';
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 128;
const palettes = new Map();
const pending = new Map();
const failures = new Map();
const activeCards = new WeakMap();
let cacheLoaded = false;
let samplingCount = 0;
const samplingQueue = [];

function toHsl([red, green, blue]) {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (!delta) return [0, 0, lightness];
  let hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return [hue, delta / (1 - Math.abs(2 * lightness - 1)), lightness];
}

function fromHsl([hue, saturation, lightness]) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const sectors = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  return sectors[Math.floor(hue / 60) % 6].map((channel) => Math.round((channel + offset) * 255));
}

function metallicColor(rgb, lighter = false) {
  const [hue, saturation, lightness] = toHsl(rgb);
  return fromHsl([hue, Math.min(.88, Math.max(.45, saturation)),
    Math.min(.73, Math.max(lighter ? .66 : .51, lightness))]);
}

/** Pure RGBA sampler: prominent chromatic hues beat black/white backgrounds. */
export function extractCoverPalette(pixels) {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, channels: [0, 0, 0] }));
  let visible = 0;
  let chromatic = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < 128) continue;
    visible += 1;
    const rgb = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const [hue, saturation, lightness] = toHsl(rgb);
    if (saturation < .18 || lightness < .09 || lightness > .92) continue;
    chromatic += 1;
    const weight = (.4 + saturation * .6) * (1 - Math.abs(lightness - .5) * .5);
    const bin = bins[Math.round(hue / 15) % bins.length];
    bin.weight += weight;
    rgb.forEach((channel, i) => { bin.channels[i] += channel * weight; });
  }
  if (!visible || chromatic / visible < .035) return SILVER;
  const colors = bins.filter((bin) => bin.weight > 0).sort((a, b) => b.weight - a.weight)
    .map((bin) => ({ weight: bin.weight, rgb: bin.channels.map((value) => value / bin.weight) }));
  const primaryHue = toHsl(colors[0].rgb)[0];
  const secondary = colors.slice(1).find((color) => {
    const difference = Math.abs(toHsl(color.rgb)[0] - primaryHue);
    return Math.min(difference, 360 - difference) >= 35 && color.weight >= colors[0].weight * .12;
  });
  const primary = metallicColor(colors[0].rgb);
  const accent = metallicColor(secondary?.rgb ?? colors[0].rgb, !secondary);
  const highlight = primary.map((channel, i) => Math.round(((channel + accent[i]) / 2) * .38 + 255 * .62));
  return { primary, secondary: accent, highlight };
}

function validPalette(palette) {
  return ['primary', 'secondary', 'highlight'].every((key) =>
    Array.isArray(palette?.[key]) && palette[key].length === 3
    && palette[key].every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const entries = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
    if (!Array.isArray(entries)) return;
    for (const [key, value] of entries.slice(-CACHE_LIMIT)) {
      if (/^\d{1,10}:(?:auto|[0-3])$/.test(key) && validPalette(value?.palette)
        && Number.isFinite(value.at) && Date.now() - value.at < CACHE_TTL) palettes.set(key, value);
    }
  } catch { /* Storage is optional; sampling still works in memory. */ }
}

function saveCache(key, palette) {
  palettes.delete(key);
  palettes.set(key, { at: Date.now(), palette });
  while (palettes.size > CACHE_LIMIT) palettes.delete(palettes.keys().next().value);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify([...palettes])); } catch { /* Quota/private mode. */ }
}

function runNextSample() {
  if (samplingCount >= 3 || !samplingQueue.length) return;
  samplingCount += 1;
  const { task, resolve, reject } = samplingQueue.shift();
  Promise.resolve().then(task).then(resolve, reject).finally(() => {
    samplingCount -= 1;
    runNextSample();
  });
}

function sampleCover(appId, variant) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    const finish = (error, palette) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      if (error) reject(error);
      else resolve(palette);
    };
    const timeout = setTimeout(() => finish(new Error('Cover sampling timed out')), 14000);
    image.onerror = () => finish(new Error('Cover is unavailable for sampling'));
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas unavailable');
        context.drawImage(image, 0, 0, 48, 48);
        finish(null, extractCoverPalette(context.getImageData(0, 0, 48, 48).data));
      } catch (error) { finish(error); }
    };
    // Public static hosting samples the committed cover; local mode uses the live cover proxy.
    const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
    image.src = isLocal
      ? `/api/steam/covers/${appId}?variant=${variant}`
      : `./assets/covers/${appId}-auto.jpg`;
  });
}

async function getPalette(appId, variant) {
  loadCache();
  const key = `${appId}:${variant}`;
  const cached = palettes.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.palette;
  if (pending.has(key)) return pending.get(key);
  if (Date.now() - (failures.get(key) ?? 0) < 30000) return null;
  const promise = new Promise((resolve, reject) => {
    samplingQueue.push({ task: () => sampleCover(appId, variant), resolve, reject });
    runNextSample();
  }).then((palette) => {
    saveCache(key, palette);
    failures.delete(key);
    return palette;
  }).catch(() => {
    failures.set(key, Date.now());
    if (failures.size > CACHE_LIMIT) failures.delete(failures.keys().next().value);
    return null;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function applyCoverPalette(card, appId, variant = 0) {
  if (!/^\d{1,10}$/.test(String(appId))
    || (variant !== 'auto' && (!Number.isInteger(variant) || variant < 0 || variant > 3))) return;
  const key = `${appId}:${variant}`;
  activeCards.set(card, key);
  const palette = await getPalette(appId, variant);
  // A late response must not tint a detached or replaced card.
  if (!palette || !card.isConnected || activeCards.get(card) !== key) return;
  for (const name of ['primary', 'secondary', 'highlight']) {
    card.style.setProperty(`--foil-${name}`, `rgb(${palette[name].join(', ')})`);
  }
  card.style.setProperty('--foil-glow', palette.highlight.join(' '));
  card.dataset.foilSource = 'cover';
}
