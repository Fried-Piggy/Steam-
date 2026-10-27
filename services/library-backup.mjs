import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeAtomic } from './local-files.mjs';

export function createLibraryBackupStore(directory) {
  const pending = new Map();

  async function save(clientId, payload) {
    const folder = path.join(directory, clientId);
    const latestPath = path.join(folder, 'latest.json');
    const digest = createHash('sha256').update(JSON.stringify(payload.games)).digest('hex');
    let previous;
    try { previous = JSON.parse(await readFile(latestPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (previous?.digest === digest) {
      return { savedAt: previous.savedAt, count: previous.games.length, unchanged: true };
    }
    const savedAt = new Date().toISOString();
    const backup = { version: 3, savedAt, clientId, digest, games: payload.games };
    const body = JSON.stringify(backup, null, 2);
    await mkdir(folder, { recursive: true });
    // Keep every changed snapshot, including the version before a deletion/import.
    const filename = `steam-library-${savedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
    await writeFile(path.join(folder, filename), body, { flag: 'wx' });
    await writeAtomic(latestPath, body);
    return { savedAt, count: backup.games.length, unchanged: false };
  }

  return function saveBackup(payload) {
    const clientId = payload?.clientId;
    if (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId)
      || !Array.isArray(payload.games) || payload.games.length > 20000
      || payload.games.some((game) => !game || typeof game !== 'object' || Array.isArray(game)
        || typeof game.name !== 'string' || typeof game.id !== 'string')) {
      throw new TypeError('游戏库备份格式无效');
    }
    // Serialize writes from multiple tabs sharing this browser's storage.
    const task = (pending.get(clientId) ?? Promise.resolve()).catch(() => {}).then(() => save(clientId, payload));
    pending.set(clientId, task);
    const cleanup = () => { if (pending.get(clientId) === task) pending.delete(clientId); };
    task.then(cleanup, cleanup);
    return task;
  };
}
