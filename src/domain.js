import { RARITIES, compareTiers, getTier, tierFromLegacyRating } from './rarity.js';

export const GENRES = Object.freeze([
  '动作', '冒险', '角色扮演', '策略', '模拟', '射击', '竞速', '体育', '格斗',
  '恐怖', '解谜', '生存', '开放世界', '潜行', '肉鸽', '类魂',
  '独立游戏', '视觉小说', '节奏', '大型多人在线', 'MOBA', '即时战略',
  '多人合作', '探索向', '2D类银河恶魔城',
  '塔防', '卡牌', '悬疑', '科幻', '奇幻', '武侠', '恋爱模拟', '休闲', '其他',
]);

export const SORTS = Object.freeze(['manual', 'recent', 'tier-desc', 'tier-asc', 'name']);

export const CARD_THEMES = Object.freeze({
  '解谜': 'puzzle',
  '节奏': 'rhythm',
  '多人合作': 'coop',
  '探索向': 'exploration',
  '肉鸽': 'roguelike',
  '2D类银河恶魔城': 'metroidvania',
  '视觉小说': 'visual-novel',
});

const GENRE_ALIASES = Object.freeze({ Roguelike: '肉鸽', '音乐/节奏': '节奏' });

export function normalizeGenres(value) {
  const values = Array.isArray(value) ? value : [value];
  const genres = [...new Set(values.map((item) => {
    const text = cleanText(item, 40);
    return Object.hasOwn(GENRE_ALIASES, text) ? GENRE_ALIASES[text] : text;
  }).filter((item) => GENRES.includes(item)))];
  return genres.length > 1 ? genres.filter((genre) => genre !== '其他') : genres.length ? genres : ['其他'];
}

export function getCardTheme(genres, preferred = '') {
  const choices = normalizeGenres(genres).filter((genre) => Object.hasOwn(CARD_THEMES, genre));
  return choices.includes(preferred) ? preferred : choices[0] ?? '';
}

const PLACEHOLDER_PREFIX = 'Game ';

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanAppId(value) {
  const appId = cleanText(value, 10);
  return /^\d{1,10}$/.test(appId) ? appId : '';
}

function cleanTimestamp(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function makeGameId(appId = '') {
  if (appId) return `steam_${appId}`;
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeGame(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const appId = cleanAppId(raw.appId ?? raw.appid);
  const fallbackName = appId ? `${PLACEHOLDER_PREFIX}${appId}` : '';
  const name = cleanText(raw.name, 120) || fallbackName;
  if (!name) return null;

  const genres = normalizeGenres(raw.genres ?? raw.genre);
  // Historical scores are archive data only: never round, rescale or overwrite them.
  const archivedRating = Object.hasOwn(raw, 'rating') && Number.isFinite(Number(raw.rating))
    ? { rating: raw.rating } : {};
  const oldRating = Number(archivedRating.rating);
  const conversionRating = options.legacyFivePoint && oldRating <= 5 ? oldRating * 2 : oldRating;
  const tier = raw.tier === '' || Object.hasOwn(RARITIES, raw.tier)
    ? raw.tier : tierFromLegacyRating(conversionRating);
  return {
    id: cleanText(raw.id, 120) || makeGameId(appId),
    name,
    appId,
    genres,
    cardTheme: getCardTheme(genres, raw.cardTheme),
    ...archivedRating,
    tier,
    ...(Number.isSafeInteger(raw.manualOrder) && raw.manualOrder >= 0 ? { manualOrder: raw.manualOrder } : {}),
    review: cleanText(raw.review, 600),
    addedAt: cleanTimestamp(raw.addedAt, options.now ?? Date.now()),
  };
}

export function normalizeLibrary(input, options = {}) {
  if (!Array.isArray(input)) return [];

  const result = [];
  const ids = new Set();
  const appIds = new Set();

  for (const raw of input) {
    const game = normalizeGame(raw, options);
    if (!game || ids.has(game.id) || (game.appId && appIds.has(game.appId))) continue;
    ids.add(game.id);
    if (game.appId) appIds.add(game.appId);
    result.push(game);
  }
  return result;
}

export function mergeLibraries(current, incoming) {
  const games = normalizeLibrary(current);
  const ids = new Set(games.map((game) => game.id));
  const appIds = new Set(games.map((game) => game.appId).filter(Boolean));
  let addedCount = 0;
  let skippedCount = 0;
  const ordered = games.filter(hasManualOrder);
  let nextOrder = ordered.reduce((max, game) => Math.max(max, game.manualOrder + 1), 0);

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const game = normalizeGame(raw);
    if (!game || ids.has(game.id) || (game.appId && appIds.has(game.appId))) {
      skippedCount += 1;
      continue;
    }
    if (ordered.length) game.manualOrder = nextOrder++;
    games.push(game);
    ids.add(game.id);
    if (game.appId) appIds.add(game.appId);
    addedCount += 1;
  }

  return { games, addedCount, skippedCount };
}

export function isPlaceholderGame(game) {
  return Boolean(game?.appId && game.name === `${PLACEHOLDER_PREFIX}${game.appId}`);
}

function hasManualOrder(game) {
  return Number.isSafeInteger(game.manualOrder) && game.manualOrder >= 0;
}

function compareManualOrder(a, b) {
  if (hasManualOrder(a) && hasManualOrder(b)) return a.manualOrder - b.manualOrder;
  if (hasManualOrder(a) !== hasManualOrder(b)) return hasManualOrder(a) ? -1 : 1;
  return 0;
}

/** Apply a draft's ID order to current records, preserving edits and newly added games. */
export function applyManualOrder(games, orderedIds) {
  const remaining = new Map(queryLibrary(games, { sort: 'manual' }).map((game) => [game.id, game]));
  const order = new Map();
  for (const id of orderedIds) {
    if (!remaining.has(id)) continue;
    order.set(id, order.size);
    remaining.delete(id);
  }
  for (const id of remaining.keys()) order.set(id, order.size);
  return games.map((game) => ({ ...game, manualOrder: order.get(game.id) }));
}

/** Editing a tier relocates only that game; every other manual relationship stays intact. */
export function upsertGameInLibrary(games, game) {
  const previous = games.find((item) => item.id === game.id);
  const updated = previous ? games.map((item) => item.id === game.id ? game : item) : [...games, game];
  if (!games.some(hasManualOrder) || (previous && getTier(previous) === getTier(game))) return updated;

  const ordered = queryLibrary(updated, { sort: 'manual' }).filter((item) => item.id !== game.id);
  const tier = getTier(game);
  const lastPeer = ordered.findLastIndex((item) => getTier(item) === tier);
  let insertion = lastPeer + 1;
  if (lastPeer < 0) {
    insertion = ordered.findIndex((item) => compareTiers(game, item) < 0);
    if (insertion < 0) insertion = ordered.length;
  }
  const ids = ordered.map((item) => item.id);
  ids.splice(insertion, 0, game.id);
  return applyManualOrder(updated, ids);
}

export function queryLibrary(games, options = {}) {
  const search = cleanText(options.search, 120).toLocaleLowerCase('zh-CN');
  const genre = cleanText(options.genre, 40);
  const sort = SORTS.includes(options.sort) ? options.sort : 'manual';

  const result = games.filter((game) => {
    const genres = normalizeGenres(game.genres ?? game.genre);
    if (genre && !genres.includes(GENRE_ALIASES[genre] ?? genre)) return false;
    if (!search) return true;
    if (Object.hasOwn(RARITIES, search.toUpperCase())) return getTier(game) === search.toUpperCase();
    return [game.name, ...genres, game.review, RARITIES[getTier(game)]?.name ?? '']
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(search));
  });

  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
  result.sort((a, b) => {
    if (sort === 'manual') return compareManualOrder(a, b) || compareTiers(a, b) || byName(a, b) || a.id.localeCompare(b.id);
    if (sort === 'recent') return b.addedAt - a.addedAt || byName(a, b);
    if (sort === 'tier-asc') {
      if (!getTier(a) !== !getTier(b)) return getTier(a) ? -1 : 1;
      return compareTiers(b, a) || byName(a, b) || a.id.localeCompare(b.id);
    }
    if (sort === 'name') return byName(a, b);
    return compareTiers(a, b) || byName(a, b) || a.id.localeCompare(b.id);
  });
  return result;
}

export function getLibraryStats(games) {
  const rated = games.filter((game) => getTier(game));
  return {
    total: games.length,
    genres: new Set(games.flatMap((game) => normalizeGenres(game.genres ?? game.genre))).size,
    rated: rated.length,
    ur: rated.filter((game) => getTier(game) === 'UR').length,
    unresolved: games.filter(isPlaceholderGame).length,
  };
}

/** A saved manual order controls the podium; otherwise retain the tier-based default. */
export function getHonorGames(games) {
  if (games.some(hasManualOrder)) return queryLibrary(games, { sort: 'manual' }).slice(0, 3);
  return games.filter((game) => getTier(game)).sort((a, b) =>
    compareTiers(a, b)
    || a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' })
    || a.id.localeCompare(b.id),
  ).slice(0, 3);
}

export function extractAppId(input) {
  const value = cleanText(input, 500);
  if (/^\d{1,10}$/.test(value)) return value;
  const match = value.match(/(?:store\.)?steampowered\.com\/app\/(\d{1,10})(?:[/?#]|$)/i)
    ?? value.match(/steamcommunity\.com\/app\/(\d{1,10})(?:[/?#]|$)/i);
  return match?.[1] ?? null;
}

function tokenizeVdf(text) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|([{}])/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[2] ?? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return tokens;
}

function parseVdfTokens(tokens) {
  let index = 0;

  function parseBlock(stopAtBrace = false) {
    const result = {};
    while (index < tokens.length) {
      const key = tokens[index++];
      if (key === '}') return result;
      if (key === '{') continue;

      const value = tokens[index++];
      if (value === '{') result[key] = parseBlock(true);
      else if (value !== undefined && value !== '}') result[key] = value;
      else if (value === '}' && stopAtBrace) return result;
    }
    return result;
  }

  return parseBlock();
}

export function parseVdfAppIds(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const root = parseVdfTokens(tokenizeVdf(text));
  const appIds = new Set();

  function walk(value, key = '') {
    if (!value || typeof value !== 'object') return;
    if (key.toLocaleLowerCase() === 'apps') {
      for (const childKey of Object.keys(value)) {
        if (/^\d{1,10}$/.test(childKey) && Number(childKey) >= 10) appIds.add(childKey);
      }
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/^appid$/i.test(childKey) && /^\d{1,10}$/.test(String(childValue))) {
        appIds.add(String(childValue));
      }
      walk(childValue, childKey);
    }
  }
  walk(root);

  if (appIds.size === 0) {
    const appIdPattern = /"(?:appid|AppID)"\s+"(\d{1,10})"/g;
    let match;
    while ((match = appIdPattern.exec(text)) !== null) appIds.add(match[1]);
  }

  return [...appIds].sort((a, b) => Number(a) - Number(b));
}

export function gameFromSteam(raw, now = Date.now()) {
  const appId = cleanAppId(raw?.appid ?? raw?.appId);
  if (!appId) return null;
  const minutes = Math.max(0, Number(raw.playtime_forever) || 0);
  const hours = Math.round(minutes / 60);
  return normalizeGame({
    id: `steam_${appId}`,
    appId,
    name: raw.name || `${PLACEHOLDER_PREFIX}${appId}`,
    genre: '其他',
    tier: '',
    review: hours ? `Steam 游玩时长：${hours} 小时` : '',
    addedAt: now,
  }, { now });
}

const STEAM_GENRE_MAP = Object.freeze({
  Action: '动作', Adventure: '冒险', RPG: '角色扮演', Strategy: '策略',
  Simulation: '模拟', Racing: '竞速', Sports: '体育', Fighting: '格斗',
  Horror: '恐怖', Puzzle: '解谜', Survival: '生存', 'Open World': '开放世界',
  Stealth: '潜行', Roguelike: 'Roguelike', Indie: '独立游戏',
  'Visual Novel': '视觉小说', MMO: '大型多人在线', MOBA: 'MOBA',
  RTS: '即时战略', 'Tower Defense': '塔防', 'Card Game': '卡牌',
  'Sci-fi': '科幻', Fantasy: '奇幻', Casual: '休闲',
});

export function inferGenres(details) {
  return normalizeGenres((details?.genres ?? []).map((genre) => STEAM_GENRE_MAP[genre.description]).filter(Boolean));
}
