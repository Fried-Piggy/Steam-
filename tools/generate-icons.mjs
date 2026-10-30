import { fileURLToPath } from 'node:url';
import { loadSharp } from './image-runtime.mjs';

// Keep PNG fallbacks in sync with the editable SVG, using the existing image runtime.
const sharp = loadSharp();
const iconPath = (name) => fileURLToPath(new URL(`../assets/icons/${name}`, import.meta.url));
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
  await sharp(iconPath('favicon.svg')).resize(size, size).png().toFile(iconPath(name));
  console.log(`Generated ${name} (${size}×${size})`);
}
