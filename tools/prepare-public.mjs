import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BACKUPS = path.join(ROOT, 'data', 'backups');
const PRIVATE_COVERS = path.join(ROOT, 'data', 'covers');
const PUBLIC_COVERS = path.join(ROOT, 'assets', 'covers');
const PUBLIC_LIBRARY = path.join(ROOT, 'data', 'default-library.json');

async function findLatestBackup() {
  const candidates = [];
  for (const entry of await readdir(BACKUPS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(BACKUPS, entry.name, 'latest.json');
    try {
      const details = await stat(file);
      candidates.push({ file, modifiedAt: details.mtimeMs });
    } catch { /* A client directory may not have completed its first save. */ }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!candidates[0]) throw new Error('没有找到 data/backups/*/latest.json');
  return candidates[0].file;
}

const backupFile = await findLatestBackup();
const backup = JSON.parse(await readFile(backupFile, 'utf8'));
if (!Array.isArray(backup.games)) throw new TypeError('最新备份不包含有效的 games 数组');

await writeFile(PUBLIC_LIBRARY, `${JSON.stringify(backup.games, null, 2)}\n`, 'utf8');
await mkdir(PUBLIC_COVERS, { recursive: true });

const cachedCovers = await readdir(PRIVATE_COVERS);
let copied = 0;
for (const game of backup.games) {
  const appId = String(game.appId ?? '');
  if (!/^\d{1,10}$/.test(appId)) continue;
  const filename = cachedCovers.find((name) => name.startsWith(`${appId}-auto.`));
  if (!filename) continue;
  await copyFile(path.join(PRIVATE_COVERS, filename), path.join(PUBLIC_COVERS, filename));
  copied += 1;
}

console.log(`公开数据已同步：${backup.games.length} 款游戏，${copied} 张封面。`);
console.log(`来源：${path.relative(ROOT, backupFile)}`);
