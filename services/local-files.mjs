import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Readers see either the complete old file or the complete new file.
export async function writeAtomic(file, body) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { flag: 'wx' });
  await rename(temporary, file);
}
