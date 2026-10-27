import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEY, createLibraryBackup, loadLibrary, parseLibraryBackup, saveLibrary } from '../src/storage.js';
import { getCoverCandidates } from '../src/steam.js';
import { applyManualOrder, queryLibrary } from '../src/domain.js';

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test('existing library needs no cover fields or storage rewrite to use automatic artwork', () => {
  const game = { id: 'steam_4064510', appId: '4064510', name: 'MOLE', genres: ['解谜', '探索向'],
    cardTheme: '探索向', rating: 9.5, review: '保留原来的评论', addedAt: 1700000000000 };
  const raw = JSON.stringify({ version: 2, games: [game] });
  const storage = createStorage({ [STORAGE_KEY]: raw });
  const loaded = loadLibrary([], storage);
  assert.deepEqual(loaded.games, [{ ...game, tier: 'UR' }]);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  const candidates = getCoverCandidates(loaded.games[0].appId);
  assert.equal(candidates[0], '/api/steam/covers/4064510?variant=auto');
  assert.ok(candidates.includes('https://cdn.cloudflare.steamstatic.com/steam/apps/4064510/header.jpg'));
  assert.deepEqual(parseLibraryBackup(createLibraryBackup(loaded.games)), [{ ...game, tier: 'UR' }]);
});

test('saveLibrary writes a versioned envelope', () => {
  const storage = createStorage();
  saveLibrary([{ id: 'a', name: 'A' }], storage);
  const payload = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(payload.version, 3);
  assert.equal(payload.games[0].name, 'A');
});

test('manual order survives save, reload, export and import', () => {
  const storage = createStorage();
  const ordered = applyManualOrder([
    { id: 'a', name: 'A', tier: 'UR', rating: 9.8 },
    { id: 'b', name: 'B', tier: 'SR' },
  ], ['b', 'a']);
  saveLibrary(ordered, storage);
  const restored = parseLibraryBackup(createLibraryBackup(loadLibrary([], storage).games));
  assert.deepEqual(queryLibrary(restored).map((g) => g.id), ['b', 'a']);
  assert.equal(restored.find((g) => g.id === 'a').rating, 9.8);
});

test('loadLibrary migrates the v3 array without changing its rating scale', () => {
  const storage = createStorage({ steam_game_library_v3: JSON.stringify([{ id: 'a', name: 'A', rating: 4 }]) });
  const loaded = loadLibrary([], storage);
  assert.equal(loaded.games[0].rating, 4);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test('loadLibrary converts v2 five-point tiers but retains the original numeric value', () => {
  const storage = createStorage({ steam_game_library_v2: JSON.stringify([{ id: 'a', name: 'A', rating: 4 }]) });
  const game = loadLibrary([], storage).games[0];
  assert.equal(game.rating, 4);
  assert.equal(game.tier, 'SR');
});

test('changing tiers and editing preserves old scores in storage and exported backups, without inventing new scores', () => {
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify({ version: 2, games: [
    { id: 'old', appId: '10', name: 'Old', rating: 9.75, review: 'Original', addedAt: 100 },
  ] }) });
  const old = loadLibrary([], storage).games[0];
  saveLibrary([{ ...old, tier: 'N', review: 'Edited' }, { id: 'new', name: 'New', tier: 'UR' }], storage);
  const roundTrip = parseLibraryBackup(createLibraryBackup(loadLibrary([], storage).games));
  assert.equal(roundTrip[0].rating, 9.75);
  assert.equal(roundTrip[0].tier, 'N');
  assert.equal(roundTrip[0].review, 'Edited');
  assert.equal(Object.hasOwn(roundTrip[1], 'rating'), false);
  saveLibrary([{ ...roundTrip[0], tier: '' }], storage);
  assert.equal(loadLibrary([], storage).games[0].tier, '');
  assert.equal(loadLibrary([], storage).games[0].rating, 9.75);
});

test('backup parser accepts both legacy arrays and versioned exports', () => {
  const legacy = parseLibraryBackup(JSON.stringify([{ id: 'a', name: 'A' }]));
  const versioned = parseLibraryBackup(createLibraryBackup([{ id: 'b', name: 'B' }]));
  assert.equal(legacy[0].name, 'A');
  assert.equal(versioned[0].name, 'B');
});

test('old single genres migrate and multiple genres and chosen theme survive save and export', () => {
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, games: [
    { id: 'old', name: 'Old', genre: 'Roguelike', rating: 9.4 },
  ] }) });
  const old = loadLibrary([], storage).games[0];
  assert.deepEqual(old.genres, ['肉鸽']);
  assert.equal(old.cardTheme, '肉鸽');
  assert.equal(old.rating, 9.4);
  const games = saveLibrary([{ ...old, genres: ['解谜', '探索向'], cardTheme: '探索向' }], storage);
  assert.deepEqual(loadLibrary([], storage).games, games);
  assert.deepEqual(parseLibraryBackup(createLibraryBackup(games)), games);
});
