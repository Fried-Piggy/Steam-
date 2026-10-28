import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSharp } from './image-runtime.mjs';
import { extractCoverPalette } from '../src/cover-palette.js';
import { createCoverProxy } from '../services/cover-proxy.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BACKUPS = path.join(ROOT, 'data', 'backups');
const PRIVATE_COVERS = path.join(ROOT, 'data', 'covers');
const PUBLIC_COVERS = path.join(ROOT, 'assets', 'covers');
const PUBLIC_LIBRARY = path.join(ROOT, 'data', 'default-library.json');
const sharp = loadSharp();
const getCover = createCoverProxy(undefined, { cacheDirectory: PRIVATE_COVERS });

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

await mkdir(PUBLIC_COVERS, { recursive: true });

const cachedCovers = await readdir(PRIVATE_COVERS).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
let copied = 0;
let originalBytes = 0;
let mobileBytes = 0;
const manifest = {};
for (const game of backup.games) {
  const appId = String(game.appId ?? '');
  if (!/^\d{1,10}$/.test(appId)) continue;
  let filename = cachedCovers.find((name) => new RegExp(`^${appId}-auto\\.(jpg|png|webp)$`).test(name));
  if (!filename) {
    // A newly added game may not have finished the background cache before publishing.
    try {
      await getCover(appId, 'auto');
      filename = (await readdir(PRIVATE_COVERS)).find((name) => new RegExp(`^${appId}-auto\\.(jpg|png|webp)$`).test(name));
    } catch {
      console.warn(`游戏 ${appId} 暂无可用封面，公开页面将尝试 Steam CDN。`);
    }
  }
  if (!filename) continue;
  const input = await readFile(path.join(PRIVATE_COVERS, filename));
  const revision = createHash('sha256').update(input).digest('hex').slice(0, 12);
  const small = `${appId}-${revision}-320.webp`;
  const large = `${appId}-${revision}-460.webp`;
  const smallImage = await sharp(input).resize({ width: 320, withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
  const largeImage = await sharp(input).resize({ width: 460, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const pixels = await sharp(input).resize(48, 48, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  manifest[appId] = { small, large, palette: extractCoverPalette(pixels) };
  await writeFile(path.join(PUBLIC_COVERS, small), smallImage);
  await writeFile(path.join(PUBLIC_COVERS, large), largeImage);
  await copyFile(path.join(PRIVATE_COVERS, filename), path.join(PUBLIC_COVERS, filename));
  originalBytes += input.length;
  mobileBytes += smallImage.length;
  copied += 1;
}

await writeFile(path.join(PUBLIC_COVERS, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
await writeFile(PUBLIC_LIBRARY, `${JSON.stringify(backup.games, null, 2)}\n`, 'utf8');

console.log(`公开数据已同步：${backup.games.length} 款游戏，${copied} 张封面。`);
console.log(`来源：${path.relative(ROOT, backupFile)}`);
console.log(`手机封面：${Math.round(originalBytes / 1024)} KB → ${Math.round(mobileBytes / 1024)} KB，减少 ${Math.round((1 - mobileBytes / originalBytes) * 100)}%。配色已自动生成。`);
