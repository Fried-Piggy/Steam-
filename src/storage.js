import { normalizeLibrary } from './domain.js';

export const STORAGE_KEY = 'steam_game_library_v4';
const LEGACY_KEYS = Object.freeze([
  { key: 'steam_game_library_v3', legacyFivePoint: false },
  { key: 'steam_game_library_v2', legacyFivePoint: true },
]);

function decodePayload(raw, options = {}) {
  const parsed = JSON.parse(raw);
  const games = Array.isArray(parsed) ? parsed : parsed?.games;
  if (!Array.isArray(games)) throw new TypeError('游戏库数据格式无效');
  return normalizeLibrary(games, options);
}

export function loadLibrary(defaultGames = [], storage = globalThis.localStorage) {
  const current = storage.getItem(STORAGE_KEY);
  if (current) {
    try {
      return { games: decodePayload(current), source: 'storage', warning: '' };
    } catch {
      const backupKey = `${STORAGE_KEY}_corrupt_${Date.now()}`;
      try { storage.setItem(backupKey, current); } catch { /* storage may be full */ }
      return {
        games: normalizeLibrary(defaultGames),
        source: 'defaults',
        warning: `本地数据损坏，原始内容已备份到 ${backupKey}`,
      };
    }
  }

  for (const legacy of LEGACY_KEYS) {
    const raw = storage.getItem(legacy.key);
    if (!raw) continue;
    try {
      const games = decodePayload(raw, { legacyFivePoint: legacy.legacyFivePoint });
      saveLibrary(games, storage);
      return { games, source: legacy.key, warning: '' };
    } catch {
      // Try the next legacy key before falling back to defaults.
    }
  }

  const games = normalizeLibrary(defaultGames);
  saveLibrary(games, storage);
  return { games, source: 'defaults', warning: '' };
}

export function saveLibrary(games, storage = globalThis.localStorage) {
  const payload = {
    version: 3,
    updatedAt: new Date().toISOString(),
    games: normalizeLibrary(games),
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return payload.games;
}

export function parseLibraryBackup(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const games = Array.isArray(parsed) ? parsed : parsed?.games;
  if (!Array.isArray(games)) throw new TypeError('备份文件中没有 games 数组');
  return normalizeLibrary(games);
}

export function createLibraryBackup(games) {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    games: normalizeLibrary(games),
  };
}
