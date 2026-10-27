import test from 'node:test';
import assert from 'node:assert/strict';
import { RARITIES, getTier, tierFromLegacyRating } from '../src/rarity.js';

import {
  extractAppId,
  gameFromSteam,
  getLibraryStats,
  getHonorGames,
  getCardTheme,
  inferGenres,
  normalizeGenres,
  mergeLibraries,
  normalizeGame,
  normalizeLibrary,
  parseVdfAppIds,
  queryLibrary,
  applyManualOrder,
  upsertGameInLibrary,
} from '../src/domain.js';

test('normalizeGame cleans display fields and preserves historical scores without rounding or clamping', () => {
  const game = normalizeGame({ id: '', name: '  Test Game  ', appId: '12345', genre: 'invalid', rating: 18, review: '  Nice  ', addedAt: '123' });
  assert.equal(game.id, 'steam_12345');
  assert.equal(game.name, 'Test Game');
  assert.deepEqual(game.genres, ['其他']);
  assert.equal(game.rating, 18);
  assert.equal(game.tier, 'UR');
  assert.equal(game.review, 'Nice');
  assert.equal(game.addedAt, 123);
});

test('normalizeLibrary removes duplicate IDs and duplicate Steam apps', () => {
  const games = normalizeLibrary([
    { id: 'a', name: 'A', appId: '10' },
    { id: 'b', name: 'Duplicate app', appId: '10' },
    { id: 'a', name: 'Duplicate id' },
    { id: 'c', name: 'C' },
  ], { now: 1 });
  assert.deepEqual(games.map((game) => game.name), ['A', 'C']);
});

test('genres migrate aliases, remove duplicates and invalid labels, and preserve the preferred eligible theme', () => {
  assert.deepEqual(normalizeGenres(['Roguelike', '肉鸽', '音乐/节奏', 'invalid', '其他']), ['肉鸽', '节奏']);
  assert.deepEqual(normalizeGenres([]), ['其他']);
  const game = normalizeGame({ name: 'Mixed', genres: ['解谜', '多人合作', '探索向'], cardTheme: '探索向' });
  assert.equal(game.cardTheme, '探索向');
  assert.equal(getCardTheme(['解谜', '多人合作'], '探索向'), '解谜');
  assert.equal(getCardTheme(['冒险', '独立游戏']), '');
  assert.equal(getCardTheme(['2D类银河恶魔城']), '2D类银河恶魔城');
});

test('every selected genre participates in filtering, search, and unique-type counts', () => {
  const games = normalizeLibrary([
    { id: 'a', name: 'A', genres: ['解谜', '探索向'], rating: 10 },
    { id: 'b', name: 'B', genres: ['多人合作', '探索向'], rating: 9 },
  ]);
  assert.deepEqual(queryLibrary(games, { genre: '探索向' }).map((game) => game.id), ['a', 'b']);
  assert.deepEqual(queryLibrary(games, { search: '多人合作' }).map((game) => game.id), ['b']);
  assert.equal(getLibraryStats(games).genres, 3);
  assert.deepEqual(inferGenres({ genres: [{ description: 'Adventure' }, { description: 'Puzzle' }] }), ['冒险', '解谜']);
});

test('legacy five-point scale affects tier conversion only, never the archived score', () => {
  const legacy = normalizeGame({ name: 'A', rating: 4 }, { legacyFivePoint: true });
  assert.equal(legacy.rating, 4);
  assert.equal(legacy.tier, 'SR');
  assert.equal(normalizeGame({ name: 'A', rating: 4 }).tier, 'C');
});

test('extractAppId accepts IDs and Steam store URLs', () => {
  assert.equal(extractAppId('753640'), '753640');
  assert.equal(extractAppId('https://store.steampowered.com/app/753640/Outer_Wilds/'), '753640');
  assert.equal(extractAppId('https://example.com/app/753640'), null);
});

test('parseVdfAppIds reads IDs only from Apps blocks or appid fields', () => {
  const vdf = `
    "UserLocalConfigStore" {
      "friends" { "76561198000000000" { "name" "not an app" } }
      "Software" { "Valve" { "Steam" { "Apps" {
        "753640" { "LastPlayed" "123" }
        "2200650" { "LastPlayed" "456" }
      } } } }
    }
  `;
  assert.deepEqual(parseVdfAppIds(vdf), ['753640', '2200650']);
});

test('queryLibrary searches reviews and applies deterministic sorting', () => {
  const games = normalizeLibrary([
    { id: 'a', name: 'Zulu', genre: '冒险', rating: 8, review: '宇宙', addedAt: 1 },
    { id: 'b', name: 'Alpha', genre: '解谜', rating: 9, review: '语言', addedAt: 2 },
  ]);
  assert.deepEqual(queryLibrary(games, { search: '宇宙' }).map((game) => game.id), ['a']);
  assert.deepEqual(queryLibrary(games, { sort: 'tier-desc' }).map((game) => game.id), ['b', 'a']);
});

test('mergeLibraries reports additions and skips duplicate App IDs', () => {
  const current = [{ id: 'steam_10', name: 'A', appId: '10' }];
  const merged = mergeLibraries(current, [
    { id: 'other', name: 'Duplicate', appId: '10' },
    { id: 'steam_20', name: 'B', appId: '20' },
  ]);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.skippedCount, 1);
  assert.equal(merged.games.length, 2);
});

test('gameFromSteam converts playtime minutes to a readable review', () => {
  const game = gameFromSteam({ appid: 10, name: 'Counter-Strike', playtime_forever: 125 }, 1000);
  assert.equal(game.appId, '10');
  assert.equal(game.review, 'Steam 游玩时长：2 小时');
  assert.equal(game.addedAt, 1000);
});

test('getLibraryStats counts chosen tiers and UR games without computing a numeric average', () => {
  const games = normalizeLibrary([
    { name: 'A', rating: 10, genre: '解谜' },
    { name: 'B', rating: 0, genre: '冒险' },
    { name: 'C', rating: 8, genre: '解谜' },
  ]);
  assert.deepEqual(getLibraryStats(games), { total: 3, genres: 2, rated: 2, ur: 1, unresolved: 0 });
});

test('legacy scores map at every tier boundary; new games do not acquire numeric scores', () => {
  for (const [rating, tier] of [[0, ''], [0.1, 'F'], [3.9, 'F'], [4, 'C'], [5.9, 'C'],
    [6, 'N'], [6.9, 'N'], [7, 'R'], [7.9, 'R'], [8, 'SR'], [8.9, 'SR'], [9, 'SSR'],
    [9.4, 'SSR'], [9.5, 'UR'], [10, 'UR']]) assert.equal(tierFromLegacyRating(rating), tier);
  for (const tier of [...Object.keys(RARITIES), '']) {
    const game = normalizeGame({ name: 'New', tier });
    assert.equal(game.tier, tier);
    assert.equal(Object.hasOwn(game, 'rating'), false);
  }
  assert.equal(Object.hasOwn(gameFromSteam({ appid: 10, name: 'Imported' }), 'rating'), false);
});

test('explicit tiers and clearing a tier override archived scores through normalization', () => {
  const old = normalizeGame({ name: 'Old', rating: 9.75 });
  const edited = normalizeGame({ ...old, tier: 'F', review: 'Changed opinion' });
  assert.equal(edited.rating, 9.75);
  assert.equal(getTier(edited), 'F');
  const cleared = normalizeGame({ ...old, tier: '' });
  assert.equal(normalizeGame(cleared).tier, '');
  assert.equal(cleared.rating, 9.75);
  assert.equal(getHonorGames([cleared]).length, 0);
});

test('ranking uses tiers alone; equal tiers use names and unset games remain at the end', () => {
  const games = normalizeLibrary([
    { id: 'a', name: 'Alpha', tier: 'SR', rating: 1 },
    { id: 'z', name: 'Zulu', tier: 'SR', rating: 10 },
    { id: 'top', name: 'Top', tier: 'UR' },
    { id: 'low', name: 'Low', tier: 'F', rating: 10 },
    { id: 'unset', name: 'Unset', tier: '', rating: 10 },
  ]);
  assert.deepEqual(queryLibrary(games).map((g) => g.id), ['top', 'a', 'z', 'low', 'unset']);
  assert.deepEqual(queryLibrary(games, { sort: 'tier-asc' }).map((g) => g.id), ['low', 'a', 'z', 'top', 'unset']);
  assert.deepEqual(getHonorGames(games).map((g) => g.id), ['top', 'a', 'z']);
  assert.deepEqual(queryLibrary(games, { search: 'sr' }).map((g) => g.id), ['a', 'z']);
  assert.deepEqual(queryLibrary(games, { search: '人生级作品' }).map((g) => g.id), ['top']);
});

test('podium uses rated games only, ranks ties deterministically, and does not mutate the library', () => {
  const games = normalizeLibrary([
    { id: 'unrated', name: 'Unrated', rating: 0 },
    { id: 'z', name: 'Zulu', rating: 10 },
    { id: 'b', name: 'Alpha', rating: 10 },
    { id: 'a', name: 'Alpha', rating: 10 },
    { id: 'runner-up', name: 'Runner up', rating: 9 },
  ]);
  const before = structuredClone(games);
  assert.deepEqual(getHonorGames(games).map((game) => game.id), ['a', 'b', 'z']);
  assert.deepEqual(getHonorGames([...games].reverse()).map((game) => game.id), ['a', 'b', 'z']);
  assert.deepEqual(games, before);
  const honors = new Set(getHonorGames(games).map((game) => game.id));
  assert.deepEqual(games.filter((game) => !honors.has(game.id)).map((game) => game.id), ['unrated', 'runner-up']);
});

test('podium remains meaningful for empty libraries and fewer than three rated games', () => {
  assert.deepEqual(getHonorGames([]), []);
  const games = normalizeLibrary([{ id: 'unrated', name: 'A', rating: 0 }, { id: 'rated', name: 'B', rating: 7 }]);
  assert.deepEqual(getHonorGames(games).map((game) => game.id), ['rated']);
  assert.deepEqual(getHonorGames(games.slice(0, 1)), []);
});

test('manual ordering covers every tier and controls the podium without modifying archived fields', () => {
  const games = normalizeLibrary([
    { id: 'a', name: 'Alpha', tier: 'UR', rating: 9.75 },
    { id: 'b', name: 'Beta', tier: 'F', rating: 1 },
    { id: 'c', name: 'Charlie', tier: '' },
    { id: 'd', name: 'Delta', tier: 'SSR' },
  ]);
  const before = structuredClone(games);
  const ordered = normalizeLibrary(applyManualOrder(games, ['b', 'c', 'd', 'a']));
  assert.deepEqual(queryLibrary(ordered).map((g) => g.id), ['b', 'c', 'd', 'a']);
  assert.deepEqual(getHonorGames(ordered).map((g) => g.id), ['b', 'c', 'd']);
  assert.deepEqual(queryLibrary(ordered, { sort: 'tier-desc' }).map((g) => g.id), ['a', 'd', 'b', 'c']);
  assert.equal(ordered.find((g) => g.id === 'a').rating, 9.75);
  assert.equal(ordered.find((g) => g.id === 'b').tier, 'F');
  assert.deepEqual(games, before);
});

test('saving an order draft keeps new/current records and ignores deleted or repeated IDs', () => {
  const current = normalizeLibrary([
    { id: 'a', name: 'Edited name', tier: 'UR', review: 'Updated review' },
    { id: 'b', name: 'B', tier: 'R' },
    { id: 'new', name: 'New', tier: 'UR' },
  ]);
  const saved = applyManualOrder(current, ['deleted', 'b', 'b', 'a']);
  assert.deepEqual(queryLibrary(saved).map((g) => g.id), ['b', 'a', 'new']);
  assert.equal(saved.find((g) => g.id === 'a').review, 'Updated review');
  const merged = mergeLibraries(saved, [{ id: 'imported', name: 'Import', tier: 'UR', manualOrder: 0 }]);
  assert.deepEqual(queryLibrary(merged.games).map((g) => g.id), ['b', 'a', 'new', 'imported']);
});

test('tier edits move to the new tier tail while retaining every other manual relationship and old scores', () => {
  const games = applyManualOrder(normalizeLibrary([
    { id: 'ur', name: 'UR', tier: 'UR' },
    { id: 'n2', name: 'N2', tier: 'N' },
    { id: 'n1', name: 'N1', tier: 'N' },
    { id: 'c', name: 'C', tier: 'C' },
    { id: 'f', name: 'F', tier: 'F', rating: 3.2 },
    { id: 'unset', name: 'Unset', tier: '' },
  ]), ['ur', 'n2', 'n1', 'c', 'f', 'unset']);
  const before = structuredClone(games);
  const upgraded = upsertGameInLibrary(games, { ...games.find((g) => g.id === 'f'), tier: 'N' });
  assert.deepEqual(queryLibrary(upgraded).map((g) => g.id), ['ur', 'n2', 'n1', 'f', 'c', 'unset']);
  assert.equal(upgraded.find((g) => g.id === 'f').rating, 3.2);
  const lowered = upsertGameInLibrary(games, { ...games.find((g) => g.id === 'n2'), tier: 'F' });
  assert.deepEqual(queryLibrary(lowered).map((g) => g.id), ['ur', 'n1', 'c', 'f', 'n2', 'unset']);
  const cleared = upsertGameInLibrary(games, { ...games.find((g) => g.id === 'ur'), tier: '' });
  assert.deepEqual(queryLibrary(cleared).map((g) => g.id), ['n2', 'n1', 'c', 'f', 'unset', 'ur']);
  assert.deepEqual(games, before);
});

test('tier edits without peers insert before lower tiers; ordinary edits do not reset custom placements', () => {
  const games = applyManualOrder(normalizeLibrary([
    { id: 'ur', name: 'UR', tier: 'UR' },
    { id: 'n', name: 'N', tier: 'N' },
    { id: 'f', name: 'F', tier: 'F' },
  ]), ['ur', 'n', 'f']);
  const changed = upsertGameInLibrary(games, { ...games[2], tier: 'SR' });
  assert.deepEqual(queryLibrary(changed).map((g) => g.id), ['ur', 'f', 'n']);
  assert.deepEqual(getHonorGames(changed).map((g) => g.id), ['ur', 'f', 'n']);
  const custom = applyManualOrder(games, ['f', 'ur', 'n']);
  const edited = upsertGameInLibrary(custom, { ...custom[2], name: 'Edited', review: 'New review' });
  assert.deepEqual(queryLibrary(edited).map((g) => g.id), ['f', 'ur', 'n']);
  const added = upsertGameInLibrary(games, normalizeGame({ id: 'new', name: 'New', tier: 'SSR' }));
  assert.deepEqual(queryLibrary(added).map((g) => g.id), ['ur', 'new', 'n', 'f']);
});
