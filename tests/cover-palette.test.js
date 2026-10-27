import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCoverPalette } from '../src/cover-palette.js';

function pixels(...groups) {
  return Uint8ClampedArray.from(groups.flatMap(([rgb, count, alpha = 255]) =>
    Array.from({ length: count }, () => [...rgb, alpha]).flat()));
}

test('red/yellow artwork produces red/yellow foil even on a mostly black/white cover', () => {
  const palette = extractCoverPalette(pixels(
    [[0, 0, 0], 600], [[250, 250, 250], 200], [[205, 28, 20], 120], [[240, 203, 28], 80],
  ));
  assert.ok(palette.primary[0] > palette.primary[1] * 2, 'dominant red stays red');
  assert.ok(palette.secondary[0] > 200 && palette.secondary[1] > 170 && palette.secondary[2] < 130,
    'yellow stays a warm accent rather than an unrelated rainbow hue');
  assert.ok(palette.highlight[0] > palette.highlight[2], 'specular reflection is warm');
});

test('blue/cyan artwork creates a distinct cool palette', () => {
  const palette = extractCoverPalette(pixels([[20, 30, 220], 65], [[20, 220, 205], 35]));
  assert.ok(palette.primary[2] > palette.primary[0] * 2);
  assert.ok(palette.secondary[1] > palette.secondary[0] * 2);
  assert.ok(palette.highlight[2] > palette.highlight[0]);
});

test('monochrome, nearly monochrome, and transparent covers use a silver palette', () => {
  const silver = extractCoverPalette(pixels([[90, 90, 90], 100]));
  assert.deepEqual(extractCoverPalette(pixels([[100, 100, 100], 99], [[255, 0, 0], 1])), silver);
  assert.deepEqual(extractCoverPalette(pixels([[255, 0, 0], 100, 0])), silver);
  assert.deepEqual(extractCoverPalette(new Uint8ClampedArray()), silver);
  assert.ok(Math.max(...silver.primary) - Math.min(...silver.primary) < 30);
});

test('single-color artwork gets a lighter accent in the same hue family', () => {
  const palette = extractCoverPalette(pixels([[30, 150, 55], 100]));
  assert.ok(palette.primary[1] > palette.primary[0] && palette.primary[1] > palette.primary[2]);
  assert.ok(palette.secondary[1] > palette.secondary[0] && palette.secondary[1] > palette.secondary[2]);
  assert.ok(palette.secondary.reduce((a, b) => a + b) > palette.primary.reduce((a, b) => a + b));
});

test('cached palettes apply without fetching and never recolor detached cards', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const palette = { primary: [220, 40, 30], secondary: [240, 210, 40], highlight: [250, 220, 190] };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => JSON.stringify([['10:0', { at: Date.now(), palette }]]),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  const { applyCoverPalette } = await import('../src/cover-palette.js?cached');
  const values = new Map();
  const card = { isConnected: true, dataset: {}, style: { setProperty: (key, value) => values.set(key, value) } };
  await applyCoverPalette(card, '10');
  assert.equal(values.get('--foil-primary'), 'rgb(220, 40, 30)');
  assert.equal(values.get('--foil-glow'), '250 220 190');
  assert.equal(card.dataset.foilSource, 'cover');
  values.clear();
  card.isConnected = false;
  await applyCoverPalette(card, '10');
  assert.equal(values.size, 0);
});
