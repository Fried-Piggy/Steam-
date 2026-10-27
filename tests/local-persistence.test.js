import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { createLibraryBackupStore } from '../services/library-backup.mjs';
import { createCoverProxy } from '../services/cover-proxy.mjs';
import { createLocalBackup } from '../src/local-backup.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'steam-library-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const edge = '11111111-1111-4111-8111-111111111111';
const preview = '22222222-2222-4222-8222-222222222222';
const game = { id: 'big-walk', name: 'Big Walk', appId: '', rating: 9.4,
  genres: ['多人合作', '探索向'], cardTheme: '探索向', review: '原来的评论', addedAt: 123456789 };

test('disk backups survive restart, preserve full records, isolate browsers and retain deletion history', async (t) => {
  const directory = await temporary(t);
  const save = createLibraryBackupStore(directory);
  await save({ clientId: edge, games: [game] });
  await save({ clientId: preview, games: [] });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, edge, 'latest.json'))).games, [game]);
  const restarted = createLibraryBackupStore(directory);
  assert.equal((await restarted({ clientId: edge, games: [game] })).unchanged, true);
  assert.equal((await readdir(path.join(directory, edge))).length, 2, 'unchanged visits do not add snapshots');
  await restarted({ clientId: edge, games: [] });
  const files = await readdir(path.join(directory, edge));
  assert.equal(files.length, 3);
  const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, edge, file)))));
  assert.ok(records.some((record) => record.games[0]?.name === 'Big Walk'), 'old collection remains recoverable');
  assert.throws(() => save({ clientId: '../outside', games: [game] }), TypeError);
});

test('backup endpoint writes locally and refuses cross-site writes or public access to saved files', async (t) => {
  const directory = await temporary(t);
  const server = createAppServer({ dataDirectory: directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ clientId: edge, games: [game] }) };
  assert.equal((await fetch(`${base}/api/library/backups`, options)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'backups', edge, 'latest.json'))).games, [game]);
  assert.equal((await fetch(`${base}/api/library/backups`, { ...options,
    headers: { ...options.headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/data/backups/${edge}/latest.json`)).status, 404);
});

test('MOLE cover saved from verified hashed URL still loads with all network access disabled after restart', async (t) => {
  const directory = await temporary(t);
  const bytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
  const getCover = createCoverProxy(async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }),
    { cacheDirectory: directory });
  await getCover.prime('4064510', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4064510/60fb8a75026cf12766973a335f00dc360b30b61b/header.jpg');
  assert.deepEqual(new Uint8Array(await readFile(path.join(directory, '4064510-auto.jpg'))), bytes);
  let calls = 0;
  const restarted = createCoverProxy(async () => { calls += 1; throw new Error('offline'); }, { cacheDirectory: directory });
  assert.deepEqual(new Uint8Array((await restarted('4064510', 'auto')).body), bytes);
  assert.equal(calls, 0);
  await assert.rejects(() => getCover.prime('4064510', 'http://127.0.0.1/private'), TypeError);
});

test('automatic downloads write artwork to disk for offline reuse', async (t) => {
  const directory = await temporary(t);
  const getCover = createCoverProxy(async (url) => url.includes('/api/appdetails?')
    ? Response.json({ 10: { success: false } })
    : new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }),
  { cacheDirectory: directory });
  await getCover('10', 'auto');
  assert.equal((await readFile(path.join(directory, '10-auto.jpg'))).length, 3);
});

test('browser backups retry after failure and coalesce edits without losing the newest snapshot', async (t) => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let fail = true;
  const received = [];
  const statuses = [];
  let backup;
  backup = createLocalBackup({ storage, retryMs: 100000, onStatus: (status) => statuses.push(status),
    fetcher: async (_url, options) => {
      if (fail) throw new Error('server offline');
      received.push(JSON.parse(options.body));
      if (received.length === 1) backup.save([{ ...game, rating: 10 }]);
      return Response.json({ count: 1, savedAt: new Date().toISOString() });
    } });
  t.after(() => backup.dispose());
  backup.save([game]);
  await backup.flush();
  assert.equal(statuses.at(-1), 'error');
  fail = false;
  await backup.flush();
  await backup.flush();
  assert.equal(received.length, 2);
  assert.equal(received[0].clientId, received[1].clientId);
  assert.equal(received[1].games[0].rating, 10);
  assert.equal(statuses.at(-1), 'saved');
  backup.save([{ ...game, rating: 10 }]);
  await backup.flush();
  assert.equal(received.length, 2, 'already saved snapshots need not be posted again');
});
