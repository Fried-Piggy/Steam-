import { getCoverAsset } from './cover-assets.js';

const COVER_HOSTS = Object.freeze([
  'https://cdn.cloudflare.steamstatic.com/steam/apps',
  'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps',
  'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps',
  'https://cdn.akamai.steamstatic.com/steam/apps',
]);

export function getLegacyCoverCandidates(appId) {
  const id = String(appId ?? '').trim();
  if (!/^\d{1,10}$/.test(id)) return [];
  return COVER_HOSTS.map((host) => `${host}/${id}/header.jpg`);
}

export function getCoverCandidates(appId) {
  const legacy = getLegacyCoverCandidates(appId);
  if (!legacy.length) return [];
  const id = String(appId).trim();
  const hostname = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname;
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  const asset = getCoverAsset(id);
  return [isLocal ? `/api/steam/covers/${id}?variant=auto`
    : asset ? `./assets/covers/${asset.large}` : `./assets/covers/${id}-auto.jpg`, ...legacy];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error || `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload;
}

export async function searchSteam(query, signal) {
  const value = String(query ?? '').trim();
  if (value.length < 2) return [];
  const payload = await requestJson(`/api/steam/search?q=${encodeURIComponent(value)}`, { signal });
  return Array.isArray(payload.results) ? payload.results : [];
}

export async function getSteamAppDetails(appId, signal) {
  const payload = await requestJson(`/api/steam/apps/${encodeURIComponent(appId)}`, { signal });
  return payload.app ?? null;
}

export async function getOwnedSteamGames(apiKey, steamId, signal) {
  const payload = await requestJson('/api/steam/library', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, steamId }),
  });
  return Array.isArray(payload.games) ? payload.games : [];
}
