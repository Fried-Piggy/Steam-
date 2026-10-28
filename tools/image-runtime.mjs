import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Reuse the installed image runtime; never download packages during a publish.
export function loadSharp() {
  for (const location of ['sharp', path.join(homedir(), '.cache', 'codex-runtimes',
    'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'sharp')]) {
    try { return require(location); } catch { /* Try the next existing runtime. */ }
  }
  throw new Error('封面处理需要 sharp；请在项目中安装 sharp 后再发布。');
}
