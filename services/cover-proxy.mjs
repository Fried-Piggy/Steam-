import { getLegacyCoverCandidates } from '../src/steam.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './local-files.mjs';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_TTL = 60 * 60 * 1000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const IMAGE_HOSTS = new Set([
  'cdn.cloudflare.steamstatic.com', 'shared.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com', 'shared.akamai.steamstatic.com',
  'cdn.fastly.steamstatic.com', 'shared.fastly.steamstatic.com',
]);

function validCoverUrl(value, appId) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.port
      && new RegExp(`^/(?:store_item_assets/)?steam/apps/${appId}/(?:[a-f0-9]+/)?[a-zA-Z0-9_]+\\.(?:jpg|jpeg|png|webp)$`).test(url.pathname);
  } catch { return false; }
}

/** Resolve official artwork by App ID; only allow Steam CDN raster assets for that app. */
export function createCoverProxy(fetchImage = globalThis.fetch, { cacheDirectory = null } = {}) {
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;

  async function readDisk(appId, variant) {
    if (!cacheDirectory) return null;
    for (const [contentType, extension] of Object.entries(IMAGE_EXTENSIONS)) {
      const file = path.join(cacheDirectory, `${appId}-${variant}.${extension}`);
      try {
        const info = await stat(file);
        if (!info.size || info.size > MAX_IMAGE_BYTES) continue;
        const body = await readFile(file);
        if (isRaster(body, contentType)) return { body, contentType };
      } catch { /* Missing or unreadable cached art can be fetched again. */ }
    }
    return null;
  }

  async function saveDisk(appId, variant, image) {
    if (!cacheDirectory) return;
    const file = path.join(cacheDirectory, `${appId}-${variant}.${IMAGE_EXTENSIONS[image.contentType]}`);
    await writeAtomic(file, image.body);
  }

  function isRaster(body, type) {
    if (type === 'image/jpeg') return body[0] === 255 && body[1] === 216 && body[2] === 255;
    if (type === 'image/png') return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
  }

  async function resolveOfficialCover(appId) {
    const response = await fetchImage(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=schinese`, {
      signal: AbortSignal.timeout(12000), redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Steam details unavailable');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Steam details exceed size limit');
      chunks.push(chunk);
    }
    const app = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.[appId];
    if (!app?.success || !validCoverUrl(app.data?.header_image, appId)) {
      throw new Error('No valid official cover');
    }
    return app.data.header_image;
  }

  async function downloadAuto(appId, candidates) {
    // Retry transient metadata failures. Once downloaded, disk reads bypass Steam entirely.
    async function official() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await download(await resolveOfficialCover(appId)); }
        catch (error) { if (attempt === 1) throw error; }
      }
    }
    // Existing games with working fixed URLs need not wait for the store API.
    return Promise.any([official(), ...candidates.map(download)]);
  }

  async function download(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImage(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      });
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !IMAGE_TYPES.has(contentType) || !response.body
        || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new Error('Invalid Steam cover response');
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('Steam cover exceeds size limit');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!size || !isRaster(body, contentType)) throw new Error('Invalid Steam image bytes');
      return { body, contentType };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function getCover(appId, variant = 0) {
    const candidates = getLegacyCoverCandidates(appId);
    if (!candidates.length || (variant !== 'auto' && (!Number.isInteger(variant) || !candidates[variant]))) {
      throw new TypeError('Invalid cover identifier');
    }
    const url = variant === 'auto' ? `auto:${appId}` : candidates[variant];
    const cached = cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached;
    if (pending.has(url)) return pending.get(url);
    const task = (async () => {
      const saved = await readDisk(appId, variant);
      if (saved) return saved;
      const image = await (variant === 'auto' ? downloadAuto(appId, candidates) : download(url));
      try { await saveDisk(appId, variant, image); }
      catch (error) { console.warn(`Cover ${appId} could not be cached: ${error.code ?? error.message}`); }
      return image;
    })().then((image) => {
      if (cache.has(url)) {
        cacheBytes -= cache.get(url).body.length;
        cache.delete(url);
      }
      const value = { ...image, at: Date.now() };
      cache.set(url, value);
      cacheBytes += value.body.length;
      while (cacheBytes > MAX_CACHE_BYTES || cache.size > 64) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).body.length;
        cache.delete(oldest);
      }
      return value;
    }).finally(() => pending.delete(url));
    pending.set(url, task);
    return task;
  }

  const queue = [];
  const queued = new Set();
  const failedAt = new Map();
  let active = 0;
  function drain() {
    while (active < 2 && queue.length) {
      const appId = queue.shift();
      active += 1;
      getCover(appId, 'auto').then(() => failedAt.delete(appId), () => {
        failedAt.set(appId, Date.now());
        if (failedAt.size > 20000) failedAt.delete(failedAt.keys().next().value);
      }).finally(() => { active -= 1; queued.delete(appId); drain(); });
    }
  }
  getCover.prefetch = (appIds) => {
    for (const id of appIds) {
      const appId = String(id);
      if (!/^\d{1,10}$/.test(appId) || queued.has(appId) || queue.length >= 20000
        || Date.now() - (failedAt.get(appId) ?? 0) < 15 * 60 * 1000) continue;
      queued.add(appId);
      queue.push(appId);
    }
    drain();
  };
  // Maintenance tools may seed a verified official URL without a working metadata API.
  getCover.prime = async (appId, url) => {
    if (!/^\d{1,10}$/.test(String(appId)) || !validCoverUrl(url, appId)) throw new TypeError('Invalid cover source');
    const image = await download(url);
    await saveDisk(appId, 'auto', image);
    return image;
  };
  return getCover;
}
